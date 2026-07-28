// What terrain sits on every tile of the world, as one char per tile. The seed turns these into
// rows; this decides what they are.
//
// Fully generated, one source. There used to be a hand-authored core (`LAYOUT`) sitting in the
// middle of the map, because the start tiles and the travel demo needed to be exactly what they
// were — but that stopped being a fair trade once the world grew past what hand-authoring can
// cover: `findStart` searches the generated ground for a legal opening instead of one being drawn
// for it (see below), and scripts/rules-check.ts finds its terrain features in the payload rather
// than naming a coordinate. One alphabet, one code path, no second frame to keep in sync.
//
// Deterministic on purpose. `vercel-build` re-runs the seed on every deploy, and the tile grid is
// upserted rather than rebuilt: a generator that rolled fresh each time would rearrange the ground
// under standing buildings and other players' half-cleared forests. Same seed, same world, forever
// — a new map is a `WORLD_SEED` edit, and a deliberate one.
//
// A named pipeline now, not three fields and five thresholds: domain-warped fBm for elevation, a
// falloff toward one chosen edge for the sea (the coastline is wherever the water threshold and
// that falloff happen to cross — emergent, never drawn), a ridged multifractal added into the high
// band so mountains come out as chains, a second elevation cut for Hills between lowland and peak,
// then priority-flood depression filling → D4 downhill directions → flow accumulation for rivers
// that are guaranteed to reach the sea by construction rather than by luck. D4, not the more usual
// D8, because a river has to be a channel you could walk the length of — see the comment on
// `priorityFlood` for the corner-only channels D8 produced instead. Moisture (and so forest vs.
// meadow) is lifted near whatever water the hydrology pass produced, so woodland reads as a region
// rather than a coin flip per tile. Full technique names are in the comments below, next to the
// code that earns them — this file is the whole of the R-step research turned into something
// `npm run map` can be checked against.

// The `.ts` extension is load-bearing: this module is imported by `scripts/` under plain Node,
// which does not resolve extensionless paths. Same reason world.test.ts writes it that way.
import { GRID_SIZE, START_REACH_RADIUS, withinReach } from './world.ts';

// Bumped for the 128×128 cut (decision 3): a clean break rather than 7× the old world regenerated
// under standing buildings. `npm run seed -- --wipe` is the deliberate step that actually clears
// the ground for it — this constant alone changes nothing for anybody already playing.
/** Change this and the world changes. Nothing else does. */
export const WORLD_SEED = 90210;

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

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const smoothstep = (t: number) => t * t * (3 - 2 * t);

