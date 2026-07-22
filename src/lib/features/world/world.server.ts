import { and, asc, eq, inArray, lte, notInArray, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import {
	building,
	buildingCost,
	buildingType,
	character,
	operation,
	player,
	resource,
	settlement,
	stock,
	terrainType,
	tile
} from '$lib/server/db/schema';
import { GRID_SIZE, travelSeconds, type OrderReason, type WorldPayload } from './world';

// Where a new sandbox starts. Every player gets the same coordinates because they never
// see each other (VISION #4 interim override) — the hamlet, the barn beside it, and a builder.
const START = {
	hamletX: 7,
	hamletY: 8,
	barnX: 8,
	barnY: 8,
	characterX: 7,
	characterY: 9,
	speed: 0.5
};

// A grubstake, so a fresh realm can afford its first House before there is any way to
// gather one. Deliberate scaffolding: it goes to nothing the moment gathering exists.
// ponytail: keyed by display name because resource ids are seeded serials and this constant
// outlives none of them — it is deleted next slice.
const STARTING_STOCK: Record<string, number> = { Wood: 10 };

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
		const [found] = await db.select({ id: player.id }).from(player).where(eq(player.id, id));
		if (found) return { playerId: found.id, worldReset: false };
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
		// deduction is then an UPDATE that either matches a row or does not, with no upsert and
		// no "is this a new resource or an empty one" question at the till.
		await tx.insert(stock).values(
			resources.map((r) => ({
				settlementId: s.id,
				resourceId: r.id,
				quantity: STARTING_STOCK[r.displayName] ?? 0
			}))
		);
		await tx.insert(building).values([
			{ playerId: p.id, x: START.hamletX, y: START.hamletY, buildingTypeId: house.id },
			// The barn stores nothing yet and gates nothing — with no capacity there is nothing
			// for it to read. It is here so "where your stock lives" is a place on the map, and
			// it is the row capacity will hang off when it arrives.
			{ playerId: p.id, x: START.barnX, y: START.barnY, buildingTypeId: barn.id }
		]);
		await tx.insert(character).values({
			playerId: p.id,
			x: START.characterX,
			y: START.characterY,
			speed: START.speed
		});
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
		await tx.delete(settlement).where(eq(settlement.playerId, playerId));
		await tx.delete(player).where(eq(player.id, playerId));
	});
}

export async function loadWorld(playerId: number): Promise<WorldPayload> {
	return db.transaction(async (tx) => {
		await resolveOperations(tx, playerId);
		return readWorld(tx, playerId);
	});
}

/**
 * The single seam where the stored world catches up to now. Reads run through it, so a GET
 * performs writes and what is stored always reflects reality — nothing is computed in memory
 * and thrown away.
 *
 * ponytail: the settlement row is a per-player lock — coarse, and taken on reads as well as
 * writes. Narrow it when a settlement has more than one owner.
 */
export async function resolveOperations(tx: Tx, playerId: number): Promise<void> {
	// Every read-modify-write for this player queues behind this one row. It cannot be the
	// `FOR UPDATE` below instead: that one locks only operations already due, so with nothing
	// due it names an empty set and Postgres locks nothing — two orders placed at the same
	// moment would both read the same stock and both spend it.
	await tx
		.select({ id: settlement.id })
		.from(settlement)
		.where(eq(settlement.playerId, playerId))
		.for('update');

	const due = await tx
		.select()
		.from(operation)
		.where(
			and(
				eq(operation.playerId, playerId),
				eq(operation.status, 'in-progress'),
				lte(operation.completeAt, sql`now()`)
			)
		)
		.for('update');

	for (const op of due) {
		await tx.update(operation).set({ status: 'completed' }).where(eq(operation.id, op.id));
		await tx.insert(building).values({
			playerId,
			x: op.destX,
			y: op.destY,
			buildingTypeId: op.buildingTypeId
		});
		await tx
			.update(character)
			.set({ x: op.destX, y: op.destY })
			.where(eq(character.id, op.characterId));
	}
}

export type OrderResult = { ok: true; world: WorldPayload } | { ok: false; reason: OrderReason };

/**
 * The grid a build order is judged against: what every tile is made of, keyed the same
 * row-major way the wire payload is. One 256-row read serves both the destination's
 * buildability and the cost of every tile the trip crosses — a point query plus a path query
 * would be two reads over the same rows.
 */
