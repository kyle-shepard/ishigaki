import { and, eq, lte, notInArray, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { building, buildingType, character, operation, player } from '$lib/server/db/schema';
import { GRID_SIZE, travelSeconds, type OrderReason, type WorldPayload } from './world';

// Where a new sandbox starts. Every player gets the same coordinates because they never
// see each other (VISION #4 interim override) — the hamlet and its builder, nothing else.
const START = { hamletX: 7, hamletY: 8, characterX: 7, characterY: 9, speed: 0.5 };

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Resolves the caller's sandbox, creating one on first visit. Returns the id to store in
 * the cookie.
 *
 * `id` is whatever the cookie claimed, and is not trusted: a reseed drops every player, so
 * a returning browser can hold an id that no longer exists. Verifying costs one primary-key
 * lookup and turns that case into a fresh world instead of a silently empty one — no
 * character, no hamlet, no error.
 *
 * ponytail: anyone holding a cookie can act as that player. There is no auth here at all;
 * guessing another integer is the whole attack. That is acceptable while the world is
 * disposable, and is what the accounts epic (VISION #10) replaces.
 */
export async function ensurePlayer(id: number | null): Promise<number> {
	if (id !== null) {
		const [found] = await db.select({ id: player.id }).from(player).where(eq(player.id, id));
		if (found) return found.id;
	}

	return db.transaction(async (tx) => {
		// The building catalog is global and seeded, not per-player. Without it there is no
		// hamlet to hand out, which is a broken deploy rather than a new-player problem.
		const [house] = await tx.select().from(buildingType).limit(1);
		if (!house) throw new Error('no building_type rows — run `npm run seed` against this database');

		const [p] = await tx.insert(player).values({}).returning();
		await tx.insert(building).values({
			playerId: p.id,
			x: START.hamletX,
			y: START.hamletY,
			buildingTypeId: house.id
		});
		await tx.insert(character).values({
			playerId: p.id,
			x: START.characterX,
			y: START.characterY,
			speed: START.speed
		});
		return p.id;
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
 * ponytail: FOR UPDATE over the player's whole in-progress set is a coarse lock. Fine at one
 * player; narrow it when contention is real.
 */
export async function resolveOperations(tx: Tx, playerId: number): Promise<void> {
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
 * Rejections come back as a value, not an exception: a try/catch around the handler would
 * map a mid-transaction DB failure onto a 400 the player reads as a game rule. Only these
 * four reasons produce a 400; anything thrown stays thrown.
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

		// Every timestamp is computed by Postgres in this one statement. Node's clock never
		// stamps anything, so the client's interpolation is exact by construction.
		const travel = travelSeconds(idle.x, idle.y, x, y, idle.speed);
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
	const types = await tx.select().from(buildingType);
	const buildings = await tx.select().from(building).where(eq(building.playerId, playerId));
	const characters = await tx.select().from(character).where(eq(character.playerId, playerId));
	const operations = await tx
		.select()
		.from(operation)
		.where(and(eq(operation.playerId, playerId), eq(operation.status, 'in-progress')));

	return {
		now: new Date(now).toISOString(),
		gridSize: GRID_SIZE,
		buildingTypes: types.map((t) => ({
			id: t.id,
			displayName: t.displayName,
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
