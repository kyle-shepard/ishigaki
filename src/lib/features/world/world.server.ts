import { and, eq, notInArray, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { building, buildingType, character, operation } from '$lib/server/db/schema';
import { GRID_SIZE, travelSeconds, type OrderReason, type WorldPayload } from './world';

// One hardcoded player, no auth — mirrors what scripts/seed.ts inserts.
export const PLAYER_ID = 1;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function loadWorld(playerId: number): Promise<WorldPayload> {
	return db.transaction((tx) => readWorld(tx, playerId));
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
		if (!Number.isInteger(x) || !Number.isInteger(y)) return { ok: false, reason: 'OUT_OF_BOUNDS' };
		if (x < 0 || y < 0 || x >= GRID_SIZE || y >= GRID_SIZE)
			return { ok: false, reason: 'OUT_OF_BOUNDS' };

		const [type] = await tx.select().from(buildingType).where(eq(buildingType.id, buildingTypeId));
		if (!type) return { ok: false, reason: 'UNKNOWN_BUILDING_TYPE' };

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