/**
 * Fractal Brownian motion: `octaves` calls to `field`, halving amplitude and halving spacing
 * (doubling frequency) each step, normalised back to roughly [0, 1). The coarse octave decides
 * where the broad shapes are — the sea, the ranges — and each finer one breaks their edges up, the
 * same idea the old two-field generator used but carried further. `seedBase` must not overlap the
 * seed offsets any other field in `generator` reads, or two "independent" layers would turn out to
 * be the same lattice.
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
 * midpoint first (`1 - |2n - 1|`), so instead of a smooth hill every octave contributes a *ridge*
 * — high wherever that octave's noise crosses 0.5, low either side of it. A ridge is a connected
 * line by construction (it's a contour of the underlying noise), so adding this into elevation
 * before the mountain cut is what turns "high ground" into chains rather than the speckle a plain
 * height threshold gives.
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

// Eight-way, for the moisture distance transform below — a soft "how far to the nearest water"
// estimate, where a diagonal shortcut is a fine approximation because nothing has to *walk* it.
const NEIGHBORS8: readonly [number, number][] = [
	[-1, -1],
	[0, -1],
	[1, -1],
	[-1, 0],
	[1, 0],
	[-1, 1],
	[0, 1],
	[1, 1]
];

// Four-way, for the hydrology below (priority-flood, D4 flow direction, accumulation). Diagonals
// were tried here first and rejected: a D8 downhill step can carve a channel that only ever
// touches its neighbours corner-to-corner, which prints as a connected line but is 682 orphaned
// puddles under any 4-connected reading — including a player's own pathing, which is orthogonal
// movement plus diagonal steps between *open* tiles, not a guarantee that a strand of water one
// corner wide is a channel at all. D4 makes a river orthogonally contiguous by construction, so
// there is nothing left to accidentally get wrong at classification time.
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
 * Priority-flood depression filling, done together with D4 flow-direction assignment — the
 * standard combined form of the algorithm (Barnes, Lehman & Mulla 2014), adapted to four
 * directions rather than the textbook eight: expand outward from the outlets in order of rising
 * elevation, and whichever cell discovers a tile first is, by construction, that tile's downhill
 * neighbour. One pass gives both the filled DEM and the drainage tree.
 *
 * D4, not D8, and deliberately: D8 was tried first, on the reasoning that `route`'s own eight-way
 * movement made it the "consistent" choice, and it produced a river that measured as one connected
 * component only because corner-touching tiles counted as touching — 682 of the 3,123 water tiles
 * on the seed this was tuned against turned out to be single-tile puddles joined to their
 * neighbours only diagonally, invisible to a 4-connected reading and to a player trying to trace
 * the thing. A channel has to be orthogonally contiguous to be a channel; D4 makes that true by
 * construction instead of hoping the classification step notices when it isn't.
 *
 * `outlets` is deliberately not "every border cell", the textbook seed set — it is only the tiles
 * on the map's one sea edge (see `generator` below). Seeding just that edge is what turns "drains
 * to the map edge" into "drains to the sea": a basin that would otherwise spill off a
 * mountain-side edge is filled instead, because that edge was never offered as an escape. Every
 * reachable cell ends up with a downhill path that lands on the sea, 4-connected the whole way,
 * which is the connectivity `worldgen.test.ts` checks for.
 *
 * The `+ EPS` on each fill is what keeps the result strictly downhill even across a lattice cell
 * that would otherwise tie with its neighbour: without it, two tiles filled to the same height
 * would have nowhere to send their flow, and accumulation would stall on the plateau instead of
 * reaching the sea.
 */
function priorityFlood(
	elevation: Float64Array,
	outlets: number[]
): { downhill: Int32Array; order: number[] } {
	const n = elevation.length;
	const filled = new Float64Array(n);
	const downhill = new Int32Array(n).fill(-1);
	const visited = new Uint8Array(n);
	const order: number[] = [];
	const heap = new MinHeap();
	const EPS = 1e-6;

	for (const i of outlets) {
		visited[i] = 1;
		filled[i] = elevation[i];
		heap.push(filled[i], i);
	}
	while (heap.size > 0) {
		const { key, i } = heap.pop();
		order.push(i);
		const x = i % GRID_SIZE;
		const y = (i / GRID_SIZE) | 0;
		for (const [dx, dy] of NEIGHBORS4) {
			const nx = x + dx;
			const ny = y + dy;
			if (nx < 0 || ny < 0 || nx >= GRID_SIZE || ny >= GRID_SIZE) continue;
			const j = ny * GRID_SIZE + nx;
			if (visited[j]) continue;
			visited[j] = 1;
			filled[j] = Math.max(elevation[j], key + EPS);
			downhill[j] = i;
			heap.push(filled[j], j);
		}
	}
	return { downhill, order };
}

/**
 * Upstream flow accumulation, given the drainage tree `priorityFlood` produced: how many tiles'
 * worth of flow pass through each cell on their way to an outlet. `order` is outlet-to-summit (the
 * flood's own pop order), so walking it backwards visits every cell after everything that drains
 * into it — one pass is enough to fold each cell's whole upstream catchment into itself and hand
 * the total down to its own downhill neighbour.
 */
function flowAccumulation(downhill: Int32Array, order: number[]): Float64Array {
	const acc = new Float64Array(downhill.length).fill(1);
	for (let k = order.length - 1; k >= 0; k--) {
		const i = order[k];
		const d = downhill[i];
		if (d !== -1) acc[d] += acc[i];
	}
	return acc;
}

