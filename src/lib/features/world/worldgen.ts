// What terrain sits on every tile of the world, as one char per tile — computed on demand, never
// stored. Ask it about a tile and it answers; ask it about all 47,775,744 of them and it will
// answer that too, one at a time, which is the whole point.
//
// **Two resolutions, and that is the architecture.** The old generator built the entire grid
// eagerly into typed arrays at module import, because its hydrology stage — priority-flood, D4 flow
// direction, flow accumulation — is a whole-grid algorithm by nature: there is no such thing as
// "the river at just this one tile" without knowing its neighbours. That reasoning was right, and
// it is why every other stage was made eager too, for consistency. It also put the cost of the
// *whole world* in front of every consumer: ~2.4 s and hundreds of megabytes at 1448x1448, and at
// the continent this is now sized for (#24) it is a minute of CPU and multiple gigabytes of
// Float64Array, per lambda cold start, before anybody has looked at a single tile.
//
// So the hydrology keeps its whole-grid algorithm and stops running at tile resolution. A **coarse
// grid** — one cell per COARSE x COARSE block of tiles — carries the three things that genuinely
// cannot be decided locally: which way water flows, how much of it passes through, and whether a
// given patch of low ground actually connects to the sea. That grid is small enough to build
// eagerly at import and keep (at COARSE 6 the continent is 1152x1152 cells, ~21 MB and 1.1 s), and
// everything else — elevation, ridges, minerals, moisture, and the tile-level shape of the rivers
// themselves — is a **pure function of (x, y)** against that coarse grid plus noise. Nothing walks
// the world to answer a question about one tile.
//
// Three consequences worth knowing:
//
//  - **The client can run this.** It is the same module, no database, no filesystem: the browser
//    computes the terrain under its own viewport instead of being shipped a 48M-entry array. That
//    is what took the terrain payload off the wire.
//  - **Thresholds carry across grid sizes now.** They never used to: `field` built a lattice sized
//    to GRID_SIZE, so changing the grid drew a different number of random values and handed back a
//    genuinely different field whose elevation histogram sat somewhere else — every previous grid
//    change (128->256, 256->1024, 1024->1448) came with a retuning pass and a comment apologising
//    for it. `field` is a hash now, evaluated per sample point, so the value at lattice point
//    (i, j) is the same value forever regardless of how big the world is. A bigger world is
//    literally more of the same world, not a differently-shaped one.
//  - **Rivers are one tile wide by construction**, not by tuning. See `riverAt`.
//
// The pipeline, in order: domain-warped fBm for elevation, a falloff toward one chosen edge for the
// sea (the coastline is wherever the water threshold and that falloff happen to cross — emergent,
// never drawn), a ridged multifractal added into the high band so mountains come out as chains, a
// second elevation cut for Hills between lowland and peak; then, on the coarse grid, priority-flood
// depression filling -> D4 downhill directions -> flow accumulation, so rivers are guaranteed to
// reach the sea by construction rather than by luck; then per tile, a river is wherever a coarse
// channel's traced path crosses. Moisture (and so forest vs. meadow) is lifted near whatever water
// the hydrology produced, so woodland reads as a region rather than a coin flip per tile.
//
// Deterministic on purpose. `vercel-build` re-runs the seed on every deploy, and realms stand on
// ground this decides: a generator that rolled fresh each time would rearrange the world under
// standing buildings. Same seed, same world, forever — a new map is a `WORLD_SEED` edit, and a
// deliberate one.

// The `.ts` extension is load-bearing: this module is imported by `scripts/` under plain Node,
// which does not resolve extensionless paths. Same reason world.test.ts writes it that way.
import { GRID_SIZE, MATURE_REACH_RADIUS, START_REACH_RADIUS, withinReach } from './world.ts';

/** Change this and the world changes. Nothing else does. */
export const WORLD_SEED = 90210;

/**
 * How many tiles across one coarse hydrology cell is. The one number trading river detail against
 * the cost of the eager coarse pass: the coarse grid is (GRID_SIZE / COARSE)^2 cells, and
 * everything eager in this module is sized by that.
 *
 * 6 puts the continent at 1152x1152 = 1,327,104 cells: ~21 MB held for the life of the process and
 * 1.1 s at import, against 47.8M cells and several gigabytes if the hydrology still ran per tile.
 * For scale, the old whole-grid generator took 2.4 s to build a world 23x smaller than this one.
 *
 * It is 6 rather than something cheaper because of *straightness*, which is the one thing this
 * number controls that a player can see. The channel is traced node to node, so a river's longest
 * dead-straight run comes out at about 1.75 x COARSE — measured across twelve fixed inland windows:
 *
 *     COARSE   6    8   10   12   16   24
 *     straight 11  17   18   20   27   42
 *
 * At 24 that is 42 tiles — 840 m of arrow-straight water, which reads as a canal somebody dug. 6 is
 * the setting that comes in under the 16-tile budget worldgen.test.ts already held the old generator
 * to, rather than one that needs the budget argued down to fit it. It costs 530 ms over COARSE 8 and
 * also buys a proportionally finer moisture transform, which is the other thing the coarse grid
 * feeds.
 */
export const COARSE = 6;
const COARSE_SIZE = Math.ceil(GRID_SIZE / COARSE);

/**
 * Value noise's random lattice, as a hash rather than an array: the pseudo-random value at integer
 * lattice point (i, j) for a given seed, in [0, 1). Two multiply-xorshift rounds on the mixed
 * inputs — the same family as the mulberry32 PRNG this replaced, which had to be *walked* in order
 * and so had to be stored.
 *
 * Storing it was the problem. `field` used to build an `Array` of `(GRID_SIZE / spacing + 2)^2`
 * doubles at module import; at the continent, the finest-spaced field alone was hundreds of
 * megabytes, and every field's contents changed whenever GRID_SIZE did — which is precisely why
 * every previous grid change came with a retuning pass. A hash has no size, no import cost, and
 * gives the same answer at (i, j) forever, so the same thresholds describe a 1448-tile world and a
 * 6912-tile one.
 *
 * `Math.imul` throughout, so every intermediate stays a 32-bit integer: the same arithmetic in the
 * browser and in Node, which is what makes it safe for the client to generate its own terrain and
 * get the server's answer.
 */
