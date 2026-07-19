import { and, eq, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { building, buildingType, character, operation } from '$lib/server/db/schema';
import { GRID_SIZE, type WorldPayload } from './world';

// One hardcoded player, no auth — mirrors what scripts/seed.ts inserts.
export const PLAYER_ID = 1;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function loadWorld(playerId: number): Promise<WorldPayload> {
	return db.transaction((tx) => readWorld(tx, playerId));
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
