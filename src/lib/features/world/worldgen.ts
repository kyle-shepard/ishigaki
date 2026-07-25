// What terrain sits on every tile of the world, as one char per tile. The seed turns these into
// rows; this decides what they are.
//
// Two sources, and the split is deliberate: the middle of the map is hand-authored (`LAYOUT`,
// below) because the start tiles and the travel demo have to be exactly what they are, and the
// rest is generated because 48×48 is 2304 tiles and hand-authoring that is not a thing anybody
// does twice.
//
// Deterministic on purpose. `vercel-build` re-runs the seed on every deploy, and the tile grid is
// upserted rather than rebuilt: a generator that rolled fresh each time would rearrange the ground
// under standing buildings and other players' half-cleared forests. Same seed, same world, forever
// — a new map is a `WORLD_SEED` edit, and a deliberate one.
//
// ponytail: three value-noise fields and five thresholds, tuned by eye against the printed map
// (`npm run map`). No rivers, no coastlines, no biome adjacency, no resource balancing — a
// backdrop for 2304 tiles, not the world-gen epic. That epic wants coherent regions and a
// guaranteed resource budget per starting area; this only promises "not hand-authored, not noise
// soup, and the same every time".

// The `.ts` extension is load-bearing: this module is imported by `scripts/` under plain Node,
// which does not resolve extensionless paths. Same reason world.test.ts writes it that way.
import { GRID_SIZE } from './world.ts';

/** Change this and the world changes. Nothing else does. */
export const WORLD_SEED = 8613;

// Hand-authored, one char per terrain — diffable in a PR and editable in place. It sits in the
// middle of the generated world, centred by LAYOUT_OFFSET below, and the hamlet opens inside it
// because `findStart` prefers the middle of the map and this is what is drawn there.
//
// Load-bearing in two ways. It holds the lake that demonstrates terrain slowing travel (the pair of
// equal-distance legs in scripts/rules-check.ts is measured across it), and its open middle is the
// only stretch of grass wide enough for a hamlet with two clear tiles on every side — narrow that
// and the start moves, or the map rerolls.
const LAYOUT = [
	'mmmmmm....fff..m',
	'mmimm....ffff..m',
	'mmmm.....fff....',
	'.mm..www...f..s.',
	'....wwwww.......',
	'...wwwwwww..c...',
	'...wwwwww.......',
	'....wwww........',
	'................',
	'................',
	'..ff............',
	'.ffff..........s',
	'.fffff..........',
	'..fff..........m',
	'c..f........mmm.',
	'..........immmmm'
];

// Centred, so a new realm opens with room to expand in every direction rather than against a
// corner. A typo must fail here, not quietly produce a lopsided world.
//
// Exported because it is the bridge between two coordinate systems: LAYOUT is authored in its own
// 16×16 frame, and everything that refers to an authored tile by name — the start tiles, the lake
// in the travel demo, the outcrop in scripts/rules-check.ts — has to add this to reach world space.
export const LAYOUT_OFFSET = (GRID_SIZE - LAYOUT.length) / 2;
if (!Number.isInteger(LAYOUT_OFFSET) || LAYOUT_OFFSET < 0)
	throw new Error(`LAYOUT (${LAYOUT.length} rows) does not centre in a ${GRID_SIZE}-tile world`);
for (const [y, row] of LAYOUT.entries())
	if (row.length !== LAYOUT.length)
		throw new Error(`LAYOUT row ${y} is ${row.length} chars, expected ${LAYOUT.length}`);

/** mulberry32 — a small, well-behaved PRNG. Seeded, so every field below is reproducible. */
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * A smooth random field in [0, 1): random values on a lattice every `spacing` tiles, interpolated
 * between with smoothstep. Coarse spacing gives broad shapes (a lake, a range), fine spacing gives
 * texture. Sampled per tile; the whole lattice is built once, at import.
 */
function field(seed: number, spacing: number): (x: number, y: number) => number {
	const n = Math.ceil(GRID_SIZE / spacing) + 2;
	const rng = mulberry32(seed);
	const lattice = Array.from({ length: n * n }, rng);
	const smooth = (t: number) => t * t * (3 - 2 * t);
	return (x, y) => {
		const gx = x / spacing;
		const gy = y / spacing;
		const x0 = Math.floor(gx);
		const y0 = Math.floor(gy);
		const fx = smooth(gx - x0);
		const fy = smooth(gy - y0);
		const at = (i: number, j: number) => lattice[j * n + i];
		const top = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx;
		const bottom = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx;
		return top * (1 - fy) + bottom * fy;
	};
}

/**
 * Generated ground, for one seed.
 *
 * Height picks the band: water at the bottom, mountain at the top, habitable in between. Within
 * the habitable band a rare mineral peak places a deposit, and the kind follows the height —
 * clay in the lowlands near water, stone on the slopes, iron highest of all, just under the
 * mountains. Everything else is forest or meadow by vegetation.
 *
 * A factory rather than four module-level fields, because a map that has nowhere to put a hamlet
 * has to be thrown away and rolled again — see the reroll below.
 */
