import { and, asc, eq, inArray, isNull, lte, ne, notInArray, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import {
	building,
	buildingCost,
	buildingType,
	character,
	gameConfig,
	operation,
	operationWorker,
	player,
	profession,
	professionSkill,
	reachMilestone,
	recipeInput,
	resource,
	settlement,
	skill,
	startPosition,
	stock,
	terrainType,
	tileStock
} from '$lib/server/db/schema';
import {
	accrue,
	crewBuild,
	eligibleTypeIds,
	GRID_SIZE,
	netRates,
	pickName,
	population,
	reachFor,
	rollStats,
	route,
	skillValue,
	withinReach,
	type EstimateResponse,
	type OperationType,
	type OrderReason,
	type WorldLive,
	type WorldPayload,
	type WorldStatic
} from './world';
// Generation, not a query — see `loadStaticWorld`'s own comment for why the read path now imports
// the generator it used to deliberately avoid.
import { terrainCharAt, terrainDataHash } from './worldgen';

// How fast a starting settler walks, in tiles per second. Not part of the start block, which is
// a placement and knows nothing about legs.
const WALK_SPEED = 0.5;

// How many people a realm starts with. An explicit placeholder for real population growth
// (the People epic). One would mean every build order cancels your only gatherer.
const STARTING_CHARACTERS = 3;

// How long training takes once the settler reaches the School, in seconds. ponytail: a module
// constant, not game_config — training time isn't an economy knob a live world is balanced on
// the way growth/food rates are. Move it to game_config if that changes.
const TRAIN_SECONDS = 30;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Who is unavailable — every body on an in-progress operation, as a subquery to filter against.
 * Idle is the complement, and is *derived* rather than stored: there is no busy flag to fall out
 * of sync with reality. Written once here rather than three times inline, because "who is on this
 * op" now means a membership row and a second copy of that join is a second thing to get wrong.
 */
function busyCharacterIds(tx: Tx, playerId: number) {
	return tx
		.select({ id: operationWorker.characterId })
		.from(operationWorker)
		.innerJoin(operation, eq(operationWorker.operationId, operation.id))
		.where(and(eq(operation.playerId, playerId), eq(operation.status, 'in-progress')));
}

export type PlayerSession = {
	playerId: number;
	/** True when the caller arrived holding a realm that no longer exists — see below. */
	worldReset: boolean;
};

/**
 * The rest of the start block, derived from the hamlet tile alone. `start_position` stores only
 * `x`/`y`, not six columns — worldgen.ts's `findStarts` clears the same shape (a second House to
 * the hamlet's west, the Barn to its east, the settlers on the row below) for every opening it
 * finds, so re-deriving it here rather than storing it again is the same fact read once instead of
 * kept twice, for every start rather than just one. Named once so a placement rule only has to be
 * right in one place, not repeated at every call site in `ensurePlayer`.
 */
function startBlockFrom(hamletX: number, hamletY: number) {
	return {
		hamletX,
		hamletY,
		house2X: hamletX - 1,
		house2Y: hamletY,
		barnX: hamletX + 1,
		barnY: hamletY,
		// The Marketplace, and so the centre of the realm's reach — one tile north of the hamlet,
		// the exact tile worldgen.ts's startBlockFor's marketX/marketY names.
		marketX: hamletX,
		marketY: hamletY - 1,
		characterX: hamletX,
		characterY: hamletY + 1
	};
}

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
		const market = catalog.get('Marketplace');
		if (!house || !barn || !market)
			throw new Error(
				'no House/Barn/Marketplace building_type rows — run `npm run seed` against this database'
			);

		const resources = await tx.select().from(resource);
		if (resources.length === 0)
			throw new Error('no resource rows — run `npm run seed` against this database');

		const [p] = await tx.insert(player).values({}).returning();

		// Claims the first unclaimed opening the seed found (worldgen.ts's `findStarts`), atomically:
		// the subquery's `FOR UPDATE SKIP LOCKED` is what lets two realms created at the same moment
		// each win a *different* row instead of both reading the same "first unclaimed" one and
		// racing to update it — the loser would either overwrite the winner's claim or, under a
		// naive read-then-write, land on the very same tile the winner just took. `ORDER BY id` is
		// what makes "first" mean anything: start_position rows are seeded closest-to-the-map's-
		// centre first, so realms fill in from the middle outward the same deterministic way every
		// time.
		const [claimed] = await tx.execute<{ x: number; y: number }>(sql`
			UPDATE start_position
			SET claimed_by_player_id = ${p.id}
			WHERE id = (
				SELECT id FROM start_position
				WHERE claimed_by_player_id IS NULL
				ORDER BY id
				FOR UPDATE SKIP LOCKED
				LIMIT 1
			)
			RETURNING x, y
		`);
		// Every unsatisfiable precondition in this function throws rather than degrading — a world
		// with nowhere left to put a realm is exactly that, not a case to paper over with a guessed
		// coordinate. Counted fresh rather than cached, since it only ever runs on the one read that
		// is about to fail.
		if (!claimed) {
			const [{ total }] = await tx
				.select({ total: sql<number>`count(*)::int` })
				.from(startPosition);
			throw new Error(`the world is full — all ${total} start position(s) are claimed`);
		}
		const start = startBlockFrom(claimed.x, claimed.y);

		const [s] = await tx
			.insert(settlement)
			.values({ playerId: p.id, x: start.hamletX, y: start.hamletY })
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
			{ playerId: p.id, x: start.hamletX, y: start.hamletY, buildingTypeId: house.id },
			// A second House, so a fresh realm's housing cap is eight and people keep arriving.
			{ playerId: p.id, x: start.house2X, y: start.house2Y, buildingTypeId: house.id },
			// The barn stores nothing yet and gates nothing — with no capacity there is nothing
			// for it to read. It is here so "where your stock lives" is a place on the map, and
			// it is the row capacity will hang off when it arrives.
			{ playerId: p.id, x: start.barnX, y: start.barnY, buildingTypeId: barn.id },
			// The reach's anchor, placed once and never again — there is no demolish path, and
			// player_buildable false keeps it out of every build menu forever after this.
			{ playerId: p.id, x: start.marketX, y: start.marketY, buildingTypeId: market.id }
		]);
		// Side by side along the row below the hamlet, so three pawns don't stack into one.
		await tx.insert(character).values(
			Array.from({ length: STARTING_CHARACTERS }, (_, i) => ({
				playerId: p.id,
				x: start.characterX + i - 1,
				y: start.characterY,
				speed: WALK_SPEED
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

/**
 * `GET /api/world`'s own read — the live half only (see `readWorldLive`), which is the whole of
 * the payload split: a heartbeat that used to re-send the 16,384-tile grid every 30 seconds now
 * gets none of it, because the client already has it from `/api/world/static/[version]` and only
 * refetches that when `worldVersion` disagrees.
 */
export async function loadWorldLive(playerId: number): Promise<WorldLive> {
	return db.transaction(async (tx) => {
		await resolveWorld(tx, playerId);
		return readWorldLive(tx, playerId);
	});
}

/**
 * `GET /api/world/static/[version]`'s own read. Null on a version that isn't current — a stale URL,
 * not a game rule — so the route 404s and the client falls back to whatever version its next
 * `/api/world` read reports, rather than ever serving one half against the other's terrain.
 *
 * The version check reads `game_config` directly rather than through `loadStaticWorld` — that used
 * to call `loadStaticWorld` itself just to read `.version` off the result, then hand the same `tx`
 * to `readWorldStatic`, which calls `loadStaticWorld` again to get the rest of it: two entries into
 * the one function this memo exists to make expensive-only-once, for a fact (`game_config.world_version`)
 * this function's own one-row read already has cheaper. See `loadStaticWorld`'s own comment for why
 * that redundant second call mattered.
 */
export async function loadWorldStaticFor(version: string): Promise<WorldStatic | null> {
	return db.transaction(async (tx) => {
		const [cfg] = await tx.select({ worldVersion: gameConfig.worldVersion }).from(gameConfig);
		if (!cfg || cfg.worldVersion !== version) return null;
		return readWorldStatic(tx);
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

	// The crews, in one read rather than one per operation. Keyed by operation id; a gather or a
	// training always has exactly one member, a build may have several.
	const crews = new Map<number, (typeof operationWorker.$inferSelect)[]>();
	if (active.length) {
		const rows = await tx
			.select()
			.from(operationWorker)
			.where(
				inArray(
					operationWorker.operationId,
					active.map((op) => op.id)
				)
			);
		for (const r of rows) crews.set(r.operationId, [...(crews.get(r.operationId) ?? []), r]);
	}

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

		// Build, train and craft are all edge-triggered — due or not.
		if (op.completeAt!.getTime() > nowMs) continue;
		await tx.update(operation).set({ status: 'completed' }).where(eq(operation.id, op.id));

		// The bodies that worked it. Empty would mean a crewless operation survived the starvation
		// sweep — nothing to move, and nothing that makes a building any less finished.
		const crew = crews.get(op.id) ?? [];

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
			// A training's crew is the one settler being taught.
			if (!crew.length) continue;
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
				.where(eq(character.id, crew[0].characterId));
			continue;
		}

		if (op.type === 'craft') {
			// A batch ends by adding to stock rather than by raising a building. `building_type_id`
			// names the workshop, which is how completion finds the recipe — read now rather than
			// snapshotted at order time, so a live retune of the output reaches batches in flight
			// the same way a retuned profession reaches the next job (VISION #10).
			//
			// Stock rows exist for every resource from creation (and the seed backfills resources
			// added later), so this is a plain UPDATE like the other four stock writes.
			const [made] = await tx
				.select({
					producesResourceId: buildingType.producesResourceId,
					outputQuantity: buildingType.outputQuantity
				})
				.from(buildingType)
				.where(eq(buildingType.id, op.buildingTypeId!));
			// A workshop whose recipe was removed while a batch was in flight. Paying nothing is
			// the safe reading, the same one the gather branch gives a tile that stopped yielding.
			if (made?.producesResourceId != null && made.outputQuantity != null)
				await tx
					.update(stock)
					.set({ quantity: sql`${stock.quantity} + ${made.outputQuantity}` })
					.where(
						and(eq(stock.settlementId, home.id), eq(stock.resourceId, made.producesResourceId))
					);
		} else {
			await tx.insert(building).values({
				playerId,
				x: op.destX,
				y: op.destY,
				buildingTypeId: op.buildingTypeId!,
				// The crew's workmanship, carried onto the thing they made. This is the last moment it
				// exists: the operation that knows it is about to be history.
				quality: op.qualityMultiplier
			});
		}
		// The whole crew ends up standing where they worked — the site they raised, or the
		// workshop they ran. Shared by both branches rather than copied into each.
		if (crew.length)
			await tx
				.update(character)
				.set({ x: op.destX, y: op.destY })
				.where(
					inArray(
						character.id,
						crew.map((m) => m.characterId)
					)
				);
	}

	// Orders that were waiting for a body — builds and batches alike. This is the one *starting*
	// responsibility resolveWorld has: everything above it finishes work, and finishing is what
	// frees the workers this reads.
	await startQueuedOperations(tx, playerId);

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
					speed: WALK_SPEED
				}))
			);
		if (died > 0) await removeSettlers(tx, playerId, died);

		// The reach's ratchet: `reachFor` (world.ts) is the tested arithmetic, so the target radius
		// for this population is computed in JS; the SQL side is only ever `GREATEST`, never a plain
		// assignment. Population falls during starvation, and decision 9 forbids the border falling
		// with it — a live-derived radius would shrink the moment a famine started, `GREATEST` cannot.
		const milestones = await tx.select().from(reachMilestone);
		const target = reachFor(pop, milestones);

		// The anchor now advances fully to now every read (food must drain smoothly with the
		// clock); the sub-person remainder rides in populationAccrued instead. The reach update rides
		// the same statement — one UPDATE, not two.
		await tx
			.update(settlement)
			.set({
				populationAsOf: sql`now()`,
				populationAccrued: accrued,
				reachRadius: sql`GREATEST(${settlement.reachRadius}, ${target})`
			})
			.where(eq(settlement.id, home.id));
	}
}