/**
 * Generated ground, for one seed. Builds the whole grid eagerly rather than sampling lazily per
 * tile, because the hydrology stage (priority-flood, D4, flow accumulation) is a whole-grid
 * algorithm by nature — there's no such thing as "the river at just this one tile" without knowing
 * its neighbours. Everything else in the pipeline could stay a pure `(x, y) => value` closure like
 * the old generator; this one can't, so nothing here does, for consistency.
 *
 * The stages, in the order the plan names them:
 *  1. **Elevation** — domain-warped fBm (`fbm`), so ranges meander instead of reading as the
 *     circular lattice a single `field()` call gives.
 *  2. **Sea** — elevation multiplied down toward one chosen edge (`SEA_EDGE_X`). `LAND_FLOOR` is a
 *     hard clamp on elevation *before* that falloff, so no amount of noise can ever put water on
 *     one of the other three edges — only the band next to the sea edge can ever read as water,
 *     and the coastline within that band is wherever `WATER_T` happens to cross the noise.
 *  3. **Mountain ranges** — a ridged multifractal (`ridged`) added on top, scaled by how "high" the
 *     ground already reads so it piles onto real high ground rather than punching false peaks out
 *     of the lowlands or the sea.
 *  4. **Hills** — one more elevation cut, between the habitable band and the mountain band.
 *  5. **Rivers** — `priorityFlood` + `flowAccumulation`, seeded only from the sea edge, so every
 *     drop of water on the map is guaranteed a monotonically downhill path to the sea. A tile whose
 *     accumulation clears `RIVER_T` is Water regardless of what its elevation alone would have said
 *     — the same rule a real valley follows.
 *  6. **Moisture** — a noise field, lifted near whichever water stages 2 and 5 actually produced
 *     (a breadth-first distance transform from every Water tile), so forest reads as a region
 *     rather than a coin flip per tile.
 *  7. **Deposits** — the same mineral field as before, still banded by elevation within the
 *     habitable band.
 */
