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
// middle of the generated world, centred by LAYOUT_OFFSET below, and the player's hamlet opens
// inside it.
//
// Load-bearing: from the character's start tile this gives two equal-distance (7 tile) orders to
// buildable destinations — one across open meadow, one through five tiles of lake. That pair is
// what demonstrates terrain slowing travel. Editing the lake or the corridor two rows below it
// invalidates it.
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

// Two octaves of height: the coarse one decides where the water and the ranges are, the finer one
// breaks up their edges so nothing reads as a circle.
const coarse = field(WORLD_SEED, 8);
const fine = field(WORLD_SEED + 1, 4);
const elevation = (x: number, y: number) => 0.65 * coarse(x, y) + 0.35 * fine(x, y);
// What grows on the habitable band, and where the deposits sit. Separate fields, so a forest and
// an outcrop are independent facts about a tile rather than two slices of one number.
const vegetation = field(WORLD_SEED + 2, 7);
const minerals = field(WORLD_SEED + 3, 4);

/**
 * Generated ground.
 *
 * Height picks the band: water at the bottom, mountain at the top, habitable in between. Within
 * the habitable band a rare mineral peak places a deposit, and the kind follows the height —
 * clay in the lowlands near water, stone on the slopes, iron highest of all, just under the
 * mountains. Everything else is forest or meadow by vegetation.
 */
function generatedChar(x: number, y: number): string {
	const e = elevation(x, y);
	if (e < 0.3) return 'w';
	if (e > 0.72) return 'm';
	if (minerals(x, y) > 0.84) {
		if (e > 0.6) return 'i';
		if (e > 0.47) return 's';
		return 'c';
	}
	return vegetation(x, y) > 0.54 ? 'f' : '.';
}

/**
 * The terrain char for one tile: the authored core where it covers, generated ground everywhere
 * else. One alphabet either way, so the seed's per-char handling (capacity, regrowth, the
 * unknown-char guard) covers the whole map with no second code path.
 */
export function terrainCharAt(x: number, y: number): string {
	const row = LAYOUT[y - LAYOUT_OFFSET];
	const authored = row?.[x - LAYOUT_OFFSET];
	return authored ?? generatedChar(x, y);
}

/** The whole map, row-major, one string per row — for `npm run map` and the distribution test. */
export function terrainMap(): string[] {
	return Array.from({ length: GRID_SIZE }, (_, y) =>
		Array.from({ length: GRID_SIZE }, (_, x) => terrainCharAt(x, y)).join('')
	);
}