/**
 * Puts an order's full charge back — the order-time deduction run with `+` instead of `-`.
 *
 * Which table that charge came from follows the type, and nothing else: a build was priced by
 * `building_cost`, a batch by `recipe_input`. Reading the wrong one would silently refund nothing,
 * which is how a famine could eat a batch's wood and return none of it.
 */
async function refundOrder(
	tx: Tx,
	settlementId: number,
	type: OperationType,
	buildingTypeId: number
): Promise<void> {
	const costs =
		type === 'craft'
			? await tx.select().from(recipeInput).where(eq(recipeInput.buildingTypeId, buildingTypeId))
			: await tx.select().from(buildingCost).where(eq(buildingCost.buildingTypeId, buildingTypeId));
	for (const c of costs) {
		await tx
			.update(stock)
			.set({ quantity: sql`${stock.quantity} + ${c.quantity}` })
			.where(and(eq(stock.settlementId, settlementId), eq(stock.resourceId, c.resourceId)));
	}
}

/**
 * Deletes any in-progress operation left with nobody on it, refunding the ones that were paid for.
 *
 * An operation *is* its crew — with the crew gone there is nobody to move on completion and
 * nobody to pay, so leaving the row would strand a build that completes into a building nobody
 * raised, or a gather quietly accruing into stock with nobody working it. Only reachable through
 * starvation today (its one caller), which is exactly why it is a named function rather than two
 * lines inside one: it is the invariant, not a step of the famine.
 *
 * Scoped to in-progress on purpose: a *completed* operation whose members were later culled is
 * history, and refunding it would pay a second time for a building that stands.
 */
async function deleteCrewlessOperations(tx: Tx, playerId: number): Promise<void> {
	const crewless = await tx
		.select({ id: operation.id, type: operation.type, buildingTypeId: operation.buildingTypeId })
		.from(operation)
		.where(
			and(
				eq(operation.playerId, playerId),
				eq(operation.status, 'in-progress'),
				notInArray(
					operation.id,
					tx.select({ id: operationWorker.operationId }).from(operationWorker)
				)
			)
		);
	if (crewless.length === 0) return;

	// Both paid-at-order types, not just builds: a craft's inputs left stock the moment it was
	// ordered, so a famine that eats the crew must hand them back too, or the wood is simply gone.
	const paid = crewless.filter((op) => op.type === 'build' || op.type === 'craft');
	if (paid.length) {
		const [home] = await tx.select().from(settlement).where(eq(settlement.playerId, playerId));
		if (!home) throw new Error(`player ${playerId} has no settlement`);
		for (const b of paid) await refundOrder(tx, home.id, b.type, b.buildingTypeId!);
	}
	// The membership rows go with it by cascade — there are none left to go.
	await tx.delete(operation).where(
		inArray(
			operation.id,
			crewless.map((op) => op.id)
		)
	);
}

/**
 * Starts any queued order — a build or a craft batch — that a worker has since freed up for. Runs
 * inside `resolveWorld`, so it happens on every read, which is what makes an order start itself
 * while nobody is looking. That is the whole of "order it and walk away".
 *
 * **It must cost nothing when nothing is queued**, because every read pays for it: one indexed
 * query, and an early return. When there *is* work, the idle set and the ranking inputs load once
 * and claimed bodies are struck off in memory, rather than re-querying per order.
 *
 * FIFO by `id`, which is `serial` — the order that has waited longest goes first, for free, and
 * that already mixes builds and batches in one queue with nothing to arbitrate between them.
 *
 * **Two things vary by type, and both must**: a build ranks by Construction and takes its seconds
 * from `build_seconds`, a batch ranks by what *produces its output* and takes them from
 * `craft_seconds`. Getting the second one wrong is silent — a plank batch would simply be priced
 * like the Sawmill that makes it — which is why the seed keeps those two numbers different and a
 * check measures them apart.
 *
 * Concurrency: this is the second writer of worker assignment, but not a second *lock*. Every
 * writer calls `resolveWorld`, which opens by taking the settlement `FOR UPDATE`, so an auto-start
 * and a hand-placed order serialise behind the same row. No new race surface.
 */
async function startQueuedOperations(tx: Tx, playerId: number): Promise<void> {
	const queued = await tx
		.select()
		.from(operation)
		.where(and(eq(operation.playerId, playerId), eq(operation.status, 'queued')))
		.orderBy(asc(operation.id));
	if (queued.length === 0) return;

	let free = await idleBodies(tx, playerId);
	if (free.length === 0) return;

	const grid = await loadGrid(tx, playerId);
	const types = new Map(
		(
			await tx
				.select({
					id: buildingType.id,
					buildSeconds: buildingType.buildSeconds,
					craftSeconds: buildingType.craftSeconds,
					producesResourceId: buildingType.producesResourceId
				})
				.from(buildingType)
		).map((t) => [t.id, t])
	);
	const skillOfResource = new Map(
		(await tx.select({ id: resource.id, skillId: resource.skillId }).from(resource)).map((r) => [
			r.id,
			r.skillId
		])
	);
	// One ranker per *distinct* skill rather than one for the whole pass, built on demand: a queue of
	// nothing but builds still loads exactly the one it used to.
	const rankers = new Map<number, Awaited<ReturnType<typeof loadRanker>>>();
	const rankerFor = async (skillId: number) => {
		const cached = rankers.get(skillId);
		if (cached) return cached;
		const made = await loadRanker(tx, skillId);
		rankers.set(skillId, made);
		return made;
	};
	let construction: number | null = null;

	for (const op of queued) {
		const type = types.get(op.buildingTypeId!);
		if (!type) continue;
		// A workshop whose recipe was removed while a batch sat in the queue. Leaving it queued is
		// the safe reading — it holds its inputs, and cancelling refunds them.
		const craft = op.type === 'craft';
		if (craft && (type.craftSeconds === null || type.producesResourceId === null)) continue;
		const skillId = craft
			? skillOfResource.get(type.producesResourceId!)
			: (construction ??= await constructionSkillId(tx));
		if (skillId == null) continue;

		const eligible = free.filter((c) => admits(op.allowedProfessionIds, c.professionId));
		if (eligible.length === 0) continue;
		const crew = (await rankerFor(skillId))(eligible).slice(0, op.crewSize);

		const solved = solveCrew(
			crew,
			craft ? type.craftSeconds! : type.buildSeconds,
			op.destX,
			op.destY,
			movementCostIn(grid)
		);
		await tx
			.update(operation)
			.set({
				status: 'in-progress',
				qualityMultiplier: solved.quality!,
				startedAt: sql`now()`,
				completeAt: sql`now() + ${`${solved.seconds} seconds`}::interval`
			})
			.where(eq(operation.id, op.id));
		await insertCrew(tx, op.id, solved.crew);

		// Struck off in memory rather than re-queried, so two queued orders can't both claim the
		// same body in one pass.
		const taken = new Set(crew.map((m) => m.character.id));
		free = free.filter((c) => !taken.has(c.id));
		if (free.length === 0) break;
	}
}

/**
 * Removes `n` settlers to starvation, respecting the operation_worker FK. `character_id` there is
 * deliberately uncascaded, so a character on *any* operation — in-progress or long completed —
 * cannot be deleted until those membership rows are gone. Idle settlers go before working ones and
 * crew members go last, so an active build is only cut short when the hungry tail truly demands it.
 *
 * ponytail: a cull does not re-solve the survivors' `complete_at` — a build finishes on its
 * original schedule with one fewer body. Re-solving would push recomputation into `resolveWorld`
 * and cost it the compute-once-at-order property. Solve on the remaining crew here the day a
 * famine mid-build reads as wrong.
 */
