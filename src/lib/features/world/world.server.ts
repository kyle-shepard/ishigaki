import { and, asc, eq, inArray, isNull, lte, notInArray, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import {
	building,
	buildingCost,
	buildingType,
	character,
	gameConfig,
	operation,
	player,
	profession,
	professionSkill,
	resource,
	settlement,
	skill,
	stock,
	terrainType,
	tile,
	tileStock
} from '$lib/server/db/schema';
import {
	accrue,
	eligibleTypeIds,
	GRID_SIZE,
	pickName,
	population,
	rollStats,
	skillValue,
	travelSeconds,
	type OrderReason,
	type WorldPayload
} from './world';

// Where a new sandbox starts. Every player gets the same coordinates because they never
// see each other (VISION #4 interim override) — the hamlet, the barn beside it, and a builder.
const START = {
	hamletX: 7,
	hamletY: 8,
	// A second House beside the hamlet — a new realm opens with room for eight, so settlers
	// arrive before the first build. Its own tile so the two Houses don't stack into one pawn.
	house2X: 6,
	house2Y: 8,
	barnX: 8,
	barnY: 8,
	characterX: 7,
	characterY: 9,
	speed: 0.5
};

// How many people a realm starts with. An explicit placeholder for real population growth
// (the People epic). One would mean every build order cancels your only gatherer.
const STARTING_CHARACTERS = 3;

// How long training takes once the settler reaches the School, in seconds. ponytail: a module
// constant, not game_config — training time isn't an economy knob a live world is balanced on
// the way growth/food rates are. Move it to game_config if that changes.
const TRAIN_SECONDS = 30;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type PlayerSession = {
	playerId: number;
	/** True when the caller arrived holding a realm that no longer exists — see below. */
	worldReset: boolean;
};

/**
 * Resolves the caller's sandbox, creating one on first visit. Returns the id to store in
 * the cookie.
 *
 * `id` is whatever the cookie claimed, and is not trusted: it can name a player who is gone.
 * That case used to be papered over — a returning visitor was handed a brand-new realm with
 * no acknowledgement that their old one had been destroyed. It is reported now instead.
 *
 * **This is how a save-breaking change announces itself.** There is no schema-version column
 * and no compatibility matrix: when a migration genuinely cannot carry realms forward, it
 * deletes the player rows, and every affected visitor lands here and gets told. A deploy that
 * preserves saves touches nothing and nobody sees a thing.
 *
 * ponytail: anyone holding a cookie can act as that player. There is no auth here at all;
 * guessing another integer is the whole attack. That is acceptable while the world is
 * disposable, and is what the accounts epic (VISION #10) replaces.
 */
export async function ensurePlayer(id: number | null): Promise<PlayerSession> {
	if (id !== null) {
		// A usable realm is a player that still has a *settlement*, not merely a player row.
		// resolveWorld opens by locking the settlement and dereferences it (home.id), so a
		// player without one 500s on every read. App code never creates that state — player and
		// settlement are made and destroyed together — but a save-breaking DB change can: the
		// intended path deletes the player rows (see below), yet a partial rebuild that drops
		// settlements while leaving players behind would strand every affected cookie in an
		// unrecoverable retry loop. Checking the settlement here routes those cookies down the
		// same mint-a-fresh-world-and-say-so path as a fully deleted realm.
		const [home] = await db
			.select({ id: settlement.id })
			.from(settlement)
			.where(eq(settlement.playerId, id));
		if (home) return { playerId: id, worldReset: false };
	}

	const playerId = await db.transaction(async (tx) => {
		// The building catalog is global and seeded, not per-player. Without it there is no
		// hamlet to hand out, which is a broken deploy rather than a new-player problem.
		// Looked up by name, not by `limit(1)`: there is more than one type now, and an
		// unordered pick would eventually hand somebody a barn to live in.
		const catalog = new Map((await tx.select().from(buildingType)).map((t) => [t.displayName, t]));
		const house = catalog.get('House');
		const barn = catalog.get('Barn');
		if (!house || !barn)
			throw new Error(
				'no House/Barn building_type rows — run `npm run seed` against this database'
			);

		const resources = await tx.select().from(resource);
		if (resources.length === 0)
			throw new Error('no resource rows — run `npm run seed` against this database');

		const [p] = await tx.insert(player).values({}).returning();
		const [s] = await tx
			.insert(settlement)
			.values({ playerId: p.id, x: START.hamletX, y: START.hamletY })
			.returning();
		// A row per resource, present from the start rather than created on first gain: the
		// accrual and the deduction are then both an UPDATE that either matches a row or does
		// not, with no upsert and no "is this new or merely empty" question at the till.
		// Seeded to each resource's startingStock (mostly zero) — a small runway so a new hamlet
		// can eat and afford a first House before Food starts draining, without which a realm
		// born at nothing would starve the moment growth lands (People epic, Slice 4).
		await tx
			.insert(stock)
			.values(
				resources.map((r) => ({ settlementId: s.id, resourceId: r.id, quantity: r.startingStock }))
			);
		await tx.insert(building).values([
			{ playerId: p.id, x: START.hamletX, y: START.hamletY, buildingTypeId: house.id },
			// A second House, so a fresh realm's housing cap is eight and people keep arriving.
			{ playerId: p.id, x: START.house2X, y: START.house2Y, buildingTypeId: house.id },
			// The barn stores nothing yet and gates nothing — with no capacity there is nothing
			// for it to read. It is here so "where your stock lives" is a place on the map, and
			// it is the row capacity will hang off when it arrives.
			{ playerId: p.id, x: START.barnX, y: START.barnY, buildingTypeId: barn.id }
		]);
		// Side by side along the row below the hamlet, so three pawns don't stack into one.
		await tx.insert(character).values(
			Array.from({ length: STARTING_CHARACTERS }, (_, i) => ({
				playerId: p.id,
				x: START.characterX + i - 1,
				y: START.characterY,
				speed: START.speed
			}))
		);
		return p.id;
	});

	// No cookie at all is a first visit. A cookie naming a player who is gone is a realm that
	// was destroyed — the same thing from the database's side, a very different thing to say.
	return { playerId, worldReset: id !== null };
}

/**
 * Throws the caller's realm away. Deliberately does *not* mint the replacement: the route
 * clears the cookie instead, so the next request looks exactly like a first visit and runs
 * through `ensurePlayer`'s create path. One world-creation path, and a restart the player
 * asked for never reports itself as a world they lost.
 */
export async function deletePlayer(playerId: number): Promise<void> {
	await db.transaction(async (tx) => {
		// Children first — the FKs have no ON DELETE CASCADE, and that is the safer default
		// for rows a player spent real time on.
		await tx.delete(operation).where(eq(operation.playerId, playerId));
		await tx.delete(building).where(eq(building.playerId, playerId));
		await tx.delete(character).where(eq(character.playerId, playerId));
		await tx
			.delete(stock)
			.where(
				inArray(
					stock.settlementId,
					tx.select({ id: settlement.id }).from(settlement).where(eq(settlement.playerId, playerId))
				)
			);
		await tx.delete(tileStock).where(eq(tileStock.playerId, playerId));
		await tx.delete(settlement).where(eq(settlement.playerId, playerId));
		await tx.delete(player).where(eq(player.id, playerId));
	});
}

export async function loadWorld(playerId: number): Promise<WorldPayload> {
	return db.transaction(async (tx) => {
		await resolveWorld(tx, playerId);
		return readWorld(tx, playerId);
	});
}

/**
 * The single seam where the stored world catches up to now. Reads run through it, so a GET
 * performs writes and what is stored always reflects reality — nothing is computed in memory
 * and thrown away.
 *
 * Two jobs, because there are two kinds of operation. A build is edge-triggered: it is due
 * or it isn't. A gather is continuous, and is integrated from the time elapsed since it was
 * last paid out. Neither is a tick — nothing here runs unless somebody looks.
 *
 * ponytail: the settlement row is a per-player lock — coarse, and taken on reads as well as
 * writes. Narrow it when a settlement has more than one owner.
 */
export async function resolveWorld(tx: Tx, playerId: number): Promise<void> {
	// Every read-modify-write for this player queues behind this one row. It cannot be the
	// `FOR UPDATE` below instead: that one used to name only operations already due, so with
	// nothing due it locked nothing and two orders placed at the same moment would both read
	// the same stock and both spend it.
	const [home] = await tx
		.select({
			id: settlement.id,
			x: settlement.x,
			y: settlement.y,
			populationAsOf: settlement.populationAsOf,
			populationAccrued: settlement.populationAccrued
		})
		.from(settlement)
		.where(eq(settlement.playerId, playerId))
		.for('update');

	// Postgres freezes `now()` at the start of the transaction, so this instant is the same
	// one the SQL below stamps with. Reading it into JS and writing `now()` back cannot drift
	// apart and double-count a sliver of work.
	const [{ now }] = await tx.execute<{ now: Date }>(sql`select now() as now`);
	const nowMs = new Date(now).getTime();

	// Every in-progress operation, not just the ones past their completion time: a gather has
	// no completion time at all and would never be selected by that predicate.
	const active = await tx
		.select()
		.from(operation)
		.where(and(eq(operation.playerId, playerId), eq(operation.status, 'in-progress')))
		.for('update');

	const gathers = active.filter((op) => op.type === 'gather');
	// One catalog read, and only when somebody is actually working.
	const yields = gathers.length ? await tileYields(tx) : new Map();
	// What this player has already drawn down. Only tiles they have actually worked have rows.
	const drawn = gathers.length
		? new Map(
				(await tx.select().from(tileStock).where(eq(tileStock.playerId, playerId))).map((r) => [
					r.y * GRID_SIZE + r.x,
					r
				])
			)
		: new Map();

	for (const op of active) {
		if (op.type === 'gather') {
			const key = op.destY * GRID_SIZE + op.destX;
			const yielded = yields.get(key);
			// A tile whose terrain stopped yielding under a standing worker. Refusing at the
			// writer means this shouldn't happen; paying nothing is the safe reading if it does.
			if (!yielded) continue;

			// No row means untouched, and untouched means full. Two workers on one tile need no
			// special case: they resolve in id order, and the second finds whatever the first
			// left — including nothing.
			const held = drawn.get(key);
			const finite =
				yielded.regrowSeconds !== null && yielded.capacity !== null
					? {
							quantity: held ? held.quantity : yielded.capacity,
							capacity: yielded.capacity,
							regrowSeconds: yielded.regrowSeconds,
							agedSeconds: held ? (nowMs - held.asOf.getTime()) / 1000 : 0
						}
					: null;
			// The flat rate scaled by who is working it — a matched specialist takes more per hour
			// than an untrained settler. The multiplier was snapshotted at assignment.
			const { harvested, quantity } = accrue(
				yielded.unitsPerHour * op.qualityMultiplier,
				(nowMs - op.accruedAt!.getTime()) / 1000,
				finite
			);
			// Still walking, or read twice in the same instant. Leaving `accrued_at` alone is
			// what keeps travel time from being quietly credited as work.
			if (harvested <= 0) continue;

			await tx
				.update(stock)
				.set({ quantity: sql`${stock.quantity} + ${harvested}` })
				.where(and(eq(stock.settlementId, home.id), eq(stock.resourceId, yielded.resourceId)));
			if (quantity !== null) {
				await tx
					.insert(tileStock)
					.values({ playerId, x: op.destX, y: op.destY, quantity, asOf: sql`now()` })
					.onConflictDoUpdate({
						target: [tileStock.playerId, tileStock.x, tileStock.y],
						set: { quantity, asOf: sql`now()` }
					});
				// So a second worker on the same tile this pass sees what the first one left.
				drawn.set(key, { playerId, x: op.destX, y: op.destY, quantity, asOf: new Date(nowMs) });
			}
			await tx
				.update(operation)
				.set({ accruedAt: sql`now()` })
				.where(eq(operation.id, op.id));
			continue;
		}

		// Build and train are both edge-triggered — due or not.
		if (op.completeAt!.getTime() > nowMs) continue;
		await tx.update(operation).set({ status: 'completed' }).where(eq(operation.id, op.id));

		if (op.type === 'train') {
			// The settler becomes a named specialist of the trained profession, standing at the
			// School. Stats are rolled and a name picked here — the one place Math.random enters,
			// funnelled through the pure, tested rollStats/pickName. Names avoid collision with
			// this player's existing specialists (re-read each completion, so two trainings landing
			// in one pass don't both grab the same name).
			const named = await tx
				.select({ name: character.name })
				.from(character)
				.where(and(eq(character.playerId, playerId), sql`${character.name} IS NOT NULL`));
			const stats = rollStats(Math.random);
			await tx
				.update(character)
				.set({
					professionId: op.professionId,
					name: pickName(Math.random, new Set(named.map((n) => n.name!))),
					strength: stats.strength,
					dexterity: stats.dexterity,
					constitution: stats.constitution,
					intelligence: stats.intelligence,
					x: op.destX,
					y: op.destY
				})
				.where(eq(character.id, op.characterId));
			continue;
		}

		await tx.insert(building).values({
			playerId,
			x: op.destX,
			y: op.destY,
			buildingTypeId: op.buildingTypeId!
		});
		await tx
			.update(character)
			.set({ x: op.destX, y: op.destY })
			.where(eq(character.id, op.characterId));
	}

	// Population and food, integrated from the settlement's own anchor — the same integrate-on-read
	// shape as the gather accrual above, no tick. Ordering is load-bearing: this runs AFTER the
	// operations loop, so it reads a Food stock already credited with this pass's foraging. A
	// hamlet with an active forager is fed from that forage rather than starved past it.
	//
	// ponytail: gather and population integrate from different anchors (accrued_at vs
	// population_as_of), so a sub-interval where a forager arrives partway is approximate; at read
	// cadence it's close, and seeding food_per_capita below a single forager's yield keeps the
	// common case correct. Split the interval at each event if starvation ever feels wrong.
	const [cfg] = await tx.select().from(gameConfig);
	if (cfg) {
		const [{ pop }] = await tx
			.select({ pop: sql<number>`count(*)::int` })
			.from(character)
			.where(eq(character.playerId, playerId));
		const [{ cap }] = await tx
			.select({ cap: sql<number>`coalesce(sum(${buildingType.housingCapacity}), 0)::int` })
			.from(building)
			.innerJoin(buildingType, eq(building.buildingTypeId, buildingType.id))
			.where(eq(building.playerId, playerId));
		// The one sustenance resource's stock for this settlement — keyed on the flag, never on a
		// display name (VISION #10). No row (a realm predating the resource) reads as zero food.
		const [food] = await tx
			.select({ resourceId: stock.resourceId, quantity: stock.quantity })
			.from(stock)
			.innerJoin(resource, eq(stock.resourceId, resource.id))
			.where(and(eq(stock.settlementId, home.id), eq(resource.isSustenance, true)));

		const { born, died, foodDrained, accrued } = population(
			pop,
			cap,
			food?.quantity ?? 0,
			home.populationAccrued,
			cfg,
			(nowMs - home.populationAsOf.getTime()) / 1000
		);

		if (food && foodDrained > 0)
			await tx
				.update(stock)
				.set({ quantity: sql`${stock.quantity} - ${foodDrained}` })
				.where(and(eq(stock.settlementId, home.id), eq(stock.resourceId, food.resourceId)));
		if (born > 0)
			await tx.insert(character).values(
				Array.from({ length: born }, () => ({
					playerId,
					x: home.x,
					y: home.y,
					speed: START.speed
				}))
			);
		if (died > 0) await removeSettlers(tx, playerId, died);

		// The anchor now advances fully to now every read (food must drain smoothly with the
		// clock); the sub-person remainder rides in populationAccrued instead.
		await tx
			.update(settlement)
			.set({ populationAsOf: sql`now()`, populationAccrued: accrued })
			.where(eq(settlement.id, home.id));
	}
}

/**
 * Removes `n` settlers to starvation, respecting the operation FK. `operation.character_id` is
 * NOT NULL and has no cascade, so a character with *any* operation row — in-progress or long
 * completed — cannot be deleted until those rows are gone (this is why `deletePlayer` deletes
 * operations first). Idle settlers go before working ones, so an active gather or build is only
 * cut short when the hungry tail truly demands it; the chosen bodies' operations are deleted,
 * then the bodies.
 *
 * ponytail: everyone is a settler this epic, so "idle before working" is the whole ordering.
 * Slice 5 adds specialists — extend the sort key to take settlers before specialists too.
 */
async function removeSettlers(tx: Tx, playerId: number, n: number): Promise<void> {
	if (n <= 0) return;
	const busy = new Set(
		(
			await tx
				.select({ id: operation.characterId })
				.from(operation)
				.where(and(eq(operation.playerId, playerId), eq(operation.status, 'in-progress')))
		).map((r) => r.id)
	);
	const all = await tx
		.select({ id: character.id })
		.from(character)
		.where(eq(character.playerId, playerId));
	// Idle (not in an in-progress op) first, then working — take the first n.
	const victims = all
		.sort((a, b) => Number(busy.has(a.id)) - Number(busy.has(b.id)))
		.slice(0, n)
		.map((c) => c.id);
	if (victims.length === 0) return;
	// FK: every operation referencing a culled character must go before the character does.
	await tx.delete(operation).where(inArray(operation.characterId, victims));
	await tx.delete(character).where(inArray(character.id, victims));
}

type TileYield = {
	resourceId: number;
	unitsPerHour: number;
	/** Which action-skill takes this — how a gather ranks workers. Null if the resource is unwired. */
	skillId: number | null;
	/** Null is gathered — a person is enough. Set means the structure comes first. */
	requiresBuildingTypeId: number | null;
	/** Both null together where the deposit is infinite — the seed holds that invariant. */
	capacity: number | null;
	regrowSeconds: number | null;
};

/** What each tile yields, how fast, and how much of it there is, keyed row-major. */
async function tileYields(tx: Tx): Promise<Map<number, TileYield>> {
	const rows = await tx
		.select({
			x: tile.x,
			y: tile.y,
			resourceId: resource.id,
			unitsPerHour: resource.unitsPerHour,
			skillId: resource.skillId,
			requiresBuildingTypeId: resource.requiresBuildingTypeId,
			capacity: tile.quantity,
			regrowSeconds: terrainType.regrowSeconds
		})
		.from(tile)
		.innerJoin(terrainType, eq(tile.terrainTypeId, terrainType.id))
		.innerJoin(resource, eq(terrainType.yieldsResourceId, resource.id));
	return new Map(rows.map((r) => [r.y * GRID_SIZE + r.x, r]));
}

type BestWorker = { character: typeof character.$inferSelect; multiplier: number };

/**
 * The idle worker who does `skillId` best, and the quality multiplier they'd bring. This is the
 * "who does the job changes the result" pick: a settler works at the flat baseline, a specialist
 * at their derived skillValue, so auto-assign takes the best-skilled body by default and holding
 * your best one back is a real choice. Returns null when nobody is idle.
 *
 * Derived from the *live* bundle every call (design decision: a profession retune reaches the next
 * job a specialist takes); the caller snapshots only the resulting multiplier onto the operation.
 */
async function pickBestWorker(
	tx: Tx,
	playerId: number,
	skillId: number
): Promise<BestWorker | null> {
	const busy = tx
		.select({ id: operation.characterId })
		.from(operation)
		.where(and(eq(operation.playerId, playerId), eq(operation.status, 'in-progress')));
	const idle = await tx
		.select()
		.from(character)
		.where(and(eq(character.playerId, playerId), notInArray(character.id, busy)));
	if (idle.length === 0) return null;

	const [cfg] = await tx.select().from(gameConfig);
	const config = {
		settlerBaseline: cfg?.settlerBaseline ?? 1,
		skillCurve: cfg?.skillCurve ?? 0
	};
	const [sk] = await tx.select().from(skill).where(eq(skill.id, skillId));
	// profession → its trained value for this skill; absent means the profession doesn't carry it.
	const bundle = new Map(
		(await tx.select().from(professionSkill).where(eq(professionSkill.skillId, skillId))).map(
			(r) => [r.professionId, r.value]
		)
	);
	// The rolled value of a named base stat, or null for a settler (all stats null).
	const statOf = (c: typeof character.$inferSelect, name: string) =>
		name === 'strength'
			? c.strength
			: name === 'dexterity'
				? c.dexterity
				: name === 'constitution'
					? c.constitution
					: c.intelligence;

	let best = idle[0];
	let bestMult = -1;
	for (const c of idle) {
		const bundleValue = c.professionId !== null ? (bundle.get(c.professionId) ?? null) : null;
		const mult = skillValue(bundleValue, statOf(c, sk.statA), statOf(c, sk.statB), config);
		if (mult > bestMult) {
			bestMult = mult;
			best = c;
		}
	}
	return { character: best, multiplier: bestMult };
}

/** The Construction skill's id — the relevant skill for every build. Looked up by its seed name. */
async function constructionSkillId(tx: Tx): Promise<number> {
	const [sk] = await tx
		.select({ id: skill.id })
		.from(skill)
		.where(eq(skill.displayName, 'Construction'));
	if (!sk) throw new Error('no Construction skill row — run `npm run seed` against this database');
	return sk.id;
}

export type OrderResult = { ok: true; world: WorldPayload } | { ok: false; reason: OrderReason };

/**
 * The grid a build order is judged against: what every tile is made of, keyed the same
 * row-major way the wire payload is. One 256-row read serves both the destination's
 * buildability and the cost of every tile the trip crosses — a point query plus a path query
 * would be two reads over the same rows.
 */
async function loadGrid(tx: Tx): Promise<
	Map<
		number,
		{
			buildable: boolean;
			isDeposit: boolean;
			yieldsResourceId: number | null;
			movementCost: number;
		}
	>
> {
	const rows = await tx
		.select({
			x: tile.x,
			y: tile.y,
			buildable: terrainType.buildable,
			isDeposit: terrainType.isDeposit,
			yieldsResourceId: terrainType.yieldsResourceId,
			movementCost: terrainType.movementCost
		})
		.from(tile)
		.innerJoin(terrainType, eq(tile.terrainTypeId, terrainType.id));
	return new Map(
		rows.map((r) => [
			r.y * GRID_SIZE + r.x,
			{
				buildable: r.buildable,
				isDeposit: r.isDeposit,
				yieldsResourceId: r.yieldsResourceId,
				movementCost: r.movementCost
			}
		])
	);
}

/**
 * Rejections come back as a value, not an exception: a try/catch around the handler would
 * map a mid-transaction DB failure onto a 400 the player reads as a game rule. Only an
 * `OrderReason` produces a 400; anything thrown stays thrown.
 */
export async function createBuildOrder(
	playerId: number,
	x: number,
	y: number,
	buildingTypeId: number
): Promise<OrderResult> {
	return db.transaction(async (tx): Promise<OrderResult> => {
		// An order is a read-then-write: without this it could be rejected as NO_IDLE_CHARACTER
		// by an operation that finished ten seconds ago, or judged against stale stock.
		await resolveWorld(tx, playerId);

		if (!Number.isInteger(x) || !Number.isInteger(y)) return { ok: false, reason: 'OUT_OF_BOUNDS' };
		if (x < 0 || y < 0 || x >= GRID_SIZE || y >= GRID_SIZE)
			return { ok: false, reason: 'OUT_OF_BOUNDS' };

		const [type] = await tx.select().from(buildingType).where(eq(buildingType.id, buildingTypeId));
		if (!type) return { ok: false, reason: 'UNKNOWN_BUILDING_TYPE' };

		// Realm-wide prerequisite: a type that names another must have one of that other standing
		// *anywhere* the player owns before it can be placed at all (a Stone wall needs a Quarry).
		// Checked before terrain — "you can't build this yet" outranks "not on this ground".
		if (type.requiresBuildingTypeId !== null) {
			const [owned] = await tx
				.select({ id: building.id })
				.from(building)
				.where(
					and(
						eq(building.playerId, playerId),
						eq(building.buildingTypeId, type.requiresBuildingTypeId)
					)
				)
				.limit(1);
			if (!owned) return { ok: false, reason: 'MISSING_PREREQUISITE' };
		}

		// Ground before what sits on it: bounds and building type ask "is this request
		// coherent", terrain asks "is this place legal", occupancy asks "is this place free".
		const grid = await loadGrid(tx);
		// A hole in the grid is a corrupt world, not a game rule. Falling back to `undefined`
		// would tell the player they can't build there (a DB fault dressed as a rule, which
		// the docstring above forbids) and would feed NaN into the travel time.
		const groundAt = (gx: number, gy: number) => {
			const g = grid.get(gy * GRID_SIZE + gx);
			if (!g) throw new Error(`no tile row at (${gx}, ${gy}) — run \`npm run seed\``);
			return g;
		};
		// The terrain-eligibility rule, authored once in `eligibleTypeIds` and shared with the wire
		// allow-list below. Its empty-set result subsumes the old bare `buildable` check: a House
		// can't squat on an iron vein, a Quarry can't sit on a meadow, and unbuildable ground offers
		// nothing at all. ponytail: reuses TILE_NOT_BUILDABLE rather than a dedicated
		// TILE_WRONG_TERRAIN — a rarely-hit backstop behind the client's greyed menu; the sentence
		// is slightly generous on a deposit but defensible. Upgrade the day it goes user-facing.
		const catalogTypes = await tx.select({ id: buildingType.id }).from(buildingType);
		const catalogResources = await tx
			.select({ id: resource.id, requiresBuildingTypeId: resource.requiresBuildingTypeId })
			.from(resource);
		if (!eligibleTypeIds(groundAt(x, y), catalogTypes, catalogResources).includes(buildingTypeId))
			return { ok: false, reason: 'TILE_NOT_BUILDABLE' };

		// ponytail: occupancy is scoped to the player, so each visitor plays an isolated
		// sandbox on the shared map (VISION #4 interim override). Un-scope both of these —
		// and building_tile_idx — to restore world-global tile ownership.
		const [existing] = await tx
			.select()
			.from(building)
			.where(and(eq(building.playerId, playerId), eq(building.x, x), eq(building.y, y)));
		if (existing) return { ok: false, reason: 'TILE_OCCUPIED' };

		// In-progress builds count as occupancy too, or two orders stack on one tile. Gathers
		// don't: a worker standing on a tile is not a thing built on it, and refusing to build
		// where someone happens to be foraging would be a rule nobody could guess.
		const [pending] = await tx
			.select()
			.from(operation)
			.where(
				and(
					eq(operation.playerId, playerId),
					eq(operation.status, 'in-progress'),
					eq(operation.type, 'build'),
					eq(operation.destX, x),
					eq(operation.destY, y)
				)
			);
		if (pending) return { ok: false, reason: 'TILE_OCCUPIED' };

		// The best builder, not merely the first idle body — a skilled worker builds faster
		// (quality folds into the completion time below). Every build ranks by Construction.
		const pick = await pickBestWorker(tx, playerId, await constructionSkillId(tx));
		if (!pick) return { ok: false, reason: 'NO_IDLE_CHARACTER' };
		const idle = pick.character;

		// Cost comes last, because it is the only check that writes: a refusal on any earlier
		// ground has to leave stock untouched. Deducted at order rather than on completion —
		// there is no cancel path to refund, and a charge that failed at completion would fail
		// silently while the player was away, which is exactly when completion happens.
		const costs = await tx
			.select()
			.from(buildingCost)
			.where(eq(buildingCost.buildingTypeId, buildingTypeId));
		const [home] = await tx.select().from(settlement).where(eq(settlement.playerId, playerId));
		if (!home) throw new Error(`player ${playerId} has no settlement`);
		const held = new Map(
			(await tx.select().from(stock).where(eq(stock.settlementId, home.id))).map((s) => [
				s.resourceId,
				s.quantity
			])
		);
		// Checked in full before anything is spent, so a two-resource cost can't half-pay.
		if (costs.some((c) => (held.get(c.resourceId) ?? 0) < c.quantity))
			return { ok: false, reason: 'INSUFFICIENT_RESOURCES' };
		for (const c of costs) {
			await tx
				.update(stock)
				.set({ quantity: sql`${stock.quantity} - ${c.quantity}` })
				.where(and(eq(stock.settlementId, home.id), eq(stock.resourceId, c.resourceId)));
		}

		// Every timestamp is computed by Postgres in this one statement. Node's clock never
		// stamps anything, so the client's interpolation is exact by construction.
		// The grid loaded for the buildable check is the same one the path is priced against —
		// one read, two uses.
		const travel = travelSeconds(
			idle.x,
			idle.y,
			x,
			y,
			idle.speed,
			(cx, cy) => groundAt(cx, cy).movementCost
		);
		// Build time divides by the worker's quality: a better builder finishes sooner. The
		// multiplier is snapshotted so an in-flight build keeps the pace it started at.
		const buildSeconds = type.buildSeconds / pick.multiplier;
		await tx.insert(operation).values({
			playerId,
			characterId: idle.id,
			type: 'build',
			status: 'in-progress',
			originX: idle.x,
			originY: idle.y,
			destX: x,
			destY: y,
			buildingTypeId,
			qualityMultiplier: pick.multiplier,
			startedAt: sql`now()`,
			travelDoneAt: sql`now() + ${`${travel} seconds`}::interval`,
			completeAt: sql`now() + ${`${travel + buildSeconds} seconds`}::interval`
		});

		return { ok: true, world: await readWorld(tx, playerId) };
	});
}

/**
 * Sends a worker to a tile to take what it yields. Unlike a build, this has no end: the
 * operation runs until it is recalled, which is what a null `complete_at` means.
 */
export async function assignWorker(playerId: number, x: number, y: number): Promise<OrderResult> {
	return db.transaction(async (tx): Promise<OrderResult> => {
		await resolveWorld(tx, playerId);

		if (!Number.isInteger(x) || !Number.isInteger(y)) return { ok: false, reason: 'OUT_OF_BOUNDS' };
		if (x < 0 || y < 0 || x >= GRID_SIZE || y >= GRID_SIZE)
			return { ok: false, reason: 'OUT_OF_BOUNDS' };

		// Refused here, before any row is written, so a tile that yields nothing can never
		// acquire a worker — the invariant holds at the writer rather than by convention.
		// The predicate is "yields something you can actually take", not merely "yields":
		// clay pits and iron veins carry a resource but no rate yet, and a null-check alone
		// would leave a worker standing in one forever, earning nothing, with no feedback.
		const yielded = (await tileYields(tx)).get(y * GRID_SIZE + x);
		if (!yielded || yielded.unitsPerHour <= 0) return { ok: false, reason: 'TILE_YIELDS_NOTHING' };

		// Extracted goods need their structure standing on the tile being worked — stone comes
		// out of a quarry, not out of an outcrop. Gathered ones have no requirement and skip
		// this entirely. Refused here alongside the other two, so every way a tile can turn a
		// worker away happens before a row exists.
		if (yielded.requiresBuildingTypeId !== null) {
			const [structure] = await tx
				.select()
				.from(building)
				.where(
					and(
						eq(building.playerId, playerId),
						eq(building.x, x),
						eq(building.y, y),
						eq(building.buildingTypeId, yielded.requiresBuildingTypeId)
					)
				);
			if (!structure) return { ok: false, reason: 'MISSING_REQUIRED_BUILDING' };
		}

		// The best gatherer for this resource's skill, not merely the first idle body — a matched
		// specialist takes more per hour (the rate scales by this multiplier in resolveWorld).
		// A takeable resource always has a skill wired; fall back to a flat rank if somehow not.
		const pick = yielded.skillId
			? await pickBestWorker(tx, playerId, yielded.skillId)
			: await (async () => {
					const busy = tx
						.select({ id: operation.characterId })
						.from(operation)
						.where(and(eq(operation.playerId, playerId), eq(operation.status, 'in-progress')));
					const [c] = await tx
						.select()
						.from(character)
						.where(and(eq(character.playerId, playerId), notInArray(character.id, busy)))
						.limit(1);
					return c ? { character: c, multiplier: 1 } : null;
				})();
		if (!pick) return { ok: false, reason: 'NO_IDLE_CHARACTER' };
		const idle = pick.character;

		const grid = await loadGrid(tx);
		const travel = travelSeconds(idle.x, idle.y, x, y, idle.speed, (cx, cy) => {
			const g = grid.get(cy * GRID_SIZE + cx);
			if (!g) throw new Error(`no tile row at (${cx}, ${cy}) — run \`npm run seed\``);
			return g.movementCost;
		});
		await tx.insert(operation).values({
			playerId,
			characterId: idle.id,
			type: 'gather',
			status: 'in-progress',
			originX: idle.x,
			originY: idle.y,
			destX: x,
			destY: y,
			buildingTypeId: null,
			// Snapshotted so the gather runs at the pace it began — skills are fixed once assigned.
			qualityMultiplier: pick.multiplier,
			startedAt: sql`now()`,
			travelDoneAt: sql`now() + ${`${travel} seconds`}::interval`,
			// Never finishes on its own.
			completeAt: null,
			// Work starts on arrival. Distance therefore costs the trip and nothing else — two
			// identical forests pay the same however far apart they are.
			accruedAt: sql`now() + ${`${travel} seconds`}::interval`
		});

		return { ok: true, world: await readWorld(tx, playerId) };
	});
}

/**
 * Sends an idle settler to a School to be trained into a specialist of a chosen profession.
 * Edge-triggered like a build (a fixed training time, a `complete_at`); `resolveWorld` does the
 * conversion on completion. Mirrors `assignWorker`'s shape — the checks that must hold before any
 * row is written happen first, so every refusal leaves the world untouched.
 */
export async function assignTraining(
	playerId: number,
	x: number,
	y: number,
	professionId: number
): Promise<OrderResult> {
	return db.transaction(async (tx): Promise<OrderResult> => {
		await resolveWorld(tx, playerId);

		if (!Number.isInteger(x) || !Number.isInteger(y)) return { ok: false, reason: 'OUT_OF_BOUNDS' };
		if (x < 0 || y < 0 || x >= GRID_SIZE || y >= GRID_SIZE)
			return { ok: false, reason: 'OUT_OF_BOUNDS' };

		const [prof] = await tx.select().from(profession).where(eq(profession.id, professionId));
		if (!prof) return { ok: false, reason: 'UNKNOWN_PROFESSION' };

		// A School must stand on the tile — the same shape as the Quarry gating Stone. Looked up
		// by name like the hamlet's House/Barn in ensurePlayer: a building type that code gates on
		// specifically is code-coupled by nature, unlike the tuning data VISION #10 keeps as rows.
		const [schoolType] = await tx
			.select({ id: buildingType.id })
			.from(buildingType)
			.where(eq(buildingType.displayName, 'School'));
		if (!schoolType)
			throw new Error('no School building_type row — run `npm run seed` against this database');
		const [school] = await tx
			.select()
			.from(building)
			.where(
				and(
					eq(building.playerId, playerId),
					eq(building.x, x),
					eq(building.y, y),
					eq(building.buildingTypeId, schoolType.id)
				)
			);
		if (!school) return { ok: false, reason: 'MISSING_SCHOOL' };

		// A settler specifically — a specialist is already trained, and this is what makes holding
		// one back a real choice. Idle (in no in-progress operation) and profession-less.
		const busy = tx
			.select({ id: operation.characterId })
			.from(operation)
			.where(and(eq(operation.playerId, playerId), eq(operation.status, 'in-progress')));
		const [settler] = await tx
			.select()
			.from(character)
			.where(
				and(
					eq(character.playerId, playerId),
					isNull(character.professionId),
					notInArray(character.id, busy)
				)
			)
			.limit(1);
		if (!settler) return { ok: false, reason: 'NO_IDLE_SETTLER' };

		const grid = await loadGrid(tx);
		const travel = travelSeconds(settler.x, settler.y, x, y, settler.speed, (cx, cy) => {
			const g = grid.get(cy * GRID_SIZE + cx);
			if (!g) throw new Error(`no tile row at (${cx}, ${cy}) — run \`npm run seed\``);
			return g.movementCost;
		});
		await tx.insert(operation).values({
			playerId,
			characterId: settler.id,
			type: 'train',
			status: 'in-progress',
			originX: settler.x,
			originY: settler.y,
			destX: x,
			destY: y,
			buildingTypeId: null,
			professionId,
			startedAt: sql`now()`,
			travelDoneAt: sql`now() + ${`${travel} seconds`}::interval`,
			// Edge-triggered: finishes on its own once travel plus the training time is up.
			completeAt: sql`now() + ${`${travel + TRAIN_SECONDS} seconds`}::interval`
		});

		return { ok: true, world: await readWorld(tx, playerId) };
	});
}

/** Ends an assignment. `resolveWorld` above has already paid out the final stretch. */
export async function recallWorker(playerId: number, operationId: number): Promise<OrderResult> {
	return db.transaction(async (tx): Promise<OrderResult> => {
		await resolveWorld(tx, playerId);

		const [op] = await tx
			.select()
			.from(operation)
			.where(
				and(
					eq(operation.id, operationId),
					eq(operation.playerId, playerId),
					eq(operation.status, 'in-progress'),
					eq(operation.type, 'gather')
				)
			);
		if (!op) return { ok: false, reason: 'UNKNOWN_OPERATION' };

		await tx.update(operation).set({ status: 'completed' }).where(eq(operation.id, op.id));
		// They are left standing where they were working. Recalled mid-walk they arrive anyway,
		// which is a shrug rather than a rule — there is nowhere else the model says they are.
		await tx
			.update(character)
			.set({ x: op.destX, y: op.destY })
			.where(eq(character.id, op.characterId));

		return { ok: true, world: await readWorld(tx, playerId) };
	});
}

/**
 * Cancels an in-progress build and refunds its full cost. Unlike `recallWorker` — which marks a
 * gather completed so the worker is paid out and left standing — a cancelled build must **delete**
 * the operation row: a lingering in-progress build op becomes a building on the next `resolveWorld`
 * read. Deleting frees the worker and the tile automatically, since both occupancy checks key on
 * the in-progress op.
 *
 * The refund is the placement deduction (`createBuildOrder`) run with `+` instead of `-`, always in
 * full — payment was taken in full at order and never prorated, so the return is too.
 *
 * **Delete-first, refund-only-on-RETURNING.** A double-clicked Cancel sends two DELETEs; a
 * select-then-refund-then-delete order would let both refund one build (a trivially-triggered
 * resource dupe). So the `DELETE … RETURNING` is the single point that picks a winner: exactly one
 * racer gets the row back and refunds, the loser gets nothing and returns `UNKNOWN_OPERATION`.
 * (`recallWorker`'s status-flip is idempotent enough to skip this; a refund is not.)
 */
export async function cancelBuild(playerId: number, operationId: number): Promise<OrderResult> {
	return db.transaction(async (tx): Promise<OrderResult> => {
		// resolveWorld may complete this very build first (turning it into a building); it is then no
		// longer in-progress and the delete below matches nothing — correctly refusing to refund a
		// build that already finished while the player was deciding.
		await resolveWorld(tx, playerId);

		const [cancelled] = await tx
			.delete(operation)
			.where(
				and(
					eq(operation.id, operationId),
					eq(operation.playerId, playerId),
					eq(operation.status, 'in-progress'),
					eq(operation.type, 'build')
				)
			)
			.returning({ buildingTypeId: operation.buildingTypeId });
		if (!cancelled) return { ok: false, reason: 'UNKNOWN_OPERATION' };

		const [home] = await tx.select().from(settlement).where(eq(settlement.playerId, playerId));
		if (!home) throw new Error(`player ${playerId} has no settlement`);
		const costs = await tx
			.select()
			.from(buildingCost)
			.where(eq(buildingCost.buildingTypeId, cancelled.buildingTypeId!));
		for (const c of costs) {
			await tx
				.update(stock)
				.set({ quantity: sql`${stock.quantity} + ${c.quantity}` })
				.where(and(eq(stock.settlementId, home.id), eq(stock.resourceId, c.resourceId)));
		}

		return { ok: true, world: await readWorld(tx, playerId) };
	});
}

/** The world as stored, plus the DB's own `now` — the only clock anything trusts. */
export async function readWorld(tx: Tx, playerId: number): Promise<WorldPayload> {
	const [{ now }] = await tx.execute<{ now: Date }>(sql`select now() as now`);
	// Ordered, because the client picks a default from this list by position.
	const types = await tx.select().from(buildingType).orderBy(asc(buildingType.id));
	const costs = await tx.select().from(buildingCost);
	// Terrain and resources are global catalogs, unfiltered by player — same split as
	// buildingTypes. The ground is the world's, not yours.
	const terrainTypes = await tx.select().from(terrainType);
	const resources = await tx.select().from(resource);
	// Professions the School offers — a global catalog like building types, ordered so the Train
	// picker doesn't reshuffle between reads.
	const professions = await tx.select().from(profession).orderBy(asc(profession.id));
	const held = await tx
		.select({ resourceId: stock.resourceId, quantity: stock.quantity })
		.from(stock)
		.innerJoin(settlement, eq(stock.settlementId, settlement.id))
		.where(eq(settlement.playerId, playerId))
		// Ordered, because the resource bar is rendered in payload order and an unordered join
		// is free to hand back a different one on every read — a bar that reshuffles itself.
		.orderBy(asc(stock.resourceId));
	const tiles = await tx.select().from(tile);
	const deposits = await tileYields(tx);
	const drawn = await tx.select().from(tileStock).where(eq(tileStock.playerId, playerId));
	const buildings = await tx.select().from(building).where(eq(building.playerId, playerId));
	const characters = await tx.select().from(character).where(eq(character.playerId, playerId));
	const operations = await tx
		.select()
		.from(operation)
		.where(and(eq(operation.playerId, playerId), eq(operation.status, 'in-progress')));

	// Built by index, not by sort order: `terrain` is positional, so one missing row would
	// shift every tile after it and render a wrong-but-plausible map. The check is that the
	// array we send is dense — a row *count* would pass on 256 rows with out-of-range
	// coordinates and still leave holes. A hole is a corrupt world, not a game rule, so it
	// throws rather than degrading.
	const terrain: number[] = new Array(GRID_SIZE * GRID_SIZE);
	for (const t of tiles) terrain[t.y * GRID_SIZE + t.x] = t.terrainTypeId;
	for (let i = 0; i < terrain.length; i++) {
		if (terrain[i] !== undefined) continue;
		throw new Error(
			tiles.length === 0
				? 'no tile rows — the grid is unseeded; run `npm run seed` against this database'
				: `tile grid has a hole at (${i % GRID_SIZE}, ${Math.floor(i / GRID_SIZE)})`
		);
	}

	// A tile nobody is standing on still recovers, and only the gather branch writes — so a
	// forest you clear-cut and walked away from has a stored `0` that nothing advances. Shipping
	// that number would show an empty forest for a month while the model says it is coming back,
	// which is exactly the "numbers that disagree with elapsed time" this design exists to avoid.
	// So the read path runs the same function with no worker on it, and writes nothing.
	const nowMs = new Date(now).getTime();
	const live = new Map(
		drawn.map((r) => {
			const d = deposits.get(r.y * GRID_SIZE + r.x);
			if (!d?.capacity || d.regrowSeconds === null) return [r.y * GRID_SIZE + r.x, r.quantity];
			const { quantity } = accrue(0, 0, {
				quantity: r.quantity,
				capacity: d.capacity,
				regrowSeconds: d.regrowSeconds,
				agedSeconds: (nowMs - r.asOf.getTime()) / 1000
			});
			return [r.y * GRID_SIZE + r.x, quantity!];
		})
	);
	const tileCapacity: (number | null)[] = new Array(GRID_SIZE * GRID_SIZE).fill(null);
	const tileQuantity: (number | null)[] = new Array(GRID_SIZE * GRID_SIZE).fill(null);
	for (const [i, d] of deposits) {
		// Only finite deposits get a number. An infinite one has nothing to count down.
		if (d.capacity === null || d.regrowSeconds === null) continue;
		tileCapacity[i] = d.capacity;
		tileQuantity[i] = live.get(i) ?? d.capacity;
	}

	return {
		now: new Date(now).toISOString(),
		gridSize: GRID_SIZE,
		tileQuantity,
		tileCapacity,
		terrainTypes: terrainTypes.map((t) => ({
			id: t.id,
			displayName: t.displayName,
			color: t.color,
			icon: t.icon,
			buildable: t.buildable,
			yieldsResourceId: t.yieldsResourceId,
			// The same rule the server gate runs, shipped per terrain so the menu offers only what
			// the writer would accept — a menu that lists what the server refuses is the bug this epic exists to kill.
			buildableTypeIds: eligibleTypeIds(t, types, resources)
		})),
		resources: resources.map((r) => ({ id: r.id, displayName: r.displayName })),
		professions: professions.map((p) => ({ id: p.id, displayName: p.displayName })),
		stock: held,
		buildingCosts: costs.map((c) => ({
			buildingTypeId: c.buildingTypeId,
			resourceId: c.resourceId,
			quantity: c.quantity
		})),
		terrain,
		buildingTypes: types.map((t) => ({
			id: t.id,
			displayName: t.displayName,
			icon: t.icon,
			buildSeconds: t.buildSeconds,
			requiresBuildingTypeId: t.requiresBuildingTypeId
		})),
		buildings: buildings.map((b) => ({
			id: b.id,
			x: b.x,
			y: b.y,
			buildingTypeId: b.buildingTypeId
		})),
		characters: characters.map((c) => ({
			id: c.id,
			x: c.x,
			y: c.y,
			speed: c.speed,
			professionId: c.professionId,
			name: c.name
		})),
		operations: operations.map((o) => ({
			id: o.id,
			characterId: o.characterId,
			type: o.type,
			buildingTypeId: o.buildingTypeId,
			professionId: o.professionId,
			originX: o.originX,
			originY: o.originY,
			destX: o.destX,
			destY: o.destY,
			startedAt: o.startedAt.toISOString(),
			travelDoneAt: o.travelDoneAt.toISOString(),
			// Null on a gather, and that is the wire's way of saying "this never ends by itself".
			completeAt: o.completeAt?.toISOString() ?? null
		}))
	};
}
