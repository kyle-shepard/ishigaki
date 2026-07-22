// Client-safe: shared constants, wire types, and the position math. No db imports.

export const GRID_SIZE = 16;

export type OrderReason =
	| 'OUT_OF_BOUNDS'
	| 'UNKNOWN_BUILDING_TYPE'
	| 'TILE_NOT_BUILDABLE'
	| 'TILE_OCCUPIED'
	| 'NO_IDLE_CHARACTER'
	| 'INSUFFICIENT_RESOURCES'
	| 'TILE_YIELDS_NOTHING'
	| 'UNKNOWN_OPERATION';

export type OrderRequest = { x: number; y: number; buildingTypeId: number };

// ponytail: the whole world, every read. Terrain now dominates the payload — 256 small ints
// row-major is ~700 B, so a full read is ~1.3 KB, still smaller than a diff protocol's own
// HTTP headers. (An array of 256 tile *objects* would have been ~10 KB; that's why it isn't.)
// Viewport culling belongs to the map-client epic.
export type WorldPayload = {
	now: string;
	gridSize: number;
	// Set by the /api/world route, not by readWorld — it is a fact about *this request*
	// (the realm you asked for was gone), not about the world. True on exactly one response,
	// so the client makes it sticky rather than re-reading it.
	worldReset?: boolean;
	terrainTypes: {
		id: number;
		displayName: string;
		color: string;
		/** Symbol id in Sprites.svelte, minus the `i-` prefix. Unknown key ⇒ colour only. */
		icon: string;
		buildable: boolean;
		yieldsResourceId: number | null;
	}[];
	resources: { id: number; displayName: string }[];
	// What you hold, one entry per resource — fractional, because accrual is continuous. The
	// client floors it; the server never does.
	stock: { resourceId: number; quantity: number }[];
	// What each building type costs. A type with no entries is free.
	buildingCosts: { buildingTypeId: number; resourceId: number; quantity: number }[];
	// Row-major, index = y * gridSize + x, value = terrainTypeId — the same flat indexing the
	// client already uses to derive (x, y). movementCost is deliberately absent: nothing on the
	// client estimates travel.
	terrain: number[];
	// Row-major like `terrain`. How much this tile still holds, and how much it holds when
	// full; null on both where the deposit is infinite or the ground yields nothing. Dense
	// rather than a sparse list of the tiles you have touched — a sparse one would have made
	// the client learn capacity in order to fill in the gaps, which is the same ~700 B of
	// information arranged so that it can be got wrong.
	tileQuantity: (number | null)[];
	tileCapacity: (number | null)[];
	buildingTypes: { id: number; displayName: string; icon: string; buildSeconds: number }[];
	buildings: { id: number; x: number; y: number; buildingTypeId: number }[];
	characters: { id: number; x: number; y: number; speed: number }[];
	operations: {
		id: number;
		characterId: number;
		type: OperationType;
		// Both null on a gather: it builds nothing, and it never finishes on its own.
		buildingTypeId: number | null;
		originX: number;
		originY: number;
		destX: number;
		destY: number;
		startedAt: string;
		travelDoneAt: string;
		completeAt: string | null;
	}[];
};

export type OperationType = 'build' | 'gather';

export type AssignRequest = { x: number; y: number };

/**
 * How much a worker has taken since they were last paid out. Pure and database-free, which
 * is the point: continuous accrual is the one thing in this game that cannot be checked by
 * watching it — a thirty-day regrowth is not a test you run — so the arithmetic lives
 * somewhere `npm test` can reach it.
 *
 * Integrating elapsed time on read, rather than ticking, is what makes a week away come out
 * the same as a hundred small visits. Nothing here depends on how often it is called.
 *
 * A negative interval is not an error to shout about: `accrued_at` starts at the moment the
 * worker *arrives*, so every read while they are still walking asks about time that has not
 * happened yet. The honest answer to that is zero.
 *
 * Two clocks, because there genuinely are two. `workedSeconds` is how long *this worker* has
 * gone unpaid; `agedSeconds` is how long the *tile* has gone unmeasured. They are equal while
 * one person works one tile without pause, and they come apart the moment a tile is abandoned
 * and later returned to — a forest keeps growing whether or not anybody is standing in it.
 */
export function accrue(
	ratePerHour: number,
	workedSeconds: number,
	// null is an infinite deposit — stone, clay, iron, forage. No capacity, no clamp, no floor
	// to run into: the worker simply takes their rate.
	deposit: {
		quantity: number;
		capacity: number;
		regrowSeconds: number;
		agedSeconds: number;
	} | null
): { harvested: number; quantity: number | null } {
	const wanted = workedSeconds > 0 ? (ratePerHour * workedSeconds) / 3600 : 0;
	if (!deposit) return { harvested: wanted, quantity: null };

	const grown =
		deposit.agedSeconds > 0 ? (deposit.capacity / deposit.regrowSeconds) * deposit.agedSeconds : 0;
	// You cannot take more than is there, and what regrew during the interval is there to be
	// taken. At an emptied tile this is what the worker is left with — the regrowth itself,
	// which at ~1 tree per 29 hours against 1 per 20 minutes reads as "this forest is
	// finished" without needing a special case that says so.
	const harvested = Math.min(wanted, deposit.quantity + grown);
	// Clamped at both ends: a tile cannot go below empty, and cannot regrow past full.
	const quantity = Math.min(Math.max(deposit.quantity + grown - harvested, 0), deposit.capacity);
	return { harvested, quantity };
}

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

/**
 * How long the trip takes, weighted by what it crosses. `cost` takes *integer tile
 * coordinates* and returns that tile's movement cost; it is required rather than defaulted,
 * because a default of 1 would hand terrain-free timings back to a caller that forgot to
 * pass terrain, silently.
 *
 * Sampling is the midpoint rule — sample points sit at the centres of n equal sub-segments,
 * never at the endpoints. Two properties fall out for free: the sample set is invariant
 * under t → 1−t, so A→B and B→A always agree; and an all-cost-1 path reduces exactly to the
 * old `ceil(dist / speed)`. Neither endpoint is special-cased — the character stands *on*
 * its origin tile, so counting half of it is right.
 *
 * Rounding (not flooring) each sample to a tile makes integer coordinates tile *centres*,
 * which is what that half-tile claim means. Flooring would put the character on a corner and
 * give the origin tile no samples at all when it departs along an axis.
 *
 * ponytail: uniform resolution, ~4 samples per tile. Fine at 16×16; a much larger map could
 * slip a one-tile-wide river between samples, and that is when this needs revisiting.
 */
export function travelSeconds(
	originX: number,
	originY: number,
	destX: number,
	destY: number,
	speed: number,
	cost: (x: number, y: number) => number
): number {
	const dist = Math.hypot(destX - originX, destY - originY);
	// Ordering a build on the character's own tile — same case travelFraction guards.
	if (dist === 0) return 0;

	const n = Math.ceil(dist * 4);
	let total = 0;
	for (let i = 0; i < n; i++) {
		const t = (i + 0.5) / n;
		total += cost(
			Math.round(originX + (destX - originX) * t),
			Math.round(originY + (destY - originY) * t)
		);
	}
	return Math.ceil((dist * (total / n)) / speed);
}