function generator(seed: number): (x: number, y: number) => string {
	const n = GRID_SIZE * GRID_SIZE;
	const idx = (x: number, y: number) => y * GRID_SIZE + x;

	// Seed offsets below are each given their own block so that no two "independent" fields ever
	// read the same lattice: 0–9 for the elevation fBm's octaves, 10–19 for the ridge's, 20–21 for
	// the domain warp, 22 for minerals, 23 for moisture, 24 for the hydrology nudge.
	const heightField = fbm(seed, 4, 40);
	const ridgeField = ridged(seed + 10, 4, 34);
	const warpX = field(seed + 20, 24);
	const warpY = field(seed + 21, 24);
	const minerals = field(seed + 22, 4);
	const moistureNoise = field(seed + 23, 11);

	// Domain warp: elevation is sampled at (x, y) *displaced* by a second pair of noise fields,
	// rather than at (x, y) itself. A straight fBm call reads as rings around each octave's lattice
	// points — warping the sample point is the standard fix, and it's why this map's ranges bend
	// instead of reading as the old generator's blobs. Clamped back onto the grid: a warp is a
	// lookup into `field`'s own lattice, and that lattice doesn't extend past the edges.
	const WARP_STRENGTH = 16;
	const warpedAt = (x: number, y: number) => ({
		wx: clamp(x + (warpX(x, y) - 0.5) * 2 * WARP_STRENGTH, 0, GRID_SIZE - 1),
		wy: clamp(y + (warpY(x, y) - 0.5) * 2 * WARP_STRENGTH, 0, GRID_SIZE - 1)
	});

	// The sea sits against the east edge — arbitrary, but it's the edge VISION's own example map
	// names ("the sea is east"). SEA_BAND is how wide the coastal falloff reaches inland; LAND_FLOOR
	// is the hard floor described above. SEA_DEPTH is set to `1 - WATER_T` (`fbm`'s output is
	// mathematically bounded to [0, 1), so `land` never reaches 1) — not tuned by eye like the rest
	// of this block, but *derived*, so the very edge column is a hard guarantee of water rather
	// than a statistical likelihood. Without that guarantee, a tall enough headland can rise right
	// at x = SEA_EDGE_X and pinch the coastline into two components that both still "touch the sea
	// edge" — the sea would technically still keep to one edge, but stop being one connected sea.
	const SEA_EDGE_X = GRID_SIZE - 1;
	const SEA_BAND = Math.round(GRID_SIZE * 0.18);
	const LAND_FLOOR = 0.42;
	const WATER_T = 0.32;
	const SEA_DEPTH = 1 - WATER_T + 0.02;
	const seaFalloff = (x: number) => smoothstep(clamp((SEA_EDGE_X - x) / SEA_BAND, 0, 1));
	// A strip that runs the map's whole height necessarily reaches the northeast and southeast
	// corners, which sit on the north/south edges too — without this, "one edge" quietly becomes
	// two wherever the coast meets a corner. Tapering the depression out near y = 0 and
	// y = GRID_SIZE - 1 curls the coastline back from both corners instead, the same hard-clamp
	// approach LAND_FLOOR uses rather than hoping the noise never reaches that far.
	const CORNER_MARGIN = 10;
	const cornerTaper = (y: number) =>
		smoothstep(clamp(Math.min(y, GRID_SIZE - 1 - y) / CORNER_MARGIN, 0, 1));

	// The other three edges are rim, not coast — high ground the way VISION's own example map
	// describes ("the range walls off the north"), and *load-bearing* high ground: without it,
	// flow accumulation occasionally routes a real river along the very edge of the grid, and the
	// river tests below need every Water tile to reach the sea, not just the tiles that aren't
	// sitting on a border the sea rule already had to keep dry. Raising the rim is what keeps both
	// promises with one mechanism instead of a second special case at classification time — a
	// river simply has nowhere low enough to run along the border in the first place.
	const EDGE_MARGIN = 8;
	const EDGE_LIFT = 0.3;
	const edgeLift = (x: number, y: number) => {
		const distToRim = Math.min(x, y, GRID_SIZE - 1 - y);
		return EDGE_LIFT * (1 - smoothstep(clamp(distToRim / EDGE_MARGIN, 0, 1)));
	};

	// Thresholds. Picked by eye against `npm run map` (see the comment on each): water below
	// WATER_T (declared above, next to the SEA_DEPTH that's derived from it), then habitable, then
	// Hills, then Mountain at the top — the same "cut a height field into bands" idea the old
	// generator used, just against a richer field. HILLS_T and MOUNTAIN_T sit high (most of
	// `elevation`'s mass is mid-band; the ridge's long tail is what actually reaches them) so the
	// habitable band — meadow, forest, and the deposits banded within it — stays the majority of
	// the map, the way the pre-ridge generator's did.
	const HILLS_T = 0.9;
	const MOUNTAIN_T = 1.02;
	// A tile over this many upstream tiles' worth of flow is a river. There's no natural absolute
	// scale for accumulation — it depends on how the drainage tree happens to branch — so this is
	// tuned against the printed map rather than derived, and tuned high: at 40 (this constant's
	// first value) almost a quarter of the map read as water, most of it a diffuse wet texture
	// rather than anything you'd call a river. 1800 leaves a handful of trunk rivers with visible
	// tributaries — inland water (the sea's own coastal band excluded) lands around 1% of the map,
	// not the ~10% a low threshold gives.
	const RIVER_T = 1800;

	// The ridge only piles onto land that already reads as high ground — gated smoothly between
	// RIDGE_GATE_LOW and RIDGE_GATE_HIGH — rather than scaling every tile by however "tall" it is.
	// A flat `* land` multiplier (the first thing tried here) lifts the *whole* map a little, since
	// most of the grid is mid-elevation, not just the would-be peaks; gating on a narrow high band
	// is what keeps the ridge a mountain-range effect instead of a global elevation bump.
	const RIDGE_WEIGHT = 0.6;
	const RIDGE_GATE_LOW = 0.62;
	const RIDGE_GATE_HIGH = 0.82;
	const ridgeGate = (land: number) =>
		smoothstep(clamp((land - RIDGE_GATE_LOW) / (RIDGE_GATE_HIGH - RIDGE_GATE_LOW), 0, 1));

	const elevation = new Float64Array(n);
	for (let y = 0; y < GRID_SIZE; y++)
		for (let x = 0; x < GRID_SIZE; x++) {
			const { wx, wy } = warpedAt(x, y);
			const land = Math.max(heightField(wx, wy), LAND_FLOOR);
			const drowned = land - SEA_DEPTH * (1 - seaFalloff(x)) * cornerTaper(y);
			elevation[idx(x, y)] =
				drowned + RIDGE_WEIGHT * ridgeField(wx, wy) * ridgeGate(land) + edgeLift(x, y);
		}

	// A rescale onto [LAND_FLOOR, 1) was tried in place of the clamp above and rejected: it kept
	// every low tile's relative height, but it also shifted the *whole* distribution — the mid and
	// high bands moved too, which meant retuning every threshold below to get the census back in
	// bounds. The clamp is cheaper to keep and the actual fault is narrower than "the floor exists"
	// — it's that `priorityFlood` gets fed a perfectly flat plateau wherever a whole *stretch* of
	// ground clamps to the same 0.42, and flow accumulation has no real gradient to converge along
	// there. `hydroElevation` is a copy of elevation with a noise field added on *only* for the
	// hydrology to read — never for terrain classification, which stays on unperturbed `elevation`
	// throughout, so nothing here can relabel a tile's terrain band and the noise is free to be as
	// strong as the actual fault needs, not capped by some other threshold's headroom.
	//
	// What that fault needed turned out to be surprising. `EPS` alone breaks ties by discovery
	// order, not by anything resembling terrain, so a dozen parallel branches of the drainage tree
	// could each claim a lane across a flat stretch and none of them merge — a 30-tile-*wide*
	// "river". A smooth, low-amplitude noise field (`field(seed, 5)`, amplitude 0.09) fixed that
	// width problem, but left the surviving single channel running dead straight for up to 38 tiles
	// at a stretch — smooth noise, even sampled through its own short-wavelength domain warp,
	// didn't move that number, because `priorityFlood` visits cells in order of rising elevation and
	// hands each one a parent from whichever neighbour was visited first: on a truly flat surface
	// fed from one straight edge of outlets, that degenerates to "shortest path to the coast",
	// which is a straight line, and a *smooth* perturbation only wiggles around that line rather
	// than giving the flood a reason to prefer a different neighbour every few tiles. Only genuinely
	// chaotic, per-tile-independent noise — `field(seed, 1)`, spacing 1, no interpolation left to
	// smooth it — breaks that degeneracy: every tile is its own local pit or bump, so the "nearest"
	// unvisited neighbour keeps changing hand to hand instead of settling into one direction. 0.5 is
	// picked the same way as the rest of this pipeline: high enough that the longest straight run in
	// `npm run map` drops from 38 tiles to single digits, without pushing width back out (there's a
	// real trade — more noise breaks up straight runs but roughens the channel edge, so this is the
	// smallest amplitude that gets both).
	const hydroNoise = field(seed + 24, 1);
	const hydroElevation = new Float64Array(n);
	for (let y = 0; y < GRID_SIZE; y++)
		for (let x = 0; x < GRID_SIZE; x++) {
			const i = idx(x, y);
			hydroElevation[i] = elevation[i] + 0.5 * (hydroNoise(x, y) - 0.5);
		}

	// Rivers drain only to the sea edge — see the doc comment on `priorityFlood` for why seeding
	// just that column, rather than the whole border, is what guarantees every river reaches it.
	const outlets: number[] = [];
	for (let y = 0; y < GRID_SIZE; y++) outlets.push(idx(SEA_EDGE_X, y));
	const { downhill, order } = priorityFlood(hydroElevation, outlets);
	const acc = flowAccumulation(downhill, order);

	// Water: either the sea's own elevation cut, or a river's flow accumulation. Nothing here needs
	// to special-case the three non-sea edges — `edgeLift` already keeps them high enough that a
	// drainage channel has nowhere to run along them, so a plain accumulation cut is all this is.
	// (A per-tile "not on this edge" filter was tried here first and rejected: flow accumulation is
	// monotonic downhill, so silencing one cell on a real channel silences it only there, splitting
	// the visible river into two components instead of keeping it off the border to begin with.)
	const isWater = new Uint8Array(n);
	for (let y = 0; y < GRID_SIZE; y++)
		for (let x = 0; x < GRID_SIZE; x++) {
			const i = idx(x, y);
			isWater[i] = elevation[i] < WATER_T || acc[i] > RIVER_T ? 1 : 0;
		}

	// Moisture's water-proximity term: a breadth-first distance transform from every Water tile.
	// Eight-connected on purpose, unlike the hydrology above — this is a soft "how close is damp
	// ground" estimate, not a claim about a channel you could walk, so a diagonal shortcut is a
	// fine approximation rather than a bug. Multi-source, so it costs one pass over the grid
	// regardless of how many rivers or how much coastline there is.
	const distToWater = new Int32Array(n).fill(-1);
	const queue: number[] = [];
	for (let i = 0; i < n; i++)
		if (isWater[i]) {
			distToWater[i] = 0;
			queue.push(i);
		}
	for (let head = 0; head < queue.length; head++) {
		const i = queue[head];
		const x = i % GRID_SIZE;
		const y = (i / GRID_SIZE) | 0;
		for (const [dx, dy] of NEIGHBORS8) {
			const nx = x + dx;
			const ny = y + dy;
			if (nx < 0 || ny < 0 || nx >= GRID_SIZE || ny >= GRID_SIZE) continue;
			const j = ny * GRID_SIZE + nx;
			if (distToWater[j] !== -1) continue;
			distToWater[j] = distToWater[i] + 1;
			queue.push(j);
		}
	}
	// How far the boost reaches, and how much it can add to the raw moisture noise at zero
	// distance. Six tiles is a short walk from a riverbank, not a whole valley — enough to thicken
	// a forest along the water without painting the entire habitable band as woodland.
	const MOISTURE_RANGE = 6;
	const MOISTURE_BOOST = 0.35;
	const FOREST_T = 0.55;

	// Deposit banding within the habitable band, same idea as the old generator: clay nearest the
	// water, iron highest, just under the Hills line.
	const habitable = HILLS_T - WATER_T;
	const midBand = WATER_T + habitable * 0.55;
	const highBand = WATER_T + habitable * 0.8;

	const chars = new Array<string>(n);
	for (let y = 0; y < GRID_SIZE; y++)
		for (let x = 0; x < GRID_SIZE; x++) {
			const i = idx(x, y);
			if (isWater[i]) {
				chars[i] = 'w';
				continue;
			}
			const e = elevation[i];
			if (e > MOUNTAIN_T) {
				chars[i] = 'm';
				continue;
			}
			if (e > HILLS_T) {
				chars[i] = 'h';
				continue;
			}
			if (minerals(x, y) > 0.84) {
				chars[i] = e > highBand ? 'i' : e > midBand ? 's' : 'c';
				continue;
			}
			const dist = distToWater[i];
			const boost = dist >= 0 ? MOISTURE_BOOST * Math.max(0, 1 - dist / MOISTURE_RANGE) : 0;
			chars[i] = moistureNoise(x, y) + boost > FOREST_T ? 'f' : '.';
		}

	return (x, y) => chars[idx(x, y)];
}