async function removeSettlers(tx: Tx, playerId: number, n: number): Promise<void> {
	if (n <= 0) return;
	const busy = new Set((await busyCharacterIds(tx, playerId)).map((r) => r.id));
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
	// FK: every membership row naming a culled character must go before the character does.
	await tx.delete(operationWorker).where(inArray(operationWorker.characterId, victims));
	await deleteCrewlessOperations(tx, playerId);
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

/**
 * The two full-grid reads this project's egress problem was measured against (see the history in
 * CLAUDE.md and on readWorld below) used to be a database query: the whole `tile` table, and its
 * join to `resource` via `terrainType` — 5,178,273 rows a read at 1448×1448 (238 MB, 67 seconds
 * cold), up from 28,583 rows / ~1.3 MB at the 128×128 map this was first measured against. Static
 * content that only ever changes when `npm run seed` runs was being paid for as if it were a query,
 * every time a lambda instance's own memo was cold.
 *
 * **It isn't a query any more.** The terrain grid is a pure function of `WORLD_SEED` + `GRID_SIZE` +
 * worldgen.ts's generator, so this generates it instead of selecting it, and only trusts the result
 * once its hash matches `game_config.terrain_hash` (see `terrainDataHash`'s own comment for what that
 * proves and why the seed writes it). world.server.ts deliberately did *not* import worldgen.ts for
 * exactly this reason a few phases ago — importing it ran the generator's reroll loop at module
 * import, regenerating the world on every cold start, at a cost the header comment there measured at
 * ~34 ms against a much smaller grid. That reasoning is now inverted: generation at 1448×1448 was
 * measured here (`node -e` timing a bare import of worldgen.ts, no DB) at ~2.4 seconds — real, and
 * worth knowing about, but still the cheap side of the trade by more than an order of magnitude
 * against 67 *seconds* of egress-bound query time, and by four orders of magnitude against the 238 MB
 * that egress cost — a number generation doesn't move at all, since none of it leaves the process.
 * Importing worldgen.ts here doesn't change *when* the reroll loop runs — it still fires exactly once
 * per lambda instance, at import, the same cadence this memo already had — it changes what that one
 * run is *for*: every request after the first on a given instance now finds the grid already sitting
 * in memory rather than a memo waiting to be filled by a multi-second query.
 *
 * Only `terrain_type` and `resource` remain real database reads: dozens of rows each, the tuning
 * data those tables actually exist to hold, read fresh rather than folded into this memo (same
 * reasoning `loadGrid`'s and `readWorldStatic`'s own small-catalog reads already use).
 *
 * Shared by every caller that used to run the heavy queries itself — `tileYields`, `loadGrid`, and
 * `readWorldStatic` — so a build order's occupancy check and an estimate's re-quote never regenerate
 * the grid on their own either; they all read this one memo.
 *
 * `terrainIds` is the terrain grid held *compactly* — one `Uint16` per tile, row-major, rather than
 * row objects. At GRID_SIZE² tiles (2,096,704 at 1448×1448) an array of small objects is on the
 * order of 200 MB of JS heap, held for the life of the lambda instance — every field boxed, every
 * row its own allocation with V8's per-object overhead on top. The typed array is ~4.2 MB and holds
 * everything any reader below actually asks a tile for: which terrain it is. `capacityByType`
 * carries the one other fact a terrain id alone doesn't — a deposit's capacity — as one number per
 * *type* (terrain_type.capacity, seeded once per row, same value `tile.quantity` used to repeat once
 * per tile of that type), so it stays a handful of entries regardless of grid size.
 *
 * ponytail: still a per-lambda-instance memo — module state, not a shared cache. Every cold spin-up
 * pays the generation cost again at import (~2.4 s measured at 1448×1448 — see above), which is the
 * whole point of this rewrite: that cost is CPU on the instance, not ~167 MB of egress leaving it, so
 * paying it once per instance stopped being the problem worth solving. Most cold instances should
 * still never reach even that, once the edge is serving
 * `/api/world/static`'s year-long, immutable CDN response across a fleet of instances. A blob/CDN
 * artifact the seed writes directly (architecture C on issue #21) remains the upgrade the day
 * per-instance generation is itself the cost that matters — unlikely at 34 ms, but the grid only
 * gets bigger from here.
 */
type StaticWorld = {
	version: string;
	terrainIds: Uint16Array;
	capacityByType: Map<number, number | null>;
	deposits: Map<number, TileYield>;
};

let staticWorldCache: StaticWorld | null = null;
// The gap a value-only memo leaves open: `staticWorldCache` is only written *after* generation and
// the two catalog reads finish, so any call that arrives while an earlier one is still in flight
// sees the cache exactly as empty as the first call did, and would otherwise redo the same work.
// That gap is exactly how `readWorldStatic` used to get called twice for one `/api/world/static`
// request — once directly by `loadWorldStaticFor` to check the version, once again inside
// `readWorldStatic` itself — each a fresh entry into this function with nothing to stop both from
// racing past the cache check before either had set it. Fixed on both ends: `loadWorldStaticFor`
// below no longer makes that redundant first call, and this in-flight promise makes the memo
// single-flight regardless of who calls it or how many times — a second caller during a cold fill
// (concurrent requests hitting the same warming instance, not just one function calling in twice)
// now awaits the *same* computation instead of starting a second one.
let staticWorldLoading: Promise<StaticWorld> | null = null;

async function loadStaticWorld(tx: Tx): Promise<StaticWorld> {
	const [cfg] = await tx
		.select({ worldVersion: gameConfig.worldVersion, terrainHash: gameConfig.terrainHash })
		.from(gameConfig);
	if (!cfg || cfg.worldVersion === null)
		throw new Error('no world_version in game_config — run `npm run seed` against this database');
	if (staticWorldCache?.version === cfg.worldVersion) return staticWorldCache;
	if (staticWorldLoading) return staticWorldLoading;

	staticWorldLoading = (async () => {
		try {
			if (!cfg.terrainHash)
				throw new Error(
					'no terrain_hash in game_config — run `npm run seed` against this database'
				);
			// The load-bearing check: what the generator produces right now, proven equal to what the
			// seed generated and wrote catalogs and start positions against. A mismatch means
			// worldgen.ts changed since `npm run seed` last ran — serving the newly generated grid
			// would show a world that disagrees with every `tile_stock`, `building` and `settlement`
			// row already on it, so this throws instead of guessing, the same shape as every other
			// missing/stale-catalog throw in this file.
			if (terrainDataHash(GRID_SIZE, terrainCharAt) !== cfg.terrainHash)
				throw new Error(
					'generated terrain does not match the seeded world (terrain_hash mismatch in ' +
						'game_config) — worldgen.ts has changed since `npm run seed` last ran; run it again'
				);

			const terrainTypes = await tx.select().from(terrainType);
			const resources = await tx.select().from(resource);
			const byChar = new Map(terrainTypes.map((t) => [t.char, t]));
			const resourceById = new Map(resources.map((r) => [r.id, r]));

			const terrainIds = new Uint16Array(GRID_SIZE * GRID_SIZE);
			const deposits = new Map<number, TileYield>();
			for (let y = 0; y < GRID_SIZE; y++)
				for (let x = 0; x < GRID_SIZE; x++) {
					const char = terrainCharAt(x, y);
					const t = byChar.get(char);
					// A char the generator produces but the catalog carries no row for — an unseeded or
					// stale terrain_type table, not a game rule (the terrain-hash check above already
					// catches a generator that disagrees with the seed; this catches a seed that never
					// ran at all).
					if (!t)
						throw new Error(
							`unknown terrain char '${char}' at (${x}, ${y}) — run \`npm run seed\` against this database`
						);
					const i = y * GRID_SIZE + x;
					terrainIds[i] = t.id;
					if (t.yieldsResourceId !== null) {
						const r = resourceById.get(t.yieldsResourceId);
						if (r)
							deposits.set(i, {
								resourceId: r.id,
								unitsPerHour: r.unitsPerHour,
								skillId: r.skillId,
								requiresBuildingTypeId: r.requiresBuildingTypeId,
								capacity: t.capacity,
								regrowSeconds: t.regrowSeconds
							});
					}
				}
			const capacityByType = new Map(terrainTypes.map((t) => [t.id, t.capacity]));

			const world: StaticWorld = {
				version: cfg.worldVersion!,
				terrainIds,
				capacityByType,
				deposits
			};
			staticWorldCache = world;
			return world;
		} finally {
			// Cleared whether this attempt succeeded or threw — a failed fill (a stale seed, a missing
			// catalog) must not wedge every later call into awaiting a promise that already rejected.
			staticWorldLoading = null;
		}
	})();
	return staticWorldLoading;
}

/** What each tile yields, how fast, and how much of it there is, keyed row-major. */
async function tileYields(tx: Tx): Promise<Map<number, TileYield>> {
	return (await loadStaticWorld(tx)).deposits;
}

type RankedWorker = { character: typeof character.$inferSelect; multiplier: number };

/**
 * What `route` charges per tile, read off a loaded grid. Written once because all three journeys —
 * a build crew, a gather, a training — must be priced by the same ground; three inline copies of
 * this lookup was three chances for one of them to route differently.
 *
 * A missing tile is a corrupt grid, not a game rule: the seed writes every tile, so a hole means
 * the map was never seeded (the same reading `readWorld` gives it).
 */
function movementCostIn(
	grid: Awaited<ReturnType<typeof loadGrid>>
): (x: number, y: number) => number {
	return (x, y) => {
		const g = grid.get(y * GRID_SIZE + x);
		if (!g) throw new Error(`no tile row at (${x}, ${y}) — run \`npm run seed\``);
		return g.movementCost;
	};
}

/**
 * Whether an order restricted to `allowed` will take this body. Null or empty is no restriction;
 * a settler carries no profession and so is never admitted by a filter that names any (S3 — you
 * hold a good worker back by not picking them, not by naming settlers).
 *
 * **The same predicate at two moments**: narrowing the idle set when an order is placed, and
 * admitting a freed worker when a queued one starts itself. Authored once so those two can't drift
 * — an order that would accept a body but whose queue wouldn't is a build that waits forever.
 */
function admits(allowed: number[] | null | undefined, professionId: number | null): boolean {
	if (!allowed || allowed.length === 0) return true;
	return professionId !== null && allowed.includes(professionId);
}

/**
 * Every idle worker ranked by how well they do `skillId`, best first, each with the quality
 * multiplier they'd bring. This is the "who does the job changes the result" pick: a settler works
 * at the flat baseline, a specialist at their derived skillValue, so the best-skilled body leads
 * by default and holding your best one back is a real choice. Empty when nobody is idle.
 *
 * The whole ranking rather than just the winner, because a crew takes the top *n* — and a gather,
 * which still wants exactly one body, simply takes the first.
 *
 * Derived from the *live* bundle every call (design decision: a profession retune reaches the next
 * job a specialist takes); the caller snapshots only the resulting multipliers.
 */
/**
 * Loads everything the ranking depends on — the tuning config, the skill's two governing stats, and
 * the profession bundle — and hands back a *pure* function over bodies.
 *
 * Split out because the auto-start pass ranks repeatedly, once per queued build, and re-reading
 * three catalogs each time would put that cost on every world read. Load once, rank many.
 *
 * Derived from the *live* bundle each time the loader runs (design decision: a profession retune
 * reaches the next job a specialist takes); the caller snapshots only the resulting multipliers.
 */
async function loadRanker(
	tx: Tx,
	skillId: number
): Promise<(bodies: (typeof character.$inferSelect)[]) => RankedWorker[]> {
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

	return (bodies) =>
		bodies
			.map((c) => ({
				character: c,
				multiplier: skillValue(
					c.professionId !== null ? (bundle.get(c.professionId) ?? null) : null,
					statOf(c, sk.statA),
					statOf(c, sk.statB),
					config
				)
			}))
			.sort((a, b) => b.multiplier - a.multiplier);
}

/** Every body not currently on an in-progress operation. Idle is derived, never stored. */
async function idleBodies(tx: Tx, playerId: number) {
	return tx
		.select()
		.from(character)
		.where(
			and(
				eq(character.playerId, playerId),
				notInArray(character.id, busyCharacterIds(tx, playerId))
			)
		);
}

/**
 * Every idle worker who may work this order, ranked by how well they do `skillId`, best first. This
 * is the "who does the job changes the result" pick: a settler works at the flat baseline, a
 * specialist at their derived skillValue, so the best-skilled body leads by default and holding
 * your best one back is a real choice. Empty when nobody qualifies.
 *
 * The whole ranking rather than just the winner, because a crew takes the top *n* — and a gather,
 * which still wants exactly one body, simply takes the first.
 */
async function rankIdleWorkers(
	tx: Tx,
	playerId: number,
	skillId: number,
	allowed: number[] | null = null
): Promise<RankedWorker[]> {
	const idle = (await idleBodies(tx, playerId)).filter((c) => admits(allowed, c.professionId));
	if (idle.length === 0) return [];
	return (await loadRanker(tx, skillId))(idle);
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

/**
 * The realm's reach: a circle around its Marketplace, sized by `settlement.reach_radius`. Centred
 * on the Marketplace itself rather than `settlement.x/y` — decision 6 anchors the reach on the
 * building, not on the hamlet column that happens to sit one tile south of it — found the same way
 * `assignTraining` finds a School: the building type by name, then the one standing tile of it.
 *
 * A realm without a Marketplace **throws**, matching every other missing-catalog-row case in this
 * file (`run npm run seed`). It must never degrade into a silent radius of 0 at (0, 0) — that would
 * refuse every build and gather while looking, to the player, exactly like a legitimate small reach.
 */
async function reachOf(
	tx: Tx,
	playerId: number
): Promise<{ x: number; y: number; radius: number }> {
	const [marketType] = await tx
		.select({ id: buildingType.id })
		.from(buildingType)
		.where(eq(buildingType.displayName, 'Marketplace'));
	if (!marketType)
		throw new Error('no Marketplace building_type row — run `npm run seed` against this database');
	const [market] = await tx
		.select({ x: building.x, y: building.y })
		.from(building)
		.where(and(eq(building.playerId, playerId), eq(building.buildingTypeId, marketType.id)));
	if (!market)
		throw new Error(
			`player ${playerId} has no Marketplace — run \`npm run seed\` against this database`
		);
	const [home] = await tx
		.select({ radius: settlement.reachRadius })
		.from(settlement)
		.where(eq(settlement.playerId, playerId));
	if (!home) throw new Error(`player ${playerId} has no settlement`);
	return { x: market.x, y: market.y, radius: home.radius };
}

export type OrderResult = { ok: true; world: WorldPayload } | { ok: false; reason: OrderReason };
export type EstimateResult =
	{ ok: true; estimate: EstimateResponse } | { ok: false; reason: OrderReason };

/**
 * The grid a build order is judged against: what every tile is made of, keyed the same
 * row-major way the wire payload is. Serves both the destination's buildability and the cost of
 * every tile a route might cross — and routing genuinely needs all of them, since it does not know
 * which way it is going until it has looked.
 *
 * **Per player, because roads are.** A tile's cost is what is *built* on it if that changes the
 * ground, else the terrain's own — and only this player's own roads are read fresh here, so your
 * roads speed your people up and nobody else's. That used to mean one query joining the whole grid
 * against this player's buildings every call, which was the second full-grid read this write path
 * paid (see `loadStaticWorld`'s own note) — now the whole-grid part comes from the shared memo and
 * only this player's own roads are read fresh: a handful of rows, not the whole grid.
 *
 * ponytail: still per-player even though building *occupancy* (which this comment used to justify
 * that with, under VISION #4's interim override) is world-shared now — a road is physically on the
 * ground the same way a building is, so the honest end state is every player's road speeding every
 * walker across it. Left alone here because it is out of this pass's requested scope (occupancy and
 * the read path, not routing), and it touches `route`'s cost function on every order and estimate —
 * a bigger, more careful change than dropping a WHERE clause. Un-scope the buildings read in this
 * function (and its "own roads only" framing above) the day shared roads matter.
 *
 * Returns a lookup, not a prebuilt `Map` any more — a `new Map(tiles.map(...))` over every tile in
 * the world used to run on *every call* (an order, an estimate, a gather, a training), which is the
 * exact shape of bug `route`'s own doc comment names: cost that scales with the grid rather than
 * with the work. Measured at 1024×1024 it was ~150 ms of pure Map-construction overhead — bigger
 * than `route` itself pays for a real in-reach walk — to answer what a single order ever asks more
 * than a few dozen times. `terrainById` and `overrides` are both small (a handful of terrain types,
 * this player's own roads), so a closure over them costs nothing to build and O(1) per tile it is
 * actually asked about, same as `movementCostIn`'s own contract.
 */
async function loadGrid(
	tx: Tx,
	playerId: number
): Promise<{
	get(key: number):
		| {
				buildable: boolean;
				isDeposit: boolean;
				yieldsResourceId: number | null;
				movementCost: number;
		  }
		| undefined;
}> {
	const { terrainIds } = await loadStaticWorld(tx);
	// A small catalog, not the grid — cheap to read fresh rather than folding into the memo.
	const terrainById = new Map((await tx.select().from(terrainType)).map((t) => [t.id, t]));
	// This player's own movement-cost overrides only (their roads) — the COALESCE the old single
	// query expressed in SQL, done here in JS against a read that is this player's buildings, not
	// the whole map.
	const overrides = new Map(
		(
			await tx
				.select({ x: building.x, y: building.y, movementCost: buildingType.movementCost })
				.from(building)
				.innerJoin(buildingType, eq(building.buildingTypeId, buildingType.id))
				.where(and(eq(building.playerId, playerId), sql`${buildingType.movementCost} IS NOT NULL`))
		).map((b) => [b.y * GRID_SIZE + b.x, b.movementCost as number])
	);
	return {
		get(key: number) {
			const tt = terrainById.get(terrainIds[key]);
			if (!tt) return undefined;
			return {
				buildable: tt.buildable,
				isDeposit: tt.isDeposit,
				yieldsResourceId: tt.yieldsResourceId,
				movementCost: overrides.get(key) ?? tt.movementCost
			};
		}
	};
}

/**
 * Turns a chosen crew into one schedule and one workmanship: each member's own travel leg from
 * their own tile, handed to `crewBuild`. Empty crew ⇒ no schedule at all, which is a queued build.
 *
 * Shared by the order path and by the auto-start pass, because they are the same arithmetic done at
 * two different moments — a build that starts itself twenty minutes late must be solved exactly the
 * way it would have been had a worker been free at order time.
 */
function solveCrew(
	crew: RankedWorker[],
	buildSeconds: number,
	destX: number,
	destY: number,
	cost: (x: number, y: number) => number
): { crew: BuildPlan['crew']; seconds: number | null; quality: number | null } {
	// One route each: they leave from their own tiles, so they each pick their own way there.
	const routes = crew.map((m) =>
		route(m.character.x, m.character.y, destX, destY, m.character.speed, cost, GRID_SIZE)
	);
	const members = crew.map((m, i) => ({
		...m,
		arrivesAt: routes[i].seconds,
		path: routes[i].path
	}));
	if (members.length === 0) return { crew: members, seconds: null, quality: null };
	const { seconds, quality } = crewBuild(
		members.map((m) => ({ multiplier: m.multiplier, arrivesAtSeconds: m.arrivesAt })),
		buildSeconds
	);
	return { crew: members, seconds: Math.round(seconds), quality };
}

/** A build as it *would* happen: who goes, how long it takes, how well it comes out. */
export type BuildPlan = {
	/** Empty when nobody qualifies — the order waits, and starts itself when someone frees. */
	crew: {
		character: typeof character.$inferSelect;
		multiplier: number;
		arrivesAt: number;
		/** The route this body walks — stored on the membership row, see operation_worker.path. */
		path: number[];
	}[];
	/** Whole seconds from the order to the finished building, travel included. Null while it waits. */
	seconds: number | null;
	quality: number | null;
	costs: { resourceId: number; quantity: number }[];
	settlementId: number;
	/** The filter as stored — normalised, so null genuinely means "anyone". */
	allowed: number[] | null;
	/** How many bodies were asked for, remembered so a queued build can be started later. */
	crewSize: number;
};
export type PlanResult = { ok: true; plan: BuildPlan } | { ok: false; reason: OrderReason };

/**
 * Everything an order decides, and none of what it writes: every rule, the crew it would send, and
 * the numbers that crew would produce. Rejections come back as a value, not an exception — a
 * try/catch around the handler would map a mid-transaction DB failure onto a 400 the player reads
 * as a game rule. Only an `OrderReason` produces a 400; anything thrown stays thrown.
 *
 * **The estimate and the order both go through here, and that shared path is the only thing that
 * actually guarantees the preview matches the outcome.** Two implementations agreeing today is two
 * implementations that will disagree eventually, and "the numbers shown before you commit aren't
 * the ones you get" is a stated failure of this epic.
 *
 * The caller must have run `resolveWorld` first: a stale idle set would quote a worker who is
 * already busy.
 */
async function planBuild(
	tx: Tx,
	playerId: number,
	x: number,
	y: number,
	buildingTypeId: number,
	crewSize: number,
	allowedProfessionIds: number[] | null | undefined
): Promise<PlanResult> {
	// Clamped rather than refused: a crew size is a dial, not a claim about the world, and there is
	// no sentence to show a player whose stepper sent 0. Absent means one, which is what every
	// caller meant before crews existed.
	const wanted = Number.isFinite(crewSize) ? Math.max(1, Math.floor(crewSize)) : 1;
	// Empty means unrestricted, so it is normalised away here rather than stored as a filter that
	// admits nobody. Everything downstream then only has to know null-or-a-real-list.
	const allowed = allowedProfessionIds?.length ? allowedProfessionIds : null;

	if (!Number.isInteger(x) || !Number.isInteger(y)) return { ok: false, reason: 'OUT_OF_BOUNDS' };
	if (x < 0 || y < 0 || x >= GRID_SIZE || y >= GRID_SIZE)
		return { ok: false, reason: 'OUT_OF_BOUNDS' };

	const [type] = await tx.select().from(buildingType).where(eq(buildingType.id, buildingTypeId));
	if (!type) return { ok: false, reason: 'UNKNOWN_BUILDING_TYPE' };

	// The integrity check Postgres can't do for us (see the column's comment): an array element
	// takes no foreign key, so a filter naming a profession that doesn't exist has to fail loudly
	// *here*. Silently it would match nobody, read as "everyone is busy", and once a filter can
	// queue, become an order waiting forever for a worker who cannot exist.
	if (allowed) {
		const known = new Set(
			(await tx.select({ id: profession.id }).from(profession)).map((p) => p.id)
		);
		if (allowed.some((id) => !known.has(id))) return { ok: false, reason: 'UNKNOWN_PROFESSION' };
	}

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
	const grid = await loadGrid(tx, playerId);
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
	const catalogTypes = await tx
		.select({ id: buildingType.id, playerBuildable: buildingType.playerBuildable })
		.from(buildingType);
	const catalogResources = await tx
		.select({ id: resource.id, requiresBuildingTypeId: resource.requiresBuildingTypeId })
		.from(resource);
	if (!eligibleTypeIds(groundAt(x, y), catalogTypes, catalogResources).includes(buildingTypeId))
		return { ok: false, reason: 'TILE_NOT_BUILDABLE' };

	// Your ground, next: legal ground first (above), occupancy and cost after (below). The reach is
	// a sphere of influence, not a building permit — gates a gather assignment too (`assignWorker`),
	// same reason, same `OUTSIDE_REACH`. Crafting and training get no matching check: both happen at
	// a building, and a building is necessarily inside the reach that let it be built.
	//
	// Reaches may overlap — two realms opened close enough (or grown wide enough) can each have this
	// tile inside their own circle, and both are entitled to try. Nothing here arbitrates that: no
	// territory contest, no priority by whose reach is bigger or older (VISION's "expansion &
	// borders" is deliberately parked). The occupancy check right below is what actually decides an
	// overlap — first come, first served, the same as anywhere else on the map.
	if (!withinReach(x, y, await reachOf(tx, playerId)))
		return { ok: false, reason: 'OUTSIDE_REACH' };

	// VISION #4's reversal: a tile is a physical place again, world-wide — these two checks used to
	// be scoped to `playerId` (each visitor's own isolated sandbox on the shared map, an interim
	// testing override) and are not any more, so `TILE_OCCUPIED` now fires across realms: someone
	// else's building, or someone else's build already under way, blocks yours exactly as your own
	// would. `building_tile_idx` carries the same change at the DB level.
	const [existing] = await tx
		.select()
		.from(building)
		.where(and(eq(building.x, x), eq(building.y, y)));
	if (existing) return { ok: false, reason: 'TILE_OCCUPIED' };

	// Unfinished builds count as occupancy too, or two orders stack on one tile — *including*
	// queued ones, which hold their tile while they wait. Gathers don't: a worker standing on a
	// tile is not a thing built on it, and refusing to build where someone happens to be foraging
	// would be a rule nobody could guess.
	const [pending] = await tx
		.select()
		.from(operation)
		.where(
			and(
				ne(operation.status, 'completed'),
				eq(operation.type, 'build'),
				eq(operation.destX, x),
				eq(operation.destY, y)
			)
		);
	if (pending) return { ok: false, reason: 'TILE_OCCUPIED' };

	// The best builders, not merely the first idle bodies — a skilled worker builds faster and
	// better (both fold into the numbers below). Every build ranks by Construction.
	//
	// `crewSize` is a **maximum**: the order takes up to that many of the ranked idle bodies and
	// is happy with fewer. Asking for four when two are free starts with two — waiting for the
	// full four would be a second kind of waiting, and nothing asks for one.
	// Nobody qualifying is no longer a refusal: the build waits. An unsatisfiable filter and a
	// realm where everyone is busy are the same situation, and both resolve themselves the moment a
	// worker frees — so NO_IDLE_CHARACTER has left the build path entirely (gather still uses it,
	// because a gather has nothing to wait on).
	const ranked = await rankIdleWorkers(tx, playerId, await constructionSkillId(tx), allowed);
	const crew = ranked.slice(0, wanted);

	// Cost is judged last and, in the writer, spent last: a refusal on any earlier ground has
	// to leave stock untouched. The estimate runs the same check and simply doesn't spend, so
	// "you can't afford this" is a preview answer rather than a surprise at the button.
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

	// Every member walks their own leg, from their own tile — so a crew necessarily arrives
	// staggered, and each arrival is already known here. The grid loaded for the buildable
	// check is the same one the paths are priced against: one read, many uses.
	const solved = solveCrew(crew, type.buildSeconds, x, y, movementCostIn(grid));

	return {
		ok: true,
		plan: {
			crew: solved.crew,
			// Whole seconds, because that is what the preview shows and what the wire carries;
			// quoting 320.94 and stamping 320.94 would still read as a mismatch to anyone
			// comparing the two on screen.
			seconds: solved.seconds,
			quality: solved.quality,
			costs: costs.map((c) => ({ resourceId: c.resourceId, quantity: c.quantity })),
			settlementId: home.id,
			allowed,
			crewSize: wanted
		}
	};
}

/**
 * Writes a crew's membership rows, each with its own route and its own arrival. Every timestamp is
 * computed by Postgres, so the client's interpolation is exact by construction — Node's clock never
 * stamps anything.
 */
async function insertCrew(tx: Tx, operationId: number, crew: BuildPlan['crew']): Promise<void> {
	await tx.insert(operationWorker).values(
		crew.map((m) => ({
			operationId,
			characterId: m.character.id,
			qualityMultiplier: m.multiplier,
			path: m.path,
			arrivesAt: sql`now() + ${`${m.arrivesAt} seconds`}::interval`
		}))
	);
}

/**
 * Places a build: the plan above, then the writes it implies — the cost spent, the operation, and
 * one membership row per member of the crew.
 *
 * Deducted at order rather than on completion: there is a cancel path that refunds in full, and a
 * charge that failed at completion would fail silently while the player was away, which is exactly
 * when completion happens.
 */
export async function createBuildOrder(
	playerId: number,
	x: number,
	y: number,
	buildingTypeId: number,
	crewSize: number = 1,
	allowedProfessionIds: number[] | null = null
): Promise<OrderResult> {
	return db.transaction(async (tx): Promise<OrderResult> => {
		// An order is a read-then-write: without this it could be rejected as NO_IDLE_CHARACTER
		// by an operation that finished ten seconds ago, or judged against stale stock.
		await resolveWorld(tx, playerId);

		const planned = await planBuild(
			tx,
			playerId,
			x,
			y,
			buildingTypeId,
			crewSize,
			allowedProfessionIds
		);
		if (!planned.ok) return { ok: false, reason: planned.reason };
		const { crew, seconds, quality, costs, settlementId, allowed, crewSize: wanted } = planned.plan;

		for (const c of costs) {
			await tx
				.update(stock)
				.set({ quantity: sql`${stock.quantity} - ${c.quantity}` })
				.where(and(eq(stock.settlementId, settlementId), eq(stock.resourceId, c.resourceId)));
		}

		// No crew means nobody qualified, so the build waits: it holds its tile and the cost it has
		// already paid, remembers how many bodies it wanted and who may work it, and `resolveWorld`
		// starts it the moment a worker frees. Reserving the cost now rather than at start is what
		// keeps it from failing silently while the player is away — the same reasoning the
		// pay-at-order model rests on.
		const queued = crew.length === 0;
		const [op] = await tx
			.insert(operation)
			.values({
				playerId,
				type: 'build',
				status: queued ? 'queued' : 'in-progress',
				destX: x,
				destY: y,
				buildingTypeId,
				// The crew's combined workmanship. Duration is baked into `complete_at` and no longer
				// divides by this — for a one-member crew the two are the same number anyway. A queued
				// build has no crew yet, so it keeps the column's default until it starts.
				...(queued ? {} : { qualityMultiplier: quality! }),
				allowedProfessionIds: allowed,
				crewSize: wanted,
				startedAt: queued ? null : sql`now()`,
				completeAt: queued ? null : sql`now() + ${`${seconds} seconds`}::interval`
			})
			.returning({ id: operation.id });
		if (!queued) await insertCrew(tx, op.id, crew);

		return { ok: true, world: await readWorld(tx, playerId) };
	});
}

/**
 * What an order *would* do, without doing it — the Lands of Lords complaint answered: you see the
 * time and the workmanship before you spend anything, and they change as you change the crew.
 *
 * Runs `resolveWorld` first like every writer, so the idle set is not stale. Idle bodies don't move
 * on their own, so a quote holds until you act on it; a build completing in between can only free
 * *more* workers, which means the outcome can beat the quote but never miss it.
 */
export async function estimateBuild(
	playerId: number,
	x: number,
	y: number,
	buildingTypeId: number,
	crewSize: number = 1,
	allowedProfessionIds: number[] | null = null
): Promise<EstimateResult> {
	return db.transaction(async (tx): Promise<EstimateResult> => {
		await resolveWorld(tx, playerId);
		const planned = await planBuild(
			tx,
			playerId,
			x,
			y,
			buildingTypeId,
			crewSize,
			allowedProfessionIds
		);
		if (!planned.ok) return { ok: false, reason: planned.reason };
		const { crew, seconds, quality } = planned.plan;
		return {
			ok: true,
			estimate: {
				seconds,
				quality,
				crew: crew.map((m) => ({
					characterId: m.character.id,
					name: m.character.name,
					professionId: m.character.professionId
				}))
			}
		};
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

		// Same gate `planBuild` runs, same reason: the reach is a sphere of influence over both what
		// you may raise and what you may take, not a building permit alone.
		if (!withinReach(x, y, await reachOf(tx, playerId)))
			return { ok: false, reason: 'OUTSIDE_REACH' };

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
			? ((await rankIdleWorkers(tx, playerId, yielded.skillId))[0] ?? null)
			: await (async () => {
					const [c] = await tx
						.select()
						.from(character)
						.where(
							and(
								eq(character.playerId, playerId),
								notInArray(character.id, busyCharacterIds(tx, playerId))
							)
						)
						.limit(1);
					return c ? { character: c, multiplier: 1 } : null;
				})();
		if (!pick) return { ok: false, reason: 'NO_IDLE_CHARACTER' };
		const idle = pick.character;

		const grid = await loadGrid(tx, playerId);
		const walk = route(idle.x, idle.y, x, y, idle.speed, movementCostIn(grid), GRID_SIZE);
		const travel = walk.seconds;
		const [op] = await tx
			.insert(operation)
			.values({
				playerId,
				type: 'gather',
				status: 'in-progress',
				destX: x,
				destY: y,
				buildingTypeId: null,
				// Snapshotted so the gather runs at the pace it began — skills are fixed once assigned.
				qualityMultiplier: pick.multiplier,
				startedAt: sql`now()`,
				// Never finishes on its own.
				completeAt: null,
				// Work starts on arrival. Distance therefore costs the trip and nothing else — two
				// identical forests pay the same however far apart they are.
				accruedAt: sql`now() + ${`${travel} seconds`}::interval`
			})
			.returning({ id: operation.id });
		await tx.insert(operationWorker).values({
			operationId: op.id,
			characterId: idle.id,
			qualityMultiplier: pick.multiplier,
			path: walk.path,
			arrivesAt: sql`now() + ${`${travel} seconds`}::interval`
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

		// No reach gate here either, for the same reason a craft has none: a School is a building, so
		// standing here already proves this tile is inside the reach.

		// A settler specifically — a specialist is already trained, and this is what makes holding
		// one back a real choice. Idle (in no in-progress operation) and profession-less.
		const [settler] = await tx
			.select()
			.from(character)
			.where(
				and(
					eq(character.playerId, playerId),
					isNull(character.professionId),
					notInArray(character.id, busyCharacterIds(tx, playerId))
				)
			)
			.limit(1);
		if (!settler) return { ok: false, reason: 'NO_IDLE_SETTLER' };

		const grid = await loadGrid(tx, playerId);
		const walk = route(settler.x, settler.y, x, y, settler.speed, movementCostIn(grid), GRID_SIZE);
		const travel = walk.seconds;
		const [op] = await tx
			.insert(operation)
			.values({
				playerId,
				type: 'train',
				status: 'in-progress',
				destX: x,
				destY: y,
				buildingTypeId: null,
				professionId,
				startedAt: sql`now()`,
				// Edge-triggered: finishes on its own once travel plus the training time is up.
				completeAt: sql`now() + ${`${travel + TRAIN_SECONDS} seconds`}::interval`
			})
			.returning({ id: operation.id });
		await tx.insert(operationWorker).values({
			operationId: op.id,
			characterId: settler.id,
			// A training has no workmanship of its own — the settler is the work, not the worker.
			qualityMultiplier: 1,
			path: walk.path,
			arrivesAt: sql`now() + ${`${travel} seconds`}::interval`
		});

		return { ok: true, world: await readWorld(tx, playerId) };
	});
}

/** A batch as it *would* happen — a build plan, plus the workshop whose recipe it runs. */
export type CraftPlan = BuildPlan & { buildingTypeId: number };
export type CraftPlanResult = { ok: true; plan: CraftPlan } | { ok: false; reason: OrderReason };

/**
 * Everything ordering a batch decides, and none of what it writes — `planBuild`'s twin, refusals as
 * values for the same reason.
 *
 * A batch *is* a build in all but its ending, so it reuses that path wholesale: the same crew
 * ranking, the same `solveCrew` arithmetic, the same pay-in-full-at-order model. Two things differ.
 * The type is not chosen — the building standing on the tile is the recipe, so there is nothing for
 * a client to name and nothing for it to get wrong. And the crew is ranked by the **output
 * resource's** skill, which is the whole of "a Carpenter makes planks faster than a settler": no
 * rule anywhere says so, `resource.skill_id` does.
 *
 * The caller must have run `resolveWorld` first, same as `planBuild` — a stale idle set would send
 * a worker who is already busy.
 */
async function planCraft(
	tx: Tx,
	playerId: number,
	x: number,
	y: number,
	crewSize: number,
	allowedProfessionIds: number[] | null | undefined
): Promise<CraftPlanResult> {
	// Both normalised exactly as `planBuild` does them — a crew size is a dial, and an empty filter
	// is a player who unchecked everything rather than one who wants nobody.
	const wanted = Number.isFinite(crewSize) ? Math.max(1, Math.floor(crewSize)) : 1;
	const allowed = allowedProfessionIds?.length ? allowedProfessionIds : null;

	if (!Number.isInteger(x) || !Number.isInteger(y)) return { ok: false, reason: 'OUT_OF_BOUNDS' };
	if (x < 0 || y < 0 || x >= GRID_SIZE || y >= GRID_SIZE)
		return { ok: false, reason: 'OUT_OF_BOUNDS' };

	// An array element takes no foreign key, so a filter naming a profession that doesn't exist has
	// to fail loudly here — see the column comment and `planBuild`'s copy of this check.
	if (allowed) {
		const known = new Set(
			(await tx.select({ id: profession.id }).from(profession)).map((p) => p.id)
		);
		if (allowed.some((id) => !known.has(id))) return { ok: false, reason: 'UNKNOWN_PROFESSION' };
	}

	// A building you own, standing on this tile, whose type carries a recipe. All three failures are
	// one reason on purpose: a building that isn't yours must not be distinguishable from one that
	// isn't there (the same argument NOT_A_ROAD makes).
	const [shop] = await tx
		.select({
			buildingTypeId: buildingType.id,
			producesResourceId: buildingType.producesResourceId,
			craftSeconds: buildingType.craftSeconds
		})
		.from(building)
		.innerJoin(buildingType, eq(building.buildingTypeId, buildingType.id))
		.where(and(eq(building.playerId, playerId), eq(building.x, x), eq(building.y, y)));
	if (!shop || shop.producesResourceId === null || shop.craftSeconds === null)
		return { ok: false, reason: 'NOT_A_WORKSHOP' };

	// No reach gate here, deliberately — unlike `planBuild` and `assignWorker`. A batch runs at a
	// workshop, and a workshop is a building, so if one stands on this tile the reach already let it
	// be built. A second check would be guarding a case that cannot arise.

	// One batch at a time. Without this a Sawmill is not a bottleneck — you would build one and run
	// six batches through it at once, and there would be no reason for the catalog to grow.
	// Queued as well as in-progress: a batch waiting for a crafter is still this workshop's batch.
	//
	// The build path needs no matching change: its own occupancy probe filters `type = 'build'`, so
	// a batch never blocks a build, and a tile with a building on it already refuses one.
	const [running] = await tx
		.select({ id: operation.id })
		.from(operation)
		.where(
			and(
				eq(operation.playerId, playerId),
				ne(operation.status, 'completed'),
				eq(operation.type, 'craft'),
				eq(operation.destX, x),
				eq(operation.destY, y)
			)
		);
	if (running) return { ok: false, reason: 'WORKSHOP_BUSY' };

	// The inputs, judged in full before anything is spent — a two-resource recipe can't half-pay.
	// Judged *before* the crew, unlike a build: "you don't have the materials" is a standing fact
	// about the realm, while "everyone is busy" is a minute old, and the standing one is the more
	// useful sentence when both are true.
	const costs = await tx
		.select()
		.from(recipeInput)
		.where(eq(recipeInput.buildingTypeId, shop.buildingTypeId));
	const [home] = await tx.select().from(settlement).where(eq(settlement.playerId, playerId));
	if (!home) throw new Error(`player ${playerId} has no settlement`);
	const held = new Map(
		(await tx.select().from(stock).where(eq(stock.settlementId, home.id))).map((s) => [
			s.resourceId,
			s.quantity
		])
	);
	if (costs.some((c) => (held.get(c.resourceId) ?? 0) < c.quantity))
		return { ok: false, reason: 'INSUFFICIENT_RESOURCES' };

	// The skill that *produces* the output — gathered or made, one column either way. A resource
	// with none is an unseeded catalog rather than a game rule, so it throws like the others.
	const [out] = await tx
		.select({ skillId: resource.skillId })
		.from(resource)
		.where(eq(resource.id, shop.producesResourceId));
	if (!out?.skillId)
		throw new Error(
			`resource ${shop.producesResourceId} is produced by a recipe but has no skill — ` +
				'run `npm run seed` against this database'
		);

	// Nobody free is not a refusal: the batch waits, exactly as a build does. Refusing would lose
	// the reservation — the inputs are taken at order time, so a queued batch holds its wood the way
	// a queued build holds its cost, and a player told to come back later would be retrying against
	// stock something else may have spent in the meantime.
	const ranked = await rankIdleWorkers(tx, playerId, out.skillId, allowed);
	const crew = ranked.slice(0, wanted);

	// `craft_seconds` is ideal effort, the same units as `build_seconds` — so a crew divides it by
	// its own pace through exactly the arithmetic a build uses, travel included.
	const grid = await loadGrid(tx, playerId);
	const solved = solveCrew(crew, shop.craftSeconds, x, y, movementCostIn(grid));

	return {
		ok: true,
		plan: {
			crew: solved.crew,
			seconds: solved.seconds,
			quality: solved.quality,
			costs: costs.map((c) => ({ resourceId: c.resourceId, quantity: c.quantity })),
			settlementId: home.id,
			allowed,
			crewSize: wanted,
			buildingTypeId: shop.buildingTypeId
		}
	};
}

/**
 * Orders a batch at a workshop: the plan above, then the writes it implies — the inputs spent, the
 * operation, and one membership row per member of the crew.
 *
 * Inputs leave stock at order time, not on completion, for the same reason a build's cost does:
 * there is a cancel path that refunds in full, and a charge that failed at completion would fail
 * silently while the player was away — which is exactly when completion happens.
 */
export async function createCraftOrder(
	playerId: number,
	x: number,
	y: number,
	crewSize: number = 1,
	allowedProfessionIds: number[] | null = null
): Promise<OrderResult> {
	return db.transaction(async (tx): Promise<OrderResult> => {
		await resolveWorld(tx, playerId);

		const planned = await planCraft(tx, playerId, x, y, crewSize, allowedProfessionIds);
		if (!planned.ok) return { ok: false, reason: planned.reason };
		const {
			crew,
			seconds,
			quality,
			costs,
			settlementId,
			allowed,
			crewSize: wanted,
			buildingTypeId
		} = planned.plan;

		for (const c of costs) {
			await tx
				.update(stock)
				.set({ quantity: sql`${stock.quantity} - ${c.quantity}` })
				.where(and(eq(stock.settlementId, settlementId), eq(stock.resourceId, c.resourceId)));
		}

		// No crew means nobody qualified, so the batch waits: it holds the workshop and the inputs it
		// has already paid, remembers how many bodies it wanted and who may work it, and
		// `resolveWorld` starts it the moment a crafter frees. This is the epic's offline promise —
		// order it and walk away.
		const queued = crew.length === 0;
		const [op] = await tx
			.insert(operation)
			.values({
				playerId,
				type: 'craft',
				status: queued ? 'queued' : 'in-progress',
				destX: x,
				destY: y,
				// The workshop, not something being raised — this is how completion finds the recipe.
				buildingTypeId,
				// How well the batch was made. Nothing reads it yet, but a completed operation is kept
				// forever, so every batch already carries a permanent record of its own workmanship —
				// which is the thing that could not be reconstructed afterwards. A queued batch has no
				// crew yet, so it keeps the column's default until it starts.
				...(queued ? {} : { qualityMultiplier: quality! }),
				allowedProfessionIds: allowed,
				crewSize: wanted,
				startedAt: queued ? null : sql`now()`,
				completeAt: queued ? null : sql`now() + ${`${seconds} seconds`}::interval`
			})
			.returning({ id: operation.id });
		if (!queued) await insertCrew(tx, op.id, crew);

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
			.where(
				inArray(
					character.id,
					tx
						.select({ id: operationWorker.characterId })
						.from(operationWorker)
						.where(eq(operationWorker.operationId, op.id))
				)
			);

		return { ok: true, world: await readWorld(tx, playerId) };
	});
}

/**
 * Cancels an unfinished build or craft batch and refunds its full charge. Unlike `recallWorker` —
 * which marks a gather completed so the worker is paid out and left standing — a cancelled order
 * must **delete** the operation row: a lingering in-progress one becomes a building, or a payout,
 * on the next `resolveWorld` read. Deleting frees the worker and the tile automatically, since
 * every occupancy check keys on the unfinished op.
 *
 * The refund is the order-time deduction run with `+` instead of `-`, always in full — payment was
 * taken in full at order and never prorated, so the return is too.
 *
 * **The two refundable types, and only those.** Widening this to "anything not completed" would let
 * `DELETE /api/orders/<a-gather-id>` delete a working gather: it would find no cost rows for its
 * null `building_type_id`, refund nothing, and free the body with none of `recallWorker`'s
 * semantics. A gather is recalled, not cancelled.
 *
 * **Delete-first, refund-only-on-RETURNING.** A double-clicked Cancel sends two DELETEs; a
 * select-then-refund-then-delete order would let both refund one order (a trivially-triggered
 * resource dupe). So the `DELETE … RETURNING` is the single point that picks a winner: exactly one
 * racer gets the row back and refunds, the loser gets nothing and returns `UNKNOWN_OPERATION`.
 * (`recallWorker`'s status-flip is idempotent enough to skip this; a refund is not.)
 */
export async function cancelOrder(playerId: number, operationId: number): Promise<OrderResult> {
	return db.transaction(async (tx): Promise<OrderResult> => {
		// resolveWorld may complete this very order first (turning it into a building, or into
		// stock), or start a queued one; either way the delete below matches on "not completed", so
		// one that finished while the player was deciding is correctly refused rather than refunded.
		await resolveWorld(tx, playerId);

		const [cancelled] = await tx
			.delete(operation)
			.where(
				and(
					eq(operation.id, operationId),
					eq(operation.playerId, playerId),
					// Queued as well as in-progress: an order you have got tired of waiting for is
					// exactly the one you want to take back, and the refund is identical either way.
					ne(operation.status, 'completed'),
					inArray(operation.type, ['build', 'craft'])
				)
			)
			.returning({ type: operation.type, buildingTypeId: operation.buildingTypeId });
		if (!cancelled) return { ok: false, reason: 'UNKNOWN_OPERATION' };

		const [home] = await tx.select().from(settlement).where(eq(settlement.playerId, playerId));
		if (!home) throw new Error(`player ${playerId} has no settlement`);
		await refundOrder(tx, home.id, cancelled.type, cancelled.buildingTypeId!);

		return { ok: true, world: await readWorld(tx, playerId) };
	});
}

/**
 * Restyles a road: which of its arms are drawn. Cosmetic, and the only write in this file that
 * changes nothing about how the world behaves — a road is cheap to cross whichever way it is drawn.
 *
 * The mask is stored as given (within 0–15, which the DB also holds) rather than validated against
 * the tile's real neighbours, because rendering intersects it with them anyway: an override can only
 * hide an arm, and one whose road is later torn up stops claiming it by itself. Validating here
 * would be a second, weaker copy of that rule that goes stale the moment the map changes.
 */
export async function restyleRoad(
	playerId: number,
	buildingId: number,
	roadMask: number | null
): Promise<OrderResult> {
	if (roadMask !== null && (!Number.isInteger(roadMask) || roadMask < 0 || roadMask > 15))
		return { ok: false, reason: 'NOT_A_ROAD' };
	return db.transaction(async (tx) => {
		await resolveWorld(tx, playerId);
		// One statement decides both questions the verb can fail on — yours, and a road — because a
		// building you do not own must not even be confirmed to exist.
		const [changed] = await tx
			.update(building)
			.set({ roadMask })
			.where(
				and(
					eq(building.id, buildingId),
					eq(building.playerId, playerId),
					inArray(
						building.buildingTypeId,
						tx
							.select({ id: buildingType.id })
							.from(buildingType)
							.where(sql`${buildingType.movementCost} IS NOT NULL`)
					)
				)
			)
			.returning({ id: building.id });
		if (!changed) return { ok: false, reason: 'NOT_A_ROAD' };

		return { ok: true, world: await readWorld(tx, playerId) };
	});
}

/** The world as stored, plus the DB's own `now` — the only clock anything trusts. */
/**
 * The never-changing half of the wire payload — terrain, catalogs, costs and recipes, everything
 * that only moves when `npm run seed` runs. This is the half `loadStaticWorld`'s own comment names
 * as the egress problem: what used to be a 5M-row database read is now generated, hash-verified
 * against `game_config`, and held behind the shared memo — a cache hit here costs one tiny
 * `game_config` read, not 238 MB.
 *
 * Two callers: folded into `readWorld` below for the mutation endpoints, which still return one
 * composed `WorldPayload` the client fully replaces its state with — and served standalone by
 * `GET /api/world/static/[version]`, whose year-long immutable CDN response is what lets a whole
 * fleet of lambda instances share one answer instead of each warming its own memo.
 */
export async function readWorldStatic(tx: Tx): Promise<WorldStatic> {
	// `terrainIds` is already dense and terrain-hash-verified by `loadStaticWorld` — one source of
	// that invariant rather than a second copy of the check here. `Array.from` turns the compact
	// typed array back into the plain `number[]` the wire type promises (JSON has no typed-array
	// notion).
	const { terrainIds, capacityByType } = await loadStaticWorld(tx);
	// Ordered, because the client picks a default from this list by position.
	const types = await tx.select().from(buildingType).orderBy(asc(buildingType.id));
	const costs = await tx.select().from(buildingCost);
	// `building_cost`'s twin: what one batch consumes at each workshop.
	const recipes = await tx.select().from(recipeInput);
	// Terrain and resources are global catalogs, unfiltered by player — same split as
	// buildingTypes. The ground is the world's, not yours. Small tables, so read fresh rather than
	// folded into the memo — the memo exists for the grid, which is the one thing here that's large.
	const terrainTypes = await tx.select().from(terrainType);
	const resources = await tx.select().from(resource);
	// Professions the School offers — a global catalog like building types, ordered so the Train
	// picker doesn't reshuffle between reads.
	const professions = await tx.select().from(profession).orderBy(asc(profession.id));

	const terrain: number[] = Array.from(terrainIds);

	return {
		gridSize: GRID_SIZE,
		terrain,
		terrainTypes: terrainTypes.map((t) => ({
			id: t.id,
			displayName: t.displayName,
			color: t.color,
			icon: t.icon,
			buildable: t.buildable,
			yieldsResourceId: t.yieldsResourceId,
			// The same rule the server gate runs, shipped per terrain so the menu offers only what
			// the writer would accept — a menu that lists what the server refuses is the bug this epic exists to kill.
			buildableTypeIds: eligibleTypeIds(t, types, resources),
			capacity: capacityByType.get(t.id) ?? null
		})),
		resources: resources.map((r) => ({ id: r.id, displayName: r.displayName, icon: r.icon })),
		professions: professions.map((p) => ({ id: p.id, displayName: p.displayName })),
		buildingCosts: costs.map((c) => ({
			buildingTypeId: c.buildingTypeId,
			resourceId: c.resourceId,
			quantity: c.quantity
		})),
		recipeInputs: recipes.map((r) => ({
			buildingTypeId: r.buildingTypeId,
			resourceId: r.resourceId,
			quantity: r.quantity
		})),
		buildingTypes: types.map((t) => ({
			id: t.id,
			displayName: t.displayName,
			icon: t.icon,
			buildSeconds: t.buildSeconds,
			housingCapacity: t.housingCapacity,
			movementCost: t.movementCost,
			requiresBuildingTypeId: t.requiresBuildingTypeId,
			// All three or none — non-null is what makes this type a workshop, and the client reads
			// exactly that to decide whether a tile offers "Make 10 Planks".
			producesResourceId: t.producesResourceId,
			outputQuantity: t.outputQuantity,
			craftSeconds: t.craftSeconds
		}))
	};
}

/**
 * The per-player half of the wire payload — everything that moves on this player's own writes, or
 * with the clock. `GET /api/world` ships this half alone (see `loadWorldLive`); the mutation
 * endpoints still compose it with `readWorldStatic` into one `WorldPayload` (see `readWorld`
 * below), because a build order or a training already returns a full replacement for `world` on
 * the client and there is no version-mismatch question to ask there.
 */
export async function readWorldLive(tx: Tx, playerId: number): Promise<WorldLive> {
	const [{ now }] = await tx.execute<{ now: Date }>(sql`select now() as now`);
	// The circle MapCanvas draws and world.server.ts's own gates enforce, from the same three
	// numbers — see reachOf's own comment for why a missing Marketplace throws rather than shipping
	// a silent radius of 0.
	const reach = await reachOf(tx, playerId);
	const [cfg] = await tx.select().from(gameConfig);
	if (!cfg || cfg.worldVersion === null)
		throw new Error('no world_version in game_config — run `npm run seed` against this database');
	const held = await tx
		.select({ resourceId: stock.resourceId, quantity: stock.quantity })
		.from(stock)
		.innerJoin(settlement, eq(stock.settlementId, settlement.id))
		.where(eq(settlement.playerId, playerId))
		// Ordered, because the resource bar is rendered in payload order and an unordered join
		// is free to hand back a different one on every read — a bar that reshuffles itself.
		.orderBy(asc(stock.resourceId));
	// The static grid's live twin: deposits is content (what a tile yields, how fast), pulled from
	// the same shared memo readWorldStatic uses — only what is drawn down from it (below) is
	// per-player.
	const { deposits } = await loadStaticWorld(tx);
	// A resource catalog read of its own, distinct from readWorldStatic's wire-shaped one: this one
	// needs isSustenance for the food-rate calculation below, which never goes on the wire itself.
	const resources = await tx.select().from(resource);
	const drawn = await tx.select().from(tileStock).where(eq(tileStock.playerId, playerId));
	// PUBLIC now (VISION #4's reversal) — every realm's buildings, not just this player's, because
	// what stands on the map is a fact about the map. Cheap at today's scale (~680 rows across 167
	// realms — see the type's own comment); ponytail: a full read, not a viewport-scoped one — cull
	// to the client's visible tiles the day the building count actually makes this read heavy.
	const buildings = await tx.select().from(building);
	// PUBLIC, same reasoning: every realm's anchor and whose it is.
	const settlements = await tx
		.select({ x: settlement.x, y: settlement.y, playerId: settlement.playerId })
		.from(settlement);
	const characters = await tx.select().from(character).where(eq(character.playerId, playerId));
	const operations = await tx
		.select()
		.from(operation)
		// Not 'in-progress' but "not finished": a queued build has to reach the client so the tile
		// can show that something is waiting there, and so it can be cancelled.
		.where(and(eq(operation.playerId, playerId), ne(operation.status, 'completed')));
	// The crews, grouped by operation. One read for all of them rather than one per operation.
	const crews = new Map<number, (typeof operationWorker.$inferSelect)[]>();
	if (operations.length) {
		const rows = await tx
			.select()
			.from(operationWorker)
			.where(
				inArray(
					operationWorker.operationId,
					operations.map((o) => o.id)
				)
			);
		for (const r of rows) crews.set(r.operationId, [...(crews.get(r.operationId) ?? []), r]);
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
	// Only the tiles this player has actually drawn from. Everything else is still at its terrain
	// type's capacity, which the client already holds on the static payload, so saying so per tile
	// is saying the same thing hundreds of thousands of times.
	//
	// This used to be a dense grid-length array, and the comment on `WorldLive.drawnTiles` explains
	// why that was the right call when the world was 128×128 — 16 KB, and dense is the arrangement
	// that cannot be got wrong. At 1024×1024 the same array measured **4.599 MB of a 4.60 MB
	// response**, 99.98% of the payload, 321,937 of its million entries saying nothing but "this
	// forest is untouched", on every thirty-second heartbeat. `tile_stock` holds dozens of rows.
	// That is the measurement the old note said to wait for.
	const drawnTiles: { i: number; quantity: number }[] = [];
	for (const [i, quantity] of live) {
		const d = deposits.get(i);
		// Only finite deposits count down. An infinite one has nothing to report, and a drawn row
		// against one would be a tile_stock entry the gather path should never have written.
		if (!d || d.capacity === null || d.regrowSeconds === null) continue;
		drawnTiles.push({ i, quantity });
	}

	// Which way each stock is moving. Every input is already in hand except the per-capita food
	// rate, and it is read from the same singleton row the drain in resolveWorld charges from.
	const sustenance = resources.find((r) => r.isSustenance);
	const rates = netRates(
		operations
			.filter((o) => o.type === 'gather')
			.flatMap((o) => {
				const yielded = deposits.get(o.destY * GRID_SIZE + o.destX);
				// A tile whose terrain stopped yielding under a standing worker — resolveWorld pays
				// nothing for it, so neither does the bar.
				if (!yielded) return [];
				return [
					{
						resourceId: yielded.resourceId,
						unitsPerHour: yielded.unitsPerHour,
						qualityMultiplier: o.qualityMultiplier,
						arrivals: (crews.get(o.id) ?? []).map((w) => w.arrivesAt.getTime())
					}
				];
			}),
		nowMs,
		sustenance
			? {
					resourceId: sustenance.id,
					perCapitaHour: cfg.foodPerCapitaHour,
					population: characters.length
				}
			: null
	);

	return {
		now: new Date(now).toISOString(),
		worldVersion: cfg.worldVersion,
		playerId,
		reach,
		drawnTiles,
		stock: held.map((s) => ({ ...s, ratePerHour: rates.get(s.resourceId) ?? 0 })),
		buildings: buildings.map((b) => ({
			id: b.id,
			x: b.x,
			y: b.y,
			buildingTypeId: b.buildingTypeId,
			playerId: b.playerId,
			// Workmanship is your ledger, not the ground — null it out on a building you don't own,
			// the same "public position, private detail" split the type's own comment describes.
			quality: b.playerId === playerId ? b.quality : null,
			roadMask: b.roadMask
		})),
		settlements,
		characters: characters.map((c) => ({
			id: c.id,
			x: c.x,
			y: c.y,
			speed: c.speed,
			professionId: c.professionId,
			name: c.name,
			strength: c.strength,
			dexterity: c.dexterity,
			constitution: c.constitution,
			intelligence: c.intelligence
		})),
		operations: operations.map((o) => ({
			id: o.id,
			type: o.type,
			buildingTypeId: o.buildingTypeId,
			professionId: o.professionId,
			destX: o.destX,
			destY: o.destY,
			startedAt: o.startedAt?.toISOString() ?? null,
			// Null on a gather, and that is the wire's way of saying "this never ends by itself".
			completeAt: o.completeAt?.toISOString() ?? null,
			workers: (crews.get(o.id) ?? []).map((w) => ({
				characterId: w.characterId,
				path: w.path,
				arrivesAt: w.arrivesAt.toISOString()
			}))
		}))
	};
}

/** The world as stored, plus the DB's own `now` — the only clock anything trusts. Composed from
 * the static and live halves above; see their own comments for why each is its own function. */
export async function readWorld(tx: Tx, playerId: number): Promise<WorldPayload> {
	const staticHalf = await readWorldStatic(tx);
	const liveHalf = await readWorldLive(tx, playerId);
	return { ...staticHalf, ...liveHalf };
}