function generator(seed: number): (x: number, y: number) => string {
	// Two octaves of height: the coarse one decides where the water and the ranges are, the finer
	// one breaks up their edges so nothing reads as a circle.
	const coarse = field(seed, 8);
	const fine = field(seed + 1, 4);
	const elevation = (x: number, y: number) => 0.65 * coarse(x, y) + 0.35 * fine(x, y);
	// What grows on the habitable band, and where the deposits sit. Separate fields, so a forest and
	// an outcrop are independent facts about a tile rather than two slices of one number.
	const vegetation = field(seed + 2, 7);
	const minerals = field(seed + 3, 4);

	return (x, y) => {
		const e = elevation(x, y);
		if (e < 0.3) return 'w';
		if (e > 0.72) return 'm';
		if (minerals(x, y) > 0.84) {
			if (e > 0.6) return 'i';
			if (e > 0.47) return 's';
			return 'c';
		}
		return vegetation(x, y) > 0.54 ? 'f' : '.';
	};
}

/**
 * One whole map: the authored core where it covers, generated ground everywhere else. One alphabet
 * either way, so the seed's per-char handling (capacity, regrowth, the unknown-char guard) covers
 * the whole map with no second code path.
 */
function mapFor(seed: number): (x: number, y: number) => string {
	const generated = generator(seed);
	return (x, y) => LAYOUT[y - LAYOUT_OFFSET]?.[x - LAYOUT_OFFSET] ?? generated(x, y);
}

// The meadow char. Named because the start rule is written in terms of it and 'nothing but "."'
// reads like a typo.
const GRASS = '.';
// How much clear grass a new realm opens with around its buildings, on every side. Two, so the
// hamlet has somewhere to grow into and nobody starts wedged against a lake — which is exactly
// what the authored core did before this rule existed.
const START_MARGIN = 2;

/**
 * Where a new realm opens: the hamlet tile, with its two flanking buildings, the settlers on the
 * row below, and `START_MARGIN` tiles of clear grass around the lot.
 *
 * Searched rather than declared. A hand-placed constant was quietly wrong — the authored core put a
 * lake two tiles north of it — and a constant cannot notice when the ground under it moves, which
 * is what happened when the map grew and the core slid to the middle.
 *
 * Closest to the middle of the map wins, so a realm opens with room in every direction rather than
 * against an edge; the scan order breaks ties. Null when the map has nowhere at all, which is what
 * the reroll below is for.
 */
function findStart(charAt: (x: number, y: number) => string) {
	// Buildings on `y`, settlers on `y + 1`, three wide and centred on the hamlet — then the margin
	// around all of it.
	const clear = (hx: number, hy: number) => {
		for (let x = hx - 1 - START_MARGIN; x <= hx + 1 + START_MARGIN; x++)
			for (let y = hy - START_MARGIN; y <= hy + 1 + START_MARGIN; y++) {
				if (x < 0 || y < 0 || x >= GRID_SIZE || y >= GRID_SIZE) return false;
				if (charAt(x, y) !== GRASS) return false;
			}
		return true;
	};
	const mid = (GRID_SIZE - 1) / 2;
	let best: { x: number; y: number; d: number } | null = null;
	for (let y = 0; y < GRID_SIZE; y++)
		for (let x = 0; x < GRID_SIZE; x++) {
			const d = Math.hypot(x - mid, y - mid);
			if ((best && d >= best.d) || !clear(x, y)) continue;
			best = { x, y, d };
		}
	return best && { x: best.x, y: best.y };
}

// Roll until the world has somewhere to live. Every candidate is a *whole* different map, and the
// seed that wins is the one the world is made of — so this is still one fixed world per WORLD_SEED,
// just chosen rather than assumed.
//
// ponytail: the authored core contains a legal block, so this has never had to reroll and the loop
// runs once. It is here for the day the core is edited or dropped and the whole map is generated —
// at which point "no hamlet fits" stops being hypothetical. Bounded rather than `while (true)`: a
// deploy that hangs looking for a world is worse than one that fails saying so.
const rolled = (() => {
	for (let seed = WORLD_SEED; seed < WORLD_SEED + 50; seed++) {
		const charAt = mapFor(seed);
		const start = findStart(charAt);
		if (start) return { seed, charAt, start };
	}
	throw new Error(
		`no map in 50 rolls from seed ${WORLD_SEED} has ${START_MARGIN} tiles of clear grass around a hamlet`
	);
})();

/** The seed the world is actually made of — `WORLD_SEED` unless that roll had nowhere to live. */
export const MAP_SEED = rolled.seed;

/** The terrain char for one tile. */
export const terrainCharAt = rolled.charAt;

/**
 * Where every new sandbox opens. Every player gets the same coordinates because they never see
 * each other (VISION #4 interim override) — the hamlet, a second House beside it, the barn, and
 * the settlers on the row below.
 *
 * Derived from the map, not written down: see `findStart`. The seed re-asserts through the terrain
 * rows that these tiles really are Meadow, which is the one thing this cannot check for itself.
 */
export const START = {
	hamletX: rolled.start.x,
	hamletY: rolled.start.y,
	// Its own tile so the two Houses don't stack into one pawn.
	house2X: rolled.start.x - 1,
	house2Y: rolled.start.y,
	barnX: rolled.start.x + 1,
	barnY: rolled.start.y,
	// The settlers stand shoulder to shoulder on the row below, from characterX - 1.
	characterX: rolled.start.x,
	characterY: rolled.start.y + 1
};

/** The whole map, row-major, one string per row — for `npm run map` and the distribution test. */
export function terrainMap(): string[] {
	return Array.from({ length: GRID_SIZE }, (_, y) =>
		Array.from({ length: GRID_SIZE }, (_, x) => terrainCharAt(x, y)).join('')
	);
}
