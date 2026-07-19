// Client-safe: shared constants, wire types, and the position math. No db imports.

export const GRID_SIZE = 16;

export type OrderReason =
	'OUT_OF_BOUNDS' | 'UNKNOWN_BUILDING_TYPE' | 'TILE_OCCUPIED' | 'NO_IDLE_CHARACTER';

export type OrderRequest = { x: number; y: number; buildingTypeId: number };

// ponytail: the whole world, every read — 16×16 with one character is under 2 KB, smaller
// than a diff protocol's own HTTP headers. Viewport culling belongs to the map-client epic.
export type WorldPayload = {
	now: string;
	gridSize: number;
	buildingTypes: { id: number; displayName: string; buildSeconds: number }[];
	buildings: { id: number; x: number; y: number; buildingTypeId: number }[];
	characters: { id: number; x: number; y: number; speed: number }[];
	operations: {
		id: number;
		characterId: number;
		buildingTypeId: number;
		originX: number;
		originY: number;
		destX: number;
		destY: number;
		startedAt: string;
		travelDoneAt: string;
		completeAt: string;
	}[];
};

export type TravelLeg = {
	originX: number;
	originY: number;
	destX: number;
	destY: number;
	startedAt: string;
	travelDoneAt: string;
};

/** How far along the travel leg we are at `nowMs`, clamped to [0, 1]. */
export function travelFraction(op: TravelLeg, nowMs: number): number {
	const start = Date.parse(op.startedAt);
	const end = Date.parse(op.travelDoneAt);
	// Ordering a build on the character's own tile gives a zero-length leg — treat as arrived
	// rather than dividing by zero.
	if (end <= start) return 1;
	return Math.min(1, Math.max(0, (nowMs - start) / (end - start)));
}

/** Derived position — the server never stores or ticks intermediate positions. */
export function positionAt(op: TravelLeg, nowMs: number): { x: number; y: number } {
	const f = travelFraction(op, nowMs);
	return {
		x: op.originX + (op.destX - op.originX) * f,
		y: op.originY + (op.destY - op.originY) * f
	};
}

export function travelSeconds(
	originX: number,
	originY: number,
	destX: number,
	destY: number,
	speed: number
): number {
	return Math.ceil(Math.hypot(destX - originX, destY - originY) / speed);
}