// The meadow char. Named because the start rule is written in terms of it and 'nothing but "."'
// reads like a typo.
const GRASS = '.';
// How much clear grass a new realm opens with around its buildings, on every side. Two, so the
// hamlet has somewhere to grow into and nobody starts wedged against a lake — which is exactly
// what the authored core did before this rule existed.
const START_MARGIN = 2;

// Forest and Stone, the two terrain chars `hasStartingResources` below is watching for.
const FOREST = 'f';
const STONE = 's';

// How much of each the opening circle has to hold. Stone is one tile because an outcrop never runs
// down — `seed.ts` gives it no capacity, so one is an endless supply and a second adds nothing.
//
// Forest is eight because a forest tile very much does run down, and "at least one" turned out to
// be a guarantee in name only. A tile holds 25 Wood and takes thirty days to grow back; the seed's
// own note calls that ~90x gap the mechanic that "pushes you outward to new ground" — but the reach
// gates outward now, so a realm cannot answer a stripped forest by walking to the next one until
// its population earns the next milestone. One tile is 25 Wood, stripped in about eight hours by
// the three settlers a realm opens with, and then a month of nothing. Eight is 200, which is a
// couple of days' gathering — comfortably longer than growing 3 people to the 8 that widen the
// circle to where the real woodland is.
//
// Cheap, too, which is why it is eight and not one: on the shipped seed, 69 of the 1,430 legal
// start blocks clear this bar, and insisting on it moves the opening hamlet a single tile.
const START_FOREST = 8;
const START_STONE = 1;