function hashNoise(seed: number, i: number, j: number): number {
	let h = (seed ^ Math.imul(i | 0, 0x27d4eb2d) ^ Math.imul(j | 0, 0x165667b1)) >>> 0;
	h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
	h = Math.imul(h ^ (h >>> 13), 0x297a2d39);
	return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const smoothstep = (t: number) => t * t * (3 - 2 * t);

/**
 * A smooth random field in [0, 1): pseudo-random values on a lattice every `spacing` tiles,
 * interpolated between with smoothstep. Coarse spacing gives broad shapes (a lake, a range), fine
 * spacing gives texture. Pure — no lattice is built and nothing is held; see `hashNoise`.
 */
function field(seed: number, spacing: number): (x: number, y: number) => number {
	return (x, y) => {
		const gx = x / spacing;
		const gy = y / spacing;
		const x0 = Math.floor(gx);
		const y0 = Math.floor(gy);
		const fx = smoothstep(gx - x0);
		const fy = smoothstep(gy - y0);
		const top =
			hashNoise(seed, x0, y0) * (1 - fx) + hashNoise(seed, x0 + 1, y0) * fx;
		const bottom =
			hashNoise(seed, x0, y0 + 1) * (1 - fx) + hashNoise(seed, x0 + 1, y0 + 1) * fx;
		return top * (1 - fy) + bottom * fy;
	};
}

/**
 * Fractal Brownian motion: `octaves` calls to `field`, halving amplitude and halving spacing
 * (doubling frequency) each step, normalised back to roughly [0, 1). The coarse octave decides
 * where the broad shapes are — the sea, the ranges — and each finer one breaks their edges up.
 * `seedBase` must not overlap the seed offsets any other field in this file reads, or two
 * "independent" layers would turn out to be the same lattice.
 */
function fbm(
	seedBase: number,
	octaves: number,
	baseSpacing: number
): (x: number, y: number) => number {
	const layers: ((x: number, y: number) => number)[] = [];
	let spacing = baseSpacing;
	for (let o = 0; o < octaves; o++) {
		layers.push(field(seedBase + o, spacing));
		spacing /= 2;
	}
	return (x, y) => {
		let sum = 0;
		let amplitude = 1;
		let norm = 0;
		for (const layer of layers) {
			sum += amplitude * layer(x, y);
			norm += amplitude;
			amplitude *= 0.5;
		}
		return sum / norm;
	};
}

/**
 * Ridged multifractal: the same octave stack as `fbm`, but each layer is folded around its
 * midpoint first (`1 - |2n - 1|`), so instead of a smooth hill every octave contributes a *ridge* —
 * high wherever that octave's noise crosses 0.5, low either side of it. A ridge is a connected line
 * by construction (it's a contour of the underlying noise), so adding this into elevation before
 * the mountain cut is what turns "high ground" into chains rather than the speckle a plain height
 * threshold gives.
 */
function ridged(
	seedBase: number,
	octaves: number,
	baseSpacing: number
): (x: number, y: number) => number {
	const layers: ((x: number, y: number) => number)[] = [];
	let spacing = baseSpacing;
	for (let o = 0; o < octaves; o++) {
		layers.push(field(seedBase + o, spacing));
		spacing /= 2;
	}
	return (x, y) => {
		let sum = 0;
		let amplitude = 1;
		let norm = 0;
		for (const layer of layers) {
			sum += amplitude * (1 - Math.abs(2 * layer(x, y) - 1));
			norm += amplitude;
			amplitude *= 0.5;
		}
		return sum / norm;
	};
}

// Four-way, for the coarse hydrology below (priority-flood, D4 flow direction, accumulation) and
// for the sea-connectivity flood. Diagonals were tried here first and rejected: a D8 downhill step
// can carve a channel that only ever touches its neighbours corner-to-corner, which prints as a
// connected line but is a string of orphaned puddles under any 4-connected reading — including a
// player's own pathing. D4 makes a channel orthogonally contiguous by construction, so there is
// nothing left to accidentally get wrong at classification time.
const NEIGHBORS4: readonly [number, number][] = [
	[1, 0],
	[-1, 0],
	[0, 1],
	[0, -1]
];

/**
 * A binary min-heap of `{key, i}`, private to `priorityFlood` below. Only ever needs push and
 * pop-the-smallest, so it is a page of array arithmetic rather than a dependency — the same call
 * `route` already makes for Dijkstra over the tile grid.
 */
class MinHeap {
	private items: { key: number; i: number }[] = [];
	get size() {
		return this.items.length;
	}
	push(key: number, i: number) {
		const a = this.items;
		a.push({ key, i });
		let c = a.length - 1;
		while (c > 0) {
			const p = (c - 1) >> 1;
			if (a[p].key <= a[c].key) break;
			[a[p], a[c]] = [a[c], a[p]];
			c = p;
		}
	}
	pop(): { key: number; i: number } {
		const a = this.items;
		const top = a[0];
		const last = a.pop()!;
		if (a.length) {
			a[0] = last;
			let p = 0;
			for (;;) {
				const l = p * 2 + 1;
				const r = l + 1;
				let m = p;
				if (l < a.length && a[l].key < a[m].key) m = l;
				if (r < a.length && a[r].key < a[m].key) m = r;
				if (m === p) break;
				[a[p], a[m]] = [a[m], a[p]];
				p = m;
			}
		}
		return top;
	}
}

/**
 * Priority-flood depression filling, done together with D4 flow-direction assignment — the standard
 * combined form of the algorithm (Barnes, Lehman & Mulla 2014), adapted to four directions rather
 * than the textbook eight: expand outward from the outlets in order of rising elevation, and
 * whichever cell discovers a tile first is, by construction, that cell's downhill neighbour. One
 * pass gives both the filled DEM and the drainage tree.
 *
 * Runs over the **coarse** grid — `width` cells a side, not GRID_SIZE — which is the whole reason
 * this module no longer has to build the world to answer a question about one tile.
 *
 * `outlets` is deliberately not "every border cell", the textbook seed set — it is only the cells
 * on the map's one sea edge. Seeding just that edge is what turns "drains to the map edge" into
 * "drains to the sea": a basin that would otherwise spill off a mountain-side edge is filled
 * instead, because that edge was never offered as an escape. Every reachable cell ends up with a
 * downhill path that lands on the sea, 4-connected the whole way.
 *
 * The `+ EPS` on each fill is what keeps the result strictly downhill even across a cell that would
 * otherwise tie with its neighbour: without it, two cells filled to the same height would have
 * nowhere to send their flow, and accumulation would stall on the plateau instead of reaching the
 * sea.
 */
function priorityFlood(
	elevation: Float64Array,
	width: number,
	outlets: number[]
): { downhill: Int32Array; order: Int32Array } {
	const n = elevation.length;
	const filled = new Float64Array(n);
	const downhill = new Int32Array(n).fill(-1);
	const visited = new Uint8Array(n);
	const order = new Int32Array(n);
	let popped = 0;
	const heap = new MinHeap();
	const EPS = 1e-6;

	for (const i of outlets) {
		visited[i] = 1;
		filled[i] = elevation[i];
		heap.push(filled[i], i);
	}
	while (heap.size > 0) {
		const { key, i } = heap.pop();
		order[popped++] = i;
		const x = i % width;
		const y = (i / width) | 0;
		for (const [dx, dy] of NEIGHBORS4) {
			const nx = x + dx;
			const ny = y + dy;
			if (nx < 0 || ny < 0 || nx >= width || ny >= width) continue;
			const j = ny * width + nx;
			if (visited[j]) continue;
			visited[j] = 1;
			filled[j] = Math.max(elevation[j], key + EPS);
			downhill[j] = i;
			heap.push(filled[j], j);
		}
	}
	// Every cell is reachable from the sea edge by construction (the grid is 4-connected and the
	// whole edge is seeded), so `popped` is `n`; the subarray is belt-and-braces against a future
	// outlet set that isn't.
	return { downhill, order: order.subarray(0, popped) };
}

/**
 * Upstream flow accumulation, given the drainage tree `priorityFlood` produced: how many cells'
 * worth of flow pass through each one on their way to an outlet. `order` is outlet-to-summit (the
 * flood's own pop order), so walking it backwards visits every cell after everything that drains
 * into it — one pass is enough to fold each cell's whole upstream catchment into itself and hand
 * the total down to its own downhill neighbour.
 */
function flowAccumulation(downhill: Int32Array, order: Int32Array): Float64Array {
	const acc = new Float64Array(downhill.length).fill(1);
	for (let k = order.length - 1; k >= 0; k--) {
		const i = order[k];
		const d = downhill[i];
		if (d !== -1) acc[d] += acc[i];
	}
	return acc;
}

// ---------------------------------------------------------------------------------------------
// The fields. Pure `(x, y) => value` closures over `hashNoise`, built once at import and holding
// nothing. Seed offsets are each given their own block so that no two "independent" fields ever
// read the same lattice: 0-9 for the elevation fBm's octaves, 10-19 for the ridge's, 20-21 for the
// domain warp, 22 for minerals, 23 for moisture, 24 for the coarse hydrology's tie-breaking noise,
// 25-26 for the river tracing's per-cell jitter.
// ---------------------------------------------------------------------------------------------

// **Wavelengths are continental, and that is a correction.** These were 40, 34, 24, 4 and 11 tiles
// — sized when the world was 128 tiles across and carried forward unexamined through every widening
// since. At 6912 they produce a world with no large-scale structure at all: every octave is smaller
// than 1/170th of the map, so the continent comes out as one uniform speckle, mountains scattered as
// isolated flecks rather than ranges, no region distinguishable from any other. Every numeric check
// passed while that was true — the census is a histogram and a histogram cannot see arrangement.
// It took rendering the map to an image to notice.
//
// So the stack now spans the world: the coarsest octave is a fraction of the continent and each
// finer one halves it, down to a few tiles. That is what a fractal landscape is supposed to be, and
// it is why the octave counts went up with the spacings rather than instead of them — starting at
// 2048 with the old four octaves would have fixed the shape of the continent and left no detail at
// the scale a player actually stands on.
const heightField = fbm(WORLD_SEED, 9, 2048);
const ridgeField = ridged(WORLD_SEED + 10, 8, 1400);
// The warp displaces the elevation sample, so it has to work at the scale of the thing it is
// bending: a 24-tile warp against a 2048-tile range does nothing you can see.
const warpX = field(WORLD_SEED + 20, 700);
const warpY = field(WORLD_SEED + 21, 700);
// Deposits read as *fields* rather than as per-tile confetti — one octave at four tiles was
// literally uncorrelated noise at the scale of a tile, which is the "per-tile dice" failure the
// forest test exists to catch, applied to minerals where nothing was checking.
// Moisture and minerals are each **two fields, explicitly weighted**, rather than one fBm stack.
//
// fBm alone cannot do what these two need. Its amplitude halves every octave, so a stack based at
// 900 tiles has its 7-tile octave contributing about one percent of the range — nowhere near enough
// to cross a threshold. That makes the regional structure clean and the local ground *uniform*:
// forest and meadow end up in huge separate provinces with no copses in the fields and no glades in
// the woods. Measured consequence, not an aesthetic quibble — it took the number of legal openings
// on the map from 100 to zero, because a starting reach is six tiles across and the start rule needs
// wood and stone inside it, which a landscape with no fine-scale mixing simply never offers.
//
// The old generator had the opposite failure: one octave at 11 tiles, pure local scatter, no regions
// at all. A landscape has both, so this says both. `REGION_WEIGHT` is the dial between them.
const REGION_WEIGHT = 0.62;
const mix =
	(regional: (x: number, y: number) => number, local: (x: number, y: number) => number) =>
	(x: number, y: number) =>
		REGION_WEIGHT * regional(x, y) + (1 - REGION_WEIGHT) * local(x, y);
const minerals = mix(fbm(WORLD_SEED + 22, 4, 160), field(WORLD_SEED + 27, 5));
const moistureNoise = mix(fbm(WORLD_SEED + 23, 5, 900), field(WORLD_SEED + 28, 9));

// Domain warp: elevation is sampled at (x, y) *displaced* by a second pair of noise fields, rather
// than at (x, y) itself. A straight fBm call reads as rings around each octave's lattice points —
// warping the sample point is the standard fix, and it's why this map's ranges bend instead of
// reading as blobs.
// **Strength scales with the wavelength it is bending, and forgetting that was a real bug.** The
// warp's whole job is to stop elevation reading as its own lattice: a straight fBm gives axis-aligned
// gradients, and drainage laid on axis-aligned gradients comes out as a comb of parallel rivers. When
// the elevation base went from 40 tiles to 2048 this stayed at 16, which against a 2048-tile feature
// is no displacement at all — the warp was still in the code and had stopped doing anything. 300 is
// the same fraction of the new base that 16 was of the old.
const WARP_STRENGTH = 300;

// The sea sits against the east edge — arbitrary, but it's the edge VISION's own example map names
// ("the sea is east"). SEA_BAND is how wide the coastal falloff reaches inland; LAND_FLOOR is a
// hard clamp on elevation *before* that falloff, so no amount of noise can ever put water on one of
// the other three edges — only the band next to the sea edge can ever read as water, and the
// coastline within that band is wherever WATER_T happens to cross the noise. SEA_DEPTH is set to
// `1 - WATER_T` (`fbm`'s output is bounded to [0, 1), so `land` never reaches 1) — not tuned by eye
// like the rest of this block, but *derived*, so the very edge column is a hard guarantee of water
// rather than a statistical likelihood. Without that guarantee, a tall enough headland can rise
// right at x = SEA_EDGE_X and pinch the coastline into two components that both still "touch the
// sea edge" — the sea would technically still keep to one edge, but stop being one connected sea.
const SEA_EDGE_X = GRID_SIZE - 1;
const SEA_BAND = Math.round(GRID_SIZE * 0.18);
const LAND_FLOOR = 0.42;
const WATER_T = 0.32;
const SEA_DEPTH = 1 - WATER_T + 0.02;
const seaFalloff = (x: number) => smoothstep(clamp((SEA_EDGE_X - x) / SEA_BAND, 0, 1));

// A strip that runs the map's whole height necessarily reaches the northeast and southeast corners,
// which sit on the north/south edges too — without this, "one edge" quietly becomes two wherever
// the coast meets a corner. Tapering the depression out near y = 0 and y = GRID_SIZE - 1 curls the
// coastline back from both corners instead, the same hard-clamp approach LAND_FLOOR uses rather
// than hoping the noise never reaches that far.
const CORNER_MARGIN = 10;
const cornerTaper = (y: number) =>
	smoothstep(clamp(Math.min(y, GRID_SIZE - 1 - y) / CORNER_MARGIN, 0, 1));

// The other three edges are rim, not coast — high ground the way VISION's own example map describes
// ("the range walls off the north"), and *load-bearing* high ground: without it, flow accumulation
// occasionally routes a real river along the very edge of the grid, and every Water tile has to
// reach the sea. Raising the rim keeps both promises with one mechanism instead of a second special
// case at classification time — a river simply has nowhere low enough to run along the border.
const EDGE_MARGIN = 8;
const EDGE_LIFT = 0.3;
const edgeLift = (x: number, y: number) => {
	const distToRim = Math.min(x, y, GRID_SIZE - 1 - y);
	return EDGE_LIFT * (1 - smoothstep(clamp(distToRim / EDGE_MARGIN, 0, 1)));
};

// The ridge only piles onto land that already reads as high ground — gated smoothly between
// RIDGE_GATE_LOW and RIDGE_GATE_HIGH — rather than scaling every tile by however "tall" it is. A
// flat `* land` multiplier (the first thing tried here) lifts the *whole* map a little, since most
// of the grid is mid-elevation, not just the would-be peaks; gating on a narrow high band is what
// keeps the ridge a mountain-range effect instead of a global elevation bump.
const RIDGE_WEIGHT = 0.6;
const RIDGE_GATE_LOW = 0.78;
const RIDGE_GATE_HIGH = 0.92;
const ridgeGate = (land: number) =>
	smoothstep(clamp((land - RIDGE_GATE_LOW) / (RIDGE_GATE_HIGH - RIDGE_GATE_LOW), 0, 1));

/**
 * The ground's height at one tile, before any water is decided — the one function every other stage
 * reads, and the whole of what used to be an eagerly-filled `Float64Array` the size of the world.
 * Pure, local, and independent of GRID_SIZE except through the three deliberate edge terms above.
 */
function elevationAt(x: number, y: number): number {
	// The warp is clamped back onto the grid: the lattice `field` interpolates over is unbounded
	// now, but keeping the sample point on-map means the sea falloff and the rim lift still describe
	// the same coastline the classification below reads.
	const wx = clamp(x + (warpX(x, y) - 0.5) * 2 * WARP_STRENGTH, 0, GRID_SIZE - 1);
	const wy = clamp(y + (warpY(x, y) - 0.5) * 2 * WARP_STRENGTH, 0, GRID_SIZE - 1);
	// **Rescaled onto the floor, never clamped against it.** The floor's job is to guarantee that no
	// amount of noise can put water on the three non-sea edges. `Math.max(raw, LAND_FLOOR)` does that
	// by flattening every low tile onto exactly one height, which hands `priorityFlood` a perfectly
	// level western plain — and on level ground the flood has nothing to prefer, so it lays down
	// evenly-spaced parallel drainage lanes. Rendered, that is a comb of a dozen dead-straight rivers
	// side by side across a sixth of the continent. Softening the clamp to a compression (tried second)
	// does not fix it either: compressed-flat is still flat enough.
	//
	// A linear remap of the field's whole [0, 1) range onto [LAND_FLOOR, 1) has no degenerate region at
	// all — every tile keeps a distinct height and a real gradient — while holding the floor guarantee
	// exactly. It shifts the entire elevation distribution upward, which is why the band thresholds
	// below are read off a fresh measurement rather than carried over.
	const land = LAND_FLOOR + (1 - LAND_FLOOR) * heightField(wx, wy);
	const drowned = land - SEA_DEPTH * (1 - seaFalloff(x)) * cornerTaper(y);
	return drowned + RIDGE_WEIGHT * ridgeField(wx, wy) * ridgeGate(land) + edgeLift(x, y);
}

// ---------------------------------------------------------------------------------------------
// The coarse grid: the three facts about a tile that genuinely cannot be decided by looking at it.
// ---------------------------------------------------------------------------------------------

// A coarse cell's own point in *tile* coordinates — its centre, jittered within the cell. The
// jitter is what the traced river channel bends around: with every node on an exact cell centre a
// river's course corrections would land on a perfect COARSE-tile lattice and read as a canal, which
// is the same "straight reads as dug, not as landscape" failure the old per-tile hydrology noise
// existed to fix, just at a different scale. 0.34 keeps a node comfortably inside its own cell, so
// two adjacent nodes never cross over each other and the traced path between them stays monotone.
const NODE_JITTER = 0.15;

/**
 * A fixed zigzag baked into the node lattice, on top of the random jitter: every odd row of coarse
 * cells has its nodes pushed `NODE_PARITY` of a cell east, every even row the same distance west
 * (and correspondingly for columns and `nodeY`).
 *
 * **This is what bounds a river's straight runs, and it has to be deterministic.** The channel from
 * a cell to its downhill neighbour is drawn as an L — a horizontal leg then a vertical one — so two
 * vertically-chained cells produce two vertical legs that merge into a single line whenever their
 * node x's happen to coincide. Random jitter alone only makes that *unlikely*: `Math.round` collapses
 * a few tiles of jitter onto a handful of integers, so a chain of k cells lines up with probability
 * around 7^-(k-1), and over three quarters of a million coarse cells the long tail of that is a
 * certainty, not a risk. Measured, before this: a 100-tile dead-straight run at one spacing and a
 * 27-tile one at another, with the difference between them being luck rather than design.
 *
 * The parity offset removes the coincidence instead of betting against it. `NODE_PARITY` is bigger
 * than `NODE_JITTER`, so two vertically-adjacent nodes differ in x by at least
 * `2 * (NODE_PARITY - NODE_JITTER) * COARSE` — never zero, whatever the noise does — and the L's
 * horizontal leg therefore always breaks the vertical chain. A straight run is bounded by one cell's
 * own leg, by construction, rather than by how the dice fell.
 */
const NODE_PARITY = 0.25;
// Spacing 1 — no interpolation, so every cell's offset is independent of its neighbours'. At
// spacing 3 (tried first) the jitter varies smoothly across three cells, which correlates exactly
// the neighbours this is trying to decorrelate.
const jitterX = field(WORLD_SEED + 25, 1);
const jitterY = field(WORLD_SEED + 26, 1);
const nodeX = (cx: number, cy: number) =>
	Math.round(
		cx * COARSE +
			COARSE / 2 +
			(jitterX(cx, cy) - 0.5) * 2 * NODE_JITTER * COARSE +
			(cy & 1 ? NODE_PARITY : -NODE_PARITY) * COARSE
	);
const nodeY = (cx: number, cy: number) =>
	Math.round(
		cy * COARSE +
			COARSE / 2 +
			(jitterY(cx, cy) - 0.5) * 2 * NODE_JITTER * COARSE +
			(cx & 1 ? NODE_PARITY : -NODE_PARITY) * COARSE
	);

// A cell over this many upstream cells' worth of flow carries a river. There is no natural absolute
// scale for accumulation — it depends on how the drainage tree happens to branch — so this is tuned
// against `npm run map` rather than derived.
//
// **It no longer moves with GRID_SIZE**, which is new and is the point of the coarse grid. The old
// per-tile threshold had to be re-derived on every single grid change (1,800 -> 4,500 -> 60,000 ->
// 400,000 across four world sizes) because accumulation counts *upstream cells*, and quadrupling
// the tile count quadruples every catchment. Accumulation is counted in coarse cells now, and a
// coarse cell is a fixed area of ground, so a given threshold means the same size of catchment at
// any world size. What it selects for is a channel draining at least this many COARSE x COARSE
// blocks — at COARSE 6, one block is 120 m square, and 2,702 of them is ~39 km2 of catchment, which
// is a river rather than a ditch.
//
// It *does* move with COARSE, and quadratically: halving COARSE quarters a cell's area, so the same
// physical catchment counts four times as many cells. Keep the product RIVER_T x COARSE^2 fixed and
// the rivers stay the same rivers.
const RIVER_T = 2702;

/**
 * Chaotic, per-cell-independent noise added to the coarse elevation for the hydrology *only* —
 * never for terrain classification, which stays on unperturbed `elevationAt` throughout, so nothing
 * here can relabel a tile's terrain band.
 *
 * It exists because `priorityFlood` visits cells in order of rising elevation and hands each one a
 * parent from whichever neighbour was visited first: on flat ground fed from one straight edge of
 * outlets, that degenerates to "shortest path to the coast", which is a straight line. A *smooth*
 * perturbation only wiggles around that line; genuinely per-cell-independent noise (spacing 1, no
 * interpolation left to smooth it) is what breaks the degeneracy, because the cheapest unvisited
 * neighbour keeps changing hand to hand instead of settling into one direction.
 *
 * Its amplitude and RIVER_T used to be coupled and had to be swept jointly on every grid change,
 * because they traded channel width against straightness. That trade is gone: width is now fixed at
 * one tile by `riverAt`, so this only has to do the one job it was for.
 */
const hydroNoise = field(WORLD_SEED + 24, 1);
const HYDRO_NOISE_AMPLITUDE = 0.035;

type Coarse = {
	downhill: Int32Array;
	acc: Float64Array;
	/** 1 where this cell's own node point reads as water *and* that water reaches the open sea. */
	sea: Uint8Array;
	/** Coarse cells from this cell to the nearest one carrying river or sea; -1 if unreachable. */
	distToWater: Int32Array;
};

/**
 * The eager pass — the only one in this file, and the only thing here whose cost scales with the
 * world. Everything above is a pure closure; everything below reads this.
 */
function buildCoarse(): Coarse {
	const n = COARSE_SIZE * COARSE_SIZE;
	const elevation = new Float64Array(n);
	for (let cy = 0; cy < COARSE_SIZE; cy++)
		for (let cx = 0; cx < COARSE_SIZE; cx++) {
			const i = cy * COARSE_SIZE + cx;
			// Sampled at the cell's own jittered node, not its geometric centre, so the height the
			// hydrology reasons about is the height at the point the channel is actually traced
			// through — otherwise a river can be routed downhill through ground that is uphill at the
			// tile the channel lands on.
			elevation[i] =
				elevationAt(nodeX(cx, cy), nodeY(cx, cy)) +
				HYDRO_NOISE_AMPLITUDE * (hydroNoise(cx, cy) - 0.5);
		}

	const outlets: number[] = [];
	for (let cy = 0; cy < COARSE_SIZE; cy++) outlets.push(cy * COARSE_SIZE + (COARSE_SIZE - 1));
	const { downhill, order } = priorityFlood(elevation, COARSE_SIZE, outlets);
	const acc = flowAccumulation(downhill, order);

	// Which low ground actually reaches the open sea. A cell whose node reads as below the water
	// threshold is a candidate; flooding 4-connected from the sea edge is what separates real
	// coastline from a lagoon the coastal band happened to seal off inland. The old generator did
	// this per tile over the whole grid, for the same reason and with the same argument — a pocket
	// nothing can swim to from the sea was never part of the sea.
	const sea = new Uint8Array(n);
	{
		const low = (i: number) =>
			elevationAt(nodeX(i % COARSE_SIZE, (i / COARSE_SIZE) | 0), nodeY(i % COARSE_SIZE, (i / COARSE_SIZE) | 0)) <
			WATER_T;
		const stack = outlets.filter(low);
		for (const i of stack) sea[i] = 1;
		while (stack.length) {
			const i = stack.pop()!;
			const x = i % COARSE_SIZE;
			const y = (i / COARSE_SIZE) | 0;
			for (const [dx, dy] of NEIGHBORS4) {
				const nx = x + dx;
				const ny = y + dy;
				if (nx < 0 || ny < 0 || nx >= COARSE_SIZE || ny >= COARSE_SIZE) continue;
				const j = ny * COARSE_SIZE + nx;
				if (sea[j] || !low(j)) continue;
				sea[j] = 1;
				stack.push(j);
			}
		}
	}

	// Moisture's water-proximity term, in coarse cells: a multi-source breadth-first distance
	// transform from every cell carrying sea or river. The old generator ran this per tile over the
	// whole grid; at coarse resolution one cell is COARSE tiles, which is the same order as the
	// six-tile reach the boost had anyway, and it costs one pass over a grid 256 times smaller.
	const distToWater = new Int32Array(n).fill(-1);
	{
		const queue: number[] = [];
		for (let i = 0; i < n; i++)
			if (sea[i] || acc[i] > RIVER_T) {
				distToWater[i] = 0;
				queue.push(i);
			}
		for (let head = 0; head < queue.length; head++) {
			const i = queue[head];
			const x = i % COARSE_SIZE;
			const y = (i / COARSE_SIZE) | 0;
			for (const [dx, dy] of NEIGHBORS4) {
				const nx = x + dx;
				const ny = y + dy;
				if (nx < 0 || ny < 0 || nx >= COARSE_SIZE || ny >= COARSE_SIZE) continue;
				const j = ny * COARSE_SIZE + nx;
				if (distToWater[j] !== -1) continue;
				distToWater[j] = distToWater[i] + 1;
				queue.push(j);
			}
		}
	}

	return { downhill, acc, sea, distToWater };
}

const coarse = buildCoarse();

/**
 * Is this tile part of a river channel?
 *
 * **One tile wide, by construction rather than by tuning** — the single biggest simplification the
 * coarse grid buys. The old generator decided this per tile with an accumulation threshold, and
 * channel width was an emergent property of how the flood's tie-breaking spread across flat ground:
 * it produced 30-tile-wide "rivers" on plateaus, needed a chaotic noise field to fix, and then
 * needed that field's amplitude swept jointly against the threshold on every grid change because
 * the two traded width against straightness. Here the channel is *drawn*: from each river cell's
 * node point to its downhill neighbour's node point, as an L — horizontal leg then vertical leg.
 *
 * Three properties fall out of that with nothing to tune:
 *  - **Width is exactly one tile**, everywhere, always.
 *  - **The channel is 4-connected end to end.** The two legs share a corner, and consecutive cells
 *    share a node point, so the whole drainage tree is orthogonally contiguous — which is what makes
 *    a river something a body can walk the length of rather than a string of corner-touching
 *    puddles.
 *  - **Every river reaches the sea**, because the coarse drainage tree does and this traces it.
 *
 * The scan is over the coarse cells near this tile rather than the tile's own cell alone: a node is
 * jittered up to `NODE_JITTER` of a cell from centre and its leg reaches into the neighbouring
 * cell, so a channel belonging to a cell two over can legitimately cross here. Two cells of margin
 * covers that with room to spare, and it is 25 O(1) tests, not a search.
 */
function riverAt(x: number, y: number): boolean {
	const cx0 = Math.floor(x / COARSE);
	const cy0 = Math.floor(y / COARSE);
	for (let cy = cy0 - 2; cy <= cy0 + 2; cy++) {
		if (cy < 0 || cy >= COARSE_SIZE) continue;
		for (let cx = cx0 - 2; cx <= cx0 + 2; cx++) {
			if (cx < 0 || cx >= COARSE_SIZE) continue;
			const i = cy * COARSE_SIZE + cx;
			if (coarse.acc[i] <= RIVER_T) continue;
			const ax = nodeX(cx, cy);
			const ay = nodeY(cx, cy);
			const d = coarse.downhill[i];
			// An outlet cell has no downhill neighbour: run its channel straight out to the sea edge,
			// which SEA_DEPTH guarantees is water. Without this the trunk of every river would stop one
			// node short of the coast and read as a channel that never arrives.
			const bx = d === -1 ? GRID_SIZE - 1 : nodeX(d % COARSE_SIZE, (d / COARSE_SIZE) | 0);
			const by = d === -1 ? ay : nodeY(d % COARSE_SIZE, (d / COARSE_SIZE) | 0);
			// Horizontal leg at ay, from ax to bx; then vertical leg at bx, from ay to by.
			if (y === ay && x >= Math.min(ax, bx) && x <= Math.max(ax, bx)) return true;
			if (x === bx && y >= Math.min(ay, by) && y <= Math.max(ay, by)) return true;
		}
	}
	return false;
}

// Thresholds. Picked by eye against `npm run map`: water below WATER_T (declared above, next to the
// SEA_DEPTH derived from it), then habitable, then Hills, then Mountain at the top. Both sit high
// enough that the habitable band — meadow, forest, and the deposits banded within it — stays the
// majority of the map: most of `elevationAt`'s mass is mid-band, and the ridge's long tail is what
// actually reaches these.
//
// **These no longer move with GRID_SIZE.** Every previous grid change retuned them, because the old
// `field` drew a lattice sized to the grid and so handed back a genuinely different elevation
// histogram at every world size. `hashNoise` gives the same value at the same lattice point forever
// (see its own comment), so a bigger world is more of the same world and these describe it
// unchanged. The floors in worldgen.test.ts stay anyway — they are cheap, and they are what would
// catch this claim turning out to be wrong.
const HILLS_T = 0.8;
const MOUNTAIN_T = 0.855;

// How far the moisture boost reaches and how much it adds at zero distance. Two coarse cells is
// ~32 tiles — a river valley's worth of damp ground, enough to thicken a forest along the water
// without painting the entire habitable band as woodland.
// Where a tile carries a deposit rather than plain ground. Read off the mineral field's own
// distribution (its p84) rather than guessed: this was 0.84 when `minerals` was a single octave of
// value noise, which is roughly uniform, and multi-octave fBm concentrates toward 0.5 — at the old
// threshold the new field put deposits on 0.02% of the map instead of 12%, which sealed the ladder.
const MINERAL_T = 0.64;

const MOISTURE_RANGE = 2;
const MOISTURE_BOOST = 0.35;
const FOREST_T = 0.55;

// Deposit banding within the habitable band: clay nearest the water, iron highest, just under the
// Hills line.
const habitable = HILLS_T - WATER_T;
// Cut at 0.71 / 0.92 of the habitable span rather than 0.55 / 0.8: elevation is not uniform across
// that span, it is bunched near its top, so the old fractions put almost every deposit above the
// high cut — 3.5% iron against 1.0% clay. These land the three roughly even.
const midBand = WATER_T + habitable * 0.71;
const highBand = WATER_T + habitable * 0.92;

/**
 * The terrain char for one tile — the whole generator, as a pure function.
 *
 * Chunk-cached, because the callers that matter ask in runs rather than at random: the client
 * redraws a viewport every frame, `findStarts` sweeps a neighbourhood, and the seed's own checks
 * walk a block. A cold tile costs roughly a dozen noise evaluations and twenty-five O(1) channel
 * tests; a cached one costs an array read. See `chunkFor`.
 */
export function terrainCharAt(x: number, y: number): string {
	return String.fromCharCode(chunkFor(x, y)[(y & CHUNK_MASK) * CHUNK + (x & CHUNK_MASK)]);
}

/**
 * The same answer, without touching the chunk cache — for callers sampling the world sparsely
 * rather than walking a neighbourhood.
 *
 * The distinction is worth the second export because the cache actively hurts that case: a chunk is
 * 4,096 tiles, so a caller taking one sample every 35 tiles (the whole-world overview) pays for
 * 1,225 classifications it will never read, and evicts a cache somebody else was using to do it.
 * Measured: the whole-world view in `npm run map` went from 18 s to well under a second by
 * classifying the ~40,000 tiles it actually draws instead of the 47.8M it was touching.
 */
export function terrainCharDirect(x: number, y: number): string {
	return String.fromCharCode(classify(x, y));
}

function classify(x: number, y: number): number {
	if (riverAt(x, y)) return WATER;
	const e = elevationAt(x, y);
	// Sea, not merely low: the coarse sea mask is what keeps a sealed-off inland basin from reading
	// as ocean. A basin that fails it falls through to the ordinary bands below on its own real
	// elevation, which reads as low, damp ground — not a special case.
	if (e < WATER_T && coarse.sea[coarseIndex(x, y)]) return WATER;
	if (e > MOUNTAIN_T) return MOUNTAIN;
	if (e > HILLS_T) return HILLS;
	if (minerals(x, y) > MINERAL_T) return e > highBand ? IRON : e > midBand ? STONE_CHAR : CLAY;
	const dist = coarse.distToWater[coarseIndex(x, y)];
	const boost = dist >= 0 ? MOISTURE_BOOST * Math.max(0, 1 - dist / MOISTURE_RANGE) : 0;
	return moistureNoise(x, y) + boost > FOREST_T ? FOREST_CHAR : MEADOW;
}

const coarseIndex = (x: number, y: number) =>
	Math.min(COARSE_SIZE - 1, Math.floor(y / COARSE)) * COARSE_SIZE +
	Math.min(COARSE_SIZE - 1, Math.floor(x / COARSE));

// Char codes, so a chunk is a Uint8Array rather than an array of one-character strings.
const MEADOW = 46; // '.'
const FOREST_CHAR = 102; // 'f'
const WATER = 119; // 'w'
const HILLS = 104; // 'h'
const MOUNTAIN = 109; // 'm'
const STONE_CHAR = 115; // 's'
const CLAY = 99; // 'c'
const IRON = 105; // 'i'

// 64x64 tiles a chunk — 4 KB each, and big enough that a client viewport at close zoom is a handful
// of them. CHUNK must stay a power of two: the masking in `terrainCharAt` depends on it.
const CHUNK = 64;
const CHUNK_MASK = CHUNK - 1;
// How many chunks to keep. 4,096 is 16 MB and covers a 4,096 x 4,096-tile working set — far more
// than any one viewport or start search touches, and bounded, which is the property that matters on
// a long-lived lambda instance. ponytail: eviction is "drop the whole map when it is full", not
// LRU. Every consumer here works over a locality that fits, so a wholesale drop is rare; make it an
// LRU the day a profile shows this thrashing.
const CHUNK_BUDGET = 4096;
const chunks = new Map<number, Uint8Array>();

function chunkFor(x: number, y: number): Uint8Array {
	const cx = x >> 6;
	const cy = y >> 6;
	const key = cy * ((GRID_SIZE >> 6) + 1) + cx;
	const hit = chunks.get(key);
	if (hit) return hit;
	const built = new Uint8Array(CHUNK * CHUNK);
	const x0 = cx * CHUNK;
	const y0 = cy * CHUNK;
	for (let j = 0; j < CHUNK; j++)
		for (let i = 0; i < CHUNK; i++) built[j * CHUNK + i] = classify(x0 + i, y0 + j);
	if (chunks.size >= CHUNK_BUDGET) chunks.clear();
	chunks.set(key, built);
	return built;
}

// The meadow char. Named because the start rule is written in terms of it and 'nothing but "."'
// reads like a typo.
const GRASS = '.';
// How much clear grass a new realm opens with around its buildings, on every side. Two, so the
// hamlet has somewhere to grow into and nobody starts wedged against a lake.
const START_MARGIN = 2;

// Forest and Stone, the two terrain chars `hasStartingResources` below is watching for.
const FOREST = 'f';
const STONE = 's';

// How much of each the opening circle has to hold. Stone is one tile because an outcrop never runs
// down — `seed.ts` gives it no capacity, so one is an endless supply and a second adds nothing.
//
// Forest is eight because a forest tile very much does run down, and "at least one" turned out to
// be a guarantee in name only. A tile holds 25 Wood and takes thirty days to grow back; the reach
// gates outward, so a realm cannot answer a stripped forest by walking to the next one until its
// population earns the next milestone. One tile is 25 Wood, stripped in about eight hours by the
// three settlers a realm opens with, and then a month of nothing. Eight is 200, which is a couple
// of days' gathering — comfortably longer than growing 3 people to the 8 that widen the circle.
const START_FOREST = 8;
const START_STONE = 1;

/**
 * Does the *starting* reach — a `START_REACH_RADIUS` circle around where the Marketplace will
 * stand, one tile north of the hamlet — actually hold enough wood and stone to open with? The reach
 * gates gathering as well as building (it's a sphere of influence, not a building permit), so
 * "reachable" now means "in reach". Uses the same Euclidean test the server gate and the drawn
 * circle use, so the search and the rule it is searching for can never quietly disagree about the
 * shape of a circle.
 */
function hasStartingResources(hx: number, hy: number) {
	const reach = { x: hx, y: hy - 1, radius: START_REACH_RADIUS };
	let forest = 0;
	let stone = 0;
	for (let y = reach.y - reach.radius; y <= reach.y + reach.radius; y++)
		for (let x = reach.x - reach.radius; x <= reach.x + reach.radius; x++) {
			if (x < 0 || y < 0 || x >= GRID_SIZE || y >= GRID_SIZE) continue;
			if (!withinReach(x, y, reach)) continue;
			const c = terrainCharAt(x, y);
			if (c === FOREST) forest++;
			else if (c === STONE) stone++;
			if (forest >= START_FOREST && stone >= START_STONE) return true;
		}
	return false;
}

/**
 * How far apart two accepted openings must sit.
 *
 * **Not "two mature reaches just touching" any more**, which is what this was and which produced a
 * world with no wilderness in it at any size: the search accepts every candidate that clears the
 * bar, so a separation of exactly `MATURE_REACH_RADIUS * 2` packs any map to roughly 68% claimed
 * land, neighbours shoulder to shoulder. Lands of Lords — the north star — runs 113 domains over a
 * continent that is 86% wild, and that ratio is the thing that makes travelling somewhere mean
 * anything.
 *
 * `WILDERNESS_RATIO` is how many mature-reach diameters of empty ground sit between two realms'
 * borders. 2.5 lands claimed land near LoL's own 14% at the grid size this world is built for; it
 * is a game-feel number, tune it and the frontier gets wider or narrower without anything else
 * moving. Derived from MATURE_REACH_RADIUS rather than written down separately, so a retuned
 * milestone ladder (seed.ts) cannot leave it stale.
 */
const WILDERNESS_RATIO = 1.87;
const MIN_START_SEPARATION = Math.round(MATURE_REACH_RADIUS * 2 * WILDERNESS_RATIO);

/** The hamlet, its two flanking buildings, the Marketplace, and the settlers' row — everything a
 * fresh realm needs placed, derived from the one tile that anchors all of it. */
export type StartBlock = {
	hamletX: number;
	hamletY: number;
	house2X: number;
	house2Y: number;
	barnX: number;
	barnY: number;
	marketX: number;
	marketY: number;
	characterX: number;
	characterY: number;
};

function startBlockFor(hx: number, hy: number): StartBlock {
	return {
		hamletX: hx,
		hamletY: hy,
		// Its own tile so the two Houses don't stack into one pawn.
		house2X: hx - 1,
		house2Y: hy,
		barnX: hx + 1,
		barnY: hy,
		// The Marketplace, and so the centre of the realm's reach — one tile north of the hamlet.
		// Inside `findStarts`'s cleared block and standing on nothing, so no other building has to
		// move for it.
		marketX: hx,
		marketY: hy - 1,
		// The settlers stand shoulder to shoulder on the row below, from characterX - 1.
		characterX: hx,
		characterY: hy + 1
	};
}

/**
 * How far apart the candidate sweep steps. The search used to test *every* tile on the map, which
 * at 47.8M tiles is 47.8M full classifications plus a 113-tile reach census on each survivor — the
 * single most expensive thing in this file by a wide margin, and pure waste: accepted openings end
 * up `MIN_START_SEPARATION` apart regardless, so all but a handful of those candidates were only
 * ever going to be rejected for being too close to one already taken.
 *
 * 10 tiles is fifty times finer than the separation the packer enforces, so the openings it finds
 * sit within a few tiles of the ones an exhaustive sweep would have picked — and it is a hundredfold
 * less work. It is a real trade against a perfect packing, bought for a search that costs seconds
 * instead of an hour.
 *
 * It is not merely a speed dial: a legal opening needs clear meadow *and* wood *and* stone inside a
 * six-tile circle, which is a rare conjunction, so the stride sets how many of them the map actually
 * offers. At 24 this world yielded 35 openings against the ~110 it can hold. The cheap test (`clear`)
 * runs first and rejects almost everything, so a finer sweep costs far less than the candidate count
 * suggests.
 */
const START_STRIDE = 10;

/**
 * Every opening the generated map holds: legal by the same rule as ever (a `START_MARGIN`-clear
 * block of grass, `START_FOREST` Forest and `START_STONE` Stone inside its own
 * `START_REACH_RADIUS` circle), no two closer than `MIN_START_SEPARATION`.
 *
 * Searched rather than declared: a hand-placed constant cannot notice when the ground under it
 * moves.
 *
 * Deterministic, and reproducible for the same map: candidates are swept on a fixed stride, ordered
 * closest-to-the-map's-centre first (ties broken by scan order), then accepted greedily, a
 * candidate joining only if it is far enough from every start already accepted.
 */
function findStarts(): { x: number; y: number }[] {
	// Buildings on `y`, settlers on `y + 1`, three wide and centred on the hamlet — then the margin
	// around all of it. The Marketplace tile (hx, hy - 1) already sits inside this block, so a
	// candidate that clears it needs no separate check.
	const clear = (hx: number, hy: number) => {
		for (let x = hx - 1 - START_MARGIN; x <= hx + 1 + START_MARGIN; x++)
			for (let y = hy - START_MARGIN; y <= hy + 1 + START_MARGIN; y++) {
				if (x < 0 || y < 0 || x >= GRID_SIZE || y >= GRID_SIZE) return false;
				if (terrainCharAt(x, y) !== GRASS) return false;
			}
		return true;
	};
	const mid = (GRID_SIZE - 1) / 2;
	const candidates: { x: number; y: number; d: number }[] = [];
	for (let y = 0; y < GRID_SIZE; y += START_STRIDE)
		for (let x = 0; x < GRID_SIZE; x += START_STRIDE) {
			if (!clear(x, y) || !hasStartingResources(x, y)) continue;
			candidates.push({ x, y, d: Math.hypot(x - mid, y - mid) });
		}
	// A stable sort (guaranteed since ES2019) keeps same-distance candidates in scan order.
	candidates.sort((a, b) => a.d - b.d);

	const accepted: { x: number; y: number }[] = [];
	for (const c of candidates) {
		if (accepted.every((a) => Math.hypot(a.x - c.x, a.y - c.y) >= MIN_START_SEPARATION))
			accepted.push({ x: c.x, y: c.y });
	}
	return accepted;
}

/**
 * The seed the world is actually made of. It used to be possible for this to differ from
 * `WORLD_SEED`: the generator rerolled until it found a map with somewhere to live. That loop is
 * gone with the eager whole-grid build it depended on — rerolling now means rebuilding the coarse
 * grid and re-sweeping for starts, and "no opening anywhere on a continent" is not a failure mode a
 * 47.8M-tile map has. `findStarts` throwing is the honest report if it ever becomes one.
 */
export const MAP_SEED = WORLD_SEED;

/**
 * Every realm-sized opening the map holds, closest-to-centre first and mutually
 * `MIN_START_SEPARATION` apart — see `findStarts`. `ensurePlayer` (world.server.ts) claims the
 * first unclaimed one from the `start_position` table the seed writes this into; once every row is
 * claimed the world is full, and it says so rather than stacking a second realm on one opening.
 *
 * Lazy, and deliberately: this is a multi-second sweep and only the seed and the tests ever want
 * it. The server imports this module for `terrainCharAt` on every cold start and must not pay for a
 * start search it never reads — which is exactly what a module-level `findStarts()` call did.
 */
let startsCache: StartBlock[] | null = null;
export function starts(): StartBlock[] {
	if (!startsCache) {
		const found = findStarts();
		if (found.length === 0)
			throw new Error(
				`no opening on the map has ${START_MARGIN} tiles of clear grass around a hamlet with ` +
					`${START_FOREST} Forest and ${START_STONE} Stone within ${START_REACH_RADIUS} tiles of ` +
					`its Marketplace — swept every ${START_STRIDE} tiles from seed ${WORLD_SEED}`
			);
		startsCache = found.map((s) => startBlockFor(s.x, s.y));
	}
	return startsCache;
}

/**
 * A square window of the map, row-major, one string per row — for `npm run map`, the tests, and
 * anything else that wants to look at a region rather than a tile.
 *
 * This replaced a `terrainMap()` that returned the *whole world* as an array of GRID_SIZE strings.
 * That was a reasonable shape at 128x128 and is 47.8M characters at the continent — about 100 MB of
 * JS strings to answer "what does the coastline look like". Every caller of it actually wanted
 * either a downsampled overview or a neighbourhood, and both are windows.
 */
export function terrainWindow(x0: number, y0: number, size: number, stride = 1): string[] {
	// Contiguous reads go through the chunk cache; anything sparser deliberately doesn't (see
	// `terrainCharDirect`). The break-even is stride 1, not "narrower than a chunk": a chunk costs
	// CHUNK^2 classifications and serves (CHUNK / stride)^2 samples, so the waste factor is exactly
	// stride^2 — already 4x at stride 2. Getting this condition wrong is not subtle and was not
	// theoretical: at `npm run map`'s whole-world stride of 35 it made the overview take 17 seconds
	// to draw 39,204 tiles, by classifying 47.8 million of them.
	const at = stride === 1 ? terrainCharAt : terrainCharDirect;
	const rows: string[] = [];
	for (let j = 0; j < size; j++) {
		let row = '';
		for (let i = 0; i < size; i++) {
			const x = x0 + i * stride;
			const y = y0 + j * stride;
			row += x < 0 || y < 0 || x >= GRID_SIZE || y >= GRID_SIZE ? ' ' : at(x, y);
		}
		rows.push(row);
	}
	return rows;
}

/**
 * How many tiles of each terrain the world holds, as a share of the whole — sampled on a stride
 * rather than counted exhaustively, which is what makes it affordable to ask at all at continent
 * scale. `stride` 8 is one tile in 64 and gives shares stable to well under a tenth of a percent
 * for anything that covers more than a handful of tiles; the rarest terrain here is Stone at ~1%.
 *
 * Returned as counts of *samples*, not of tiles: callers want the shares, and multiplying back up
 * would dress an estimate as an exact number.
 */
export function terrainCensus(stride = 8): Map<string, number> {
	const counts = new Map<string, number>();
	for (let y = 0; y < GRID_SIZE; y += stride)
		for (let x = 0; x < GRID_SIZE; x += stride) {
			const c = terrainCharDirect(x, y);
			counts.set(c, (counts.get(c) ?? 0) + 1);
		}
	return counts;
}

/**
 * A stable, order-independent summary of the coarse hydrology grid — the drainage tree and its
 * accumulation, which is where every non-local decision in this file lives.
 *
 * Exists so `worldgen.hash.ts` can fold the hydrology into the terrain hash without this module
 * exporting its mutable internals, and without this module importing `node:crypto`. That import is
 * why the split exists at all: the browser runs this generator now, and a `node:` builtin anywhere
 * in the client's module graph is a bundling problem waiting to happen. Tree-shaking would probably
 * have dropped it; "probably" is not a good property for a build to have.
 *
 * Accumulation is rounded because it is a float sum whose last bits are not a fact about the world —
 * without that, a reordering inside the reduction would change the hash and read as a changed map.
 */
export function coarseFingerprint(): string {
	let out = '';
	for (let i = 0; i < coarse.downhill.length; i++)
		out += `${coarse.downhill[i]}:${Math.round(coarse.acc[i])};`;
	return out;
}