async function loadGrid(
	tx: Tx
): Promise<Map<number, { buildable: boolean; movementCost: number }>> {
	const rows = await tx
		.select({
			x: tile.x,
			y: tile.y,
			buildable: terrainType.buildable,
			movementCost: terrainType.movementCost
		})
		.from(tile)
		.innerJoin(terrainType, eq(tile.terrainTypeId, terrainType.id));
	return new Map(
		rows.map((r) => [
			r.y * GRID_SIZE + r.x,
			{ buildable: r.buildable, movementCost: r.movementCost }
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
		// by an operation that finished ten seconds ago.
		await resolveOperations(tx, playerId);

		if (!Number.isInteger(x) || !Number.isInteger(y)) return { ok: false, reason: 'OUT_OF_BOUNDS' };
		if (x < 0 || y < 0 || x >= GRID_SIZE || y >= GRID_SIZE)
			return { ok: false, reason: 'OUT_OF_BOUNDS' };

		const [type] = await tx.select().from(buildingType).where(eq(buildingType.id, buildingTypeId));
		if (!type) return { ok: false, reason: 'UNKNOWN_BUILDING_TYPE' };

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
		if (!groundAt(x, y).buildable) return { ok: false, reason: 'TILE_NOT_BUILDABLE' };

		// ponytail: occupancy is scoped to the player, so each visitor plays an isolated
		// sandbox on the shared map (VISION #4 interim override). Un-scope both of these —
		// and building_tile_idx — to restore world-global tile ownership.
		const [existing] = await tx
			.select()
			.from(building)
			.where(and(eq(building.playerId, playerId), eq(building.x, x), eq(building.y, y)));
		if (existing) return { ok: false, reason: 'TILE_OCCUPIED' };

		// In-progress operations count as occupancy too, or two orders stack on one tile.
		const [pending] = await tx
			.select()
			.from(operation)
			.where(
				and(
					eq(operation.playerId, playerId),
					eq(operation.status, 'in-progress'),
					eq(operation.destX, x),
					eq(operation.destY, y)
				)
			);
		if (pending) return { ok: false, reason: 'TILE_OCCUPIED' };

		const busy = tx
			.select({ id: operation.characterId })
			.from(operation)
			.where(and(eq(operation.playerId, playerId), eq(operation.status, 'in-progress')));
		const [idle] = await tx
			.select()
			.from(character)
			.where(and(eq(character.playerId, playerId), notInArray(character.id, busy)))
			.limit(1);
		if (!idle) return { ok: false, reason: 'NO_IDLE_CHARACTER' };

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
			startedAt: sql`now()`,
			travelDoneAt: sql`now() + ${`${travel} seconds`}::interval`,
			completeAt: sql`now() + ${`${travel + type.buildSeconds} seconds`}::interval`
		});

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
	const held = await tx
		.select({ resourceId: stock.resourceId, quantity: stock.quantity })
		.from(stock)
		.innerJoin(settlement, eq(stock.settlementId, settlement.id))
		.where(eq(settlement.playerId, playerId));
	const tiles = await tx.select().from(tile);
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

	return {
		now: new Date(now).toISOString(),
		gridSize: GRID_SIZE,
		terrainTypes: terrainTypes.map((t) => ({
			id: t.id,
			displayName: t.displayName,
			color: t.color,
			icon: t.icon,
			buildable: t.buildable,
			yieldsResourceId: t.yieldsResourceId
		})),
		resources: resources.map((r) => ({ id: r.id, displayName: r.displayName })),
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
			buildSeconds: t.buildSeconds
		})),
		buildings: buildings.map((b) => ({
			id: b.id,
			x: b.x,
			y: b.y,
			buildingTypeId: b.buildingTypeId
		})),
		characters: characters.map((c) => ({ id: c.id, x: c.x, y: c.y, speed: c.speed })),
		operations: operations.map((o) => ({
			id: o.id,
			characterId: o.characterId,
			buildingTypeId: o.buildingTypeId,
			originX: o.originX,
			originY: o.originY,
			destX: o.destX,
			destY: o.destY,
			startedAt: o.startedAt.toISOString(),
			travelDoneAt: o.travelDoneAt.toISOString(),
			completeAt: o.completeAt.toISOString()
		}))
	};
}