/**
 * Does the *starting* reach — a `START_REACH_RADIUS` circle around where the Marketplace will
 * stand, one tile north of the hamlet — actually hold enough wood and stone to open with? The reach
 * gates gathering as well as building (it's a sphere of influence, not a building permit), so
 * "reachable" now means "in reach": a hamlet with a forest and an outcrop somewhere on the map but
 * outside its own opening circle is a rationing race nobody chose, not a playable start. Uses the
 * same Euclidean test the server gate and the drawn circle use, so the search and the rule it is
 * searching for can never quietly disagree about the shape of a circle.
 */
function hasStartingResources(hx: number, hy: number, charAt: (x: number, y: number) => string) {
	const reach = { x: hx, y: hy - 1, radius: START_REACH_RADIUS };
	let forest = 0;
	let stone = 0;
	for (let y = reach.y - reach.radius; y <= reach.y + reach.radius; y++)
		for (let x = reach.x - reach.radius; x <= reach.x + reach.radius; x++) {
			if (x < 0 || y < 0 || x >= GRID_SIZE || y >= GRID_SIZE) continue;
			if (!withinReach(x, y, reach)) continue;
			const c = charAt(x, y);
			if (c === FOREST) forest++;
			else if (c === STONE) stone++;
			if (forest >= START_FOREST && stone >= START_STONE) return true;
		}
	return false;
}

/**
 * Where a new realm opens: the hamlet tile, with its two flanking buildings, the settlers on the
 * row below, and `START_MARGIN` tiles of clear grass around the lot — plus, now that the reach gates
 * gathering too, wood and stone inside the *starting* reach around the Marketplace tile just north
 * of it.
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
	// around all of it. The Marketplace tile (hx, hy - 1) already sits inside this block, so a
	// candidate that clears it needs no separate check to know the Marketplace's own tile is grass.
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
			if ((best && d >= best.d) || !clear(x, y) || !hasStartingResources(x, y, charAt)) continue;
			best = { x, y, d };
		}
	return best && { x: best.x, y: best.y };
}

// Roll until the world has somewhere to live. Every candidate is a *whole* different map, and the
// seed that wins is the one the world is made of — so this is still one fixed world per WORLD_SEED,
// just chosen rather than assumed.
//
// This used to be theoretical: a hand-authored core guaranteed a legal block, so the loop ran once
// and never found a second candidate. Now that the whole map is generated it is load-bearing —
// "no hamlet fits" is a real outcome for some seeds, not a hypothetical one — which is why it is
// bounded rather than `while (true)`: a deploy that hangs looking for a world is worse than one
// that fails saying so.
const rolled = (() => {
	for (let seed = WORLD_SEED; seed < WORLD_SEED + 50; seed++) {
		const charAt = generator(seed);
		const start = findStart(charAt);
		if (start) return { seed, charAt, start };
	}
	throw new Error(
		`no map in 50 rolls from seed ${WORLD_SEED} has ${START_MARGIN} tiles of clear grass around a ` +
			`hamlet with Forest and Stone within ${START_REACH_RADIUS} tiles of its Marketplace`
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
	// The Marketplace, and so the centre of the realm's reach — one tile north of the hamlet. Inside
	// `findStart`'s cleared block and standing on nothing, so no other building has to move for it.
	marketX: rolled.start.x,
	marketY: rolled.start.y - 1,
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
