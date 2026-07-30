// Run: npm test  (node --test, no framework added)
//
// The generator is tuned by eye against `npm run map` and `npm run atlas`, and eyes are not in CI.
// This is the thing a threshold edit can quietly break that looking at a map you already believe in
// will not catch: a world that is mostly sea or mountain, one with nowhere for a fresh hamlet to
// open, a river that pools in a basin, a coastline that touches two edges, a mountain range that
// reads as speckle.
//
// **Sampled and windowed, not exhaustive, and that is a deliberate weakening.** These tests used to
// walk every tile — fine at 128², merely slow at 1448², and simply not a thing you can do at
// 47,775,744 tiles: the census alone would be half a minute and the connectivity floods would need
// 200 MB of typed arrays each. A suite nobody runs catches nothing, so the choice was never
// "exhaustive or sampled", it was "sampled or deleted".
//
// What that costs is stated honestly per test. Broadly: shares come from one tile in 64 (~750,000
// samples, so a share above ~0.1% is solid); geometry comes from a fixed spread of inland windows,
// which is a real sample of real ground rather than a lucky spot, because the origins are constants
// and do not move when a threshold does. What it does *not* cost is the structural guarantees —
// "every river reaches the sea", "a channel is one tile wide" — because those are now properties of
// how the generator is built rather than outcomes it happens to produce, and the tests below check
// the construction holds rather than hoping the dice landed well.
import assert from 'node:assert/strict';
import test from 'node:test';
import { GRID_SIZE, MATURE_REACH_RADIUS, route, START_REACH_RADIUS, withinReach } from './world.ts';
import { starts, terrainCensus, terrainCharAt, terrainWindow } from './worldgen.ts';
import { contentVersion } from './worldgen.hash.ts';

const CHARS = new Set(['.', 'f', 'w', 'h', 'm', 's', 'c', 'i']);

// One census for the whole file — it is ~750,000 generator calls and every share test reads it.
const census = terrainCensus();
const samples = [...census.values()].reduce((a, b) => a + b, 0);
const share = (char: string) => (census.get(char) ?? 0) / samples;

const START = starts()[0];

// Fixed inland windows, spread across the map, west of the coastal band. **Fixed is the point**:
// picking "wherever the water happens to be densest" makes every measurement a comparison against a
// different piece of ground, which is exactly how an earlier version of this work convinced itself a
// change had helped when it had only moved the sample.
const WINDOW = 300;
const ORIGINS: [number, number][] = [];
for (let y = 600; y < GRID_SIZE - 900; y += 1500)
	for (let x = 600; x < Math.round(GRID_SIZE * 0.82) - 900; x += 1500) ORIGINS.push([x, y]);
const WINDOWS = ORIGINS.map(([x, y]) => terrainWindow(x, y, WINDOW));

test('the sampled map speaks only the seed alphabet', () => {
	for (const c of census.keys()) assert.ok(CHARS.has(c), `unknown terrain char '${c}'`);
	for (const rows of WINDOWS)
		for (const row of rows) {
			assert.equal(row.length, WINDOW);
			for (const c of row) assert.ok(CHARS.has(c), `unknown terrain char '${c}'`);
		}
});

test('the world is somewhere to live, not an ocean or a mountain range', () => {
	// Water and mountain are the two unbuildable terrains — too much of either and the map is
	// scenery rather than a place to expand into.
	assert.ok(share('w') < 0.25, `water is ${Math.round(share('w') * 100)}% of the map`);
	assert.ok(share('m') < 0.2, `mountain is ${Math.round(share('m') * 100)}% of the map`);
	assert.ok(share('.') + share('f') > 0.6, 'less than 60% of the map is open ground or forest');
	// Every deposit terrain is somewhere. The seed enforces the one that seals the ladder (Stone);
	// this catches the ones that only make the world duller.
	for (const c of ['s', 'c', 'i']) assert.ok(share(c) > 0, `no ${c} anywhere in the sample`);

	// And floors, not just ceilings — the bounds above are all upper, and a map can fail by being
	// *bland* as easily as by being an ocean. Not hypothetical: this generator's own move to
	// continental noise wavelengths took mountain from 8.5% to 6.1% and deposits from 12% to 0.02%,
	// and every upper bound stayed green through both.
	assert.ok(share('m') > 0.05, `mountain is only ${(share('m') * 100).toFixed(1)}% — the map is flat`);
	assert.ok(share('h') > 0.02, `hills are only ${(share('h') * 100).toFixed(1)}% — no gradient`);
	assert.ok(
		share('s') > 0.005,
		`stone is only ${(share('s') * 100).toFixed(2)}% — a realm may not find any in reach`
	);
});

test('the sea keeps to one edge, and the other three stay dry', () => {
	// The structural guarantee, checked directly rather than by flooding 47.8M tiles: `LAND_FLOOR`
	// and `edgeLift` exist so that no amount of noise can put water on the north, south or west
	// edges, and `SEA_DEPTH` is derived rather than tuned so the east edge is water by construction.
	// Every tile of all four edges is 27,648 samples — cheap, and it is the whole claim.
	//
	// **Except at the two eastern corners, deliberately.** A sea strip running the map's full height
	// necessarily reaches the north-east and south-east corners, which sit on the north and south
	// edges too — so "the sea keeps to one edge" would quietly become two. `cornerTaper` curls the
	// coastline back from both, which means the last few tiles of the east edge are dry *on purpose*.
	// Asserting the whole column is water tests the opposite of what the generator promises; it fails
	// on 13 tiles out of 6,912, and those 13 are the feature.
	const CORNER = 16;
	for (let y = 0; y < GRID_SIZE; y++) {
		assert.notEqual(terrainCharAt(0, y), 'w', `water on the west edge at y=${y}`);
		if (y < CORNER || y >= GRID_SIZE - CORNER) continue;
		assert.equal(terrainCharAt(GRID_SIZE - 1, y), 'w', `east edge is dry at y=${y}`);
	}
	for (let x = 0; x < GRID_SIZE; x++) {
		assert.notEqual(terrainCharAt(x, 0), 'w', `water on the north edge at x=${x}`);
		assert.notEqual(terrainCharAt(x, GRID_SIZE - 1), 'w', `water on the south edge at x=${x}`);
	}
});

// Water geometry, over the fixed windows. Width and straightness are different questions asked of
// the same two run-length arrays, so they are computed once here.
const geometry = WINDOWS.map((rows) => {
	const isW = (x: number, y: number) => rows[y]?.[x] === 'w';
	const h = new Int32Array(WINDOW * WINDOW);
	const v = new Int32Array(WINDOW * WINDOW);
	for (let y = 0; y < WINDOW; y++) {
		let r = 0;
		for (let x = 0; x < WINDOW; x++) h[y * WINDOW + x] = r = isW(x, y) ? r + 1 : 0;
		r = 0;
		for (let x = WINDOW - 1; x >= 0; x--)
			h[y * WINDOW + x] = Math.max(h[y * WINDOW + x], (r = isW(x, y) ? r + 1 : 0));
	}
	for (let x = 0; x < WINDOW; x++) {
		let r = 0;
		for (let y = 0; y < WINDOW; y++) v[y * WINDOW + x] = r = isW(x, y) ? r + 1 : 0;
		r = 0;
		for (let y = WINDOW - 1; y >= 0; y--)
			v[y * WINDOW + x] = Math.max(v[y * WINDOW + x], (r = isW(x, y) ? r + 1 : 0));
	}
	return { isW, h, v };
});

test('a river is one tile wide — no 2x2 block of water anywhere inland', () => {
	// **The width test, and it is exact rather than statistical.** It used to be percentiles of
	// `min(horizontal run, vertical run)`, which was the right proxy for a flood-derived channel and
	// is the wrong one for a *drawn* channel: this generator traces each river as right-angle legs
	// between coarse nodes, so every corner has a long run on both axes and scores as "wide" while
	// being one tile across. That proxy reported a p90 width of 5 for channels that are provably 1.
	//
	// A solid 2x2 is the honest question. A one-tile channel cannot make one — an L-corner is three
	// tiles in an L, never a square — and a basin or a braided flood plain makes them everywhere.
	let blocks = 0;
	let water = 0;
	for (const { isW } of geometry)
		for (let y = 0; y < WINDOW - 1; y++)
			for (let x = 0; x < WINDOW - 1; x++) {
				if (!isW(x, y)) continue;
				water++;
				if (isW(x + 1, y) && isW(x, y + 1) && isW(x + 1, y + 1)) blocks++;
			}
	assert.ok(water > 500, `only ${water} inland water tiles sampled — is there a river at all?`);
	assert.equal(blocks, 0, `${blocks} solid 2x2 blocks of water — that is a basin, not a channel`);
});

test('no water tile is an isolated puddle', () => {
	// The specific shape of the old corner-contact bug: a "river" that printed as a connected line
	// but was hundreds of single tiles touching only diagonally, invisible to any 4-connected reading
	// and to a body trying to walk it. D4 flow directions and node-to-node tracing make that
	// impossible by construction; this is what would notice if either stopped being true.
	let singletons = 0;
	for (const { isW } of geometry)
		for (let y = 1; y < WINDOW - 1; y++)
			for (let x = 1; x < WINDOW - 1; x++)
				if (isW(x, y) && !isW(x + 1, y) && !isW(x - 1, y) && !isW(x, y + 1) && !isW(x, y - 1))
					singletons++;
	assert.equal(singletons, 0, `${singletons} water tiles are 4-connected singletons`);
});

test('rivers meander — no long dead-straight inland run', () => {
	// A hydrologically valid, properly thin, fully connected channel can still run arrow-straight for
	// tens of tiles, and a straight canal reads as infrastructure rather than landscape. Two distinct
	// causes have produced it here: `priorityFlood` degenerating to "shortest path to the coast" on
	// flat ground (fixed by rescaling elevation onto the land floor instead of clamping against it),
	// and coarse nodes lining up so consecutive legs merged into one line (fixed by the parity offset
	// in the node lattice — measured at a 100-tile run before it).
	//
	// The bound is one coarse cell's own leg, so it is roughly 1.75 x COARSE. 16 is the budget the old
	// generator was held to and this one comes in at 11-14; it is kept rather than relaxed to fit.
	let longest = 0;
	for (const { isW, h, v } of geometry)
		for (let y = 0; y < WINDOW; y++)
			for (let x = 0; x < WINDOW; x++)
				if (isW(x, y)) longest = Math.max(longest, h[y * WINDOW + x], v[y * WINDOW + x]);
	assert.ok(longest <= 16, `a straight inland run of water is ${longest} tiles long`);
});

// Mountain and forest are read 8-connected below, deliberately and unlike water: neither test asks
// "could a body walk this", it asks "does this read as one connected shape" — a range whose two
// peaks touch at a corner is still legibly one range. Water gets no such latitude, because a river
// is specifically a thing you walk along.
const DIRS8 = [
	[1, 0],
	[-1, 0],
	[0, 1],
	[0, -1],
	[1, 1],
	[1, -1],
	[-1, 1],
	[-1, -1]
];

/** Sizes of the 8-connected components of `char` within one window. */
function components(rows: string[], char: string): number[] {
	const seen = new Uint8Array(WINDOW * WINDOW);
	const sizes: number[] = [];
	for (let y = 0; y < WINDOW; y++)
		for (let x = 0; x < WINDOW; x++) {
			if (rows[y][x] !== char || seen[y * WINDOW + x]) continue;
			let size = 0;
			const stack = [[x, y]];
			seen[y * WINDOW + x] = 1;
			while (stack.length) {
				const [cx, cy] = stack.pop()!;
				size++;
				for (const [dx, dy] of DIRS8) {
					const nx = cx + dx;
					const ny = cy + dy;
					if (nx < 0 || ny < 0 || nx >= WINDOW || ny >= WINDOW) continue;
					if (rows[ny][nx] !== char || seen[ny * WINDOW + nx]) continue;
					seen[ny * WINDOW + nx] = 1;
					stack.push([nx, ny]);
				}
			}
			sizes.push(size);
		}
	return sizes;
}

test('mountain forms ranges, not speckle', () => {
	const sizes = WINDOWS.flatMap((rows) => components(rows, 'm'));
	const total = sizes.reduce((a, b) => a + b, 0);
	assert.ok(total > 0, 'no mountain in any sampled window');
	// Speckle is one component per tile or close to it; a set of chains is a handful of components
	// no matter how many tiles they cover between them.
	assert.ok(
		sizes.length < total * 0.05,
		`${sizes.length} mountain components across ${total} tiles reads as speckle, not chains`
	);
});

test('forest reads as regions, not per-tile dice', () => {
	const sizes = WINDOWS.flatMap((rows) => components(rows, 'f'));
	const total = sizes.reduce((a, b) => a + b, 0);
	const mean = total / sizes.length;
	// Per-tile dice (an uncorrelated `noise(x, y) > threshold`) produces mostly 1-4 tile flecks. This
	// generator's moisture field is coherent enough that the mean sits in the hundreds. It is also
	// the check that would catch the *opposite* failure the regional rewrite introduced — a moisture
	// field so smooth that forest and meadow separate into provinces with no mixing at all — because
	// that reads here as a handful of enormous components, which `startsHaveResources` below then
	// fails outright.
	assert.ok(mean > 20, `mean forest cluster size is only ${mean.toFixed(1)} tiles`);
});

test('every mountain tile has a hills or mountain neighbour', () => {
	// The elevation gradient made visible: nothing sits at the top band with lowland on every side.
	let stray = 0;
	for (const rows of WINDOWS)
		for (let y = 1; y < WINDOW - 1; y++)
			for (let x = 1; x < WINDOW - 1; x++) {
				if (rows[y][x] !== 'm') continue;
				const gradient = DIRS8.some(([dx, dy]) => {
					const c = rows[y + dy][x + dx];
					return c === 'm' || c === 'h';
				});
				if (!gradient) stray++;
			}
	assert.equal(stray, 0, `${stray} mountain tile(s) have no hills or mountain neighbour`);
});

test('the world offers somewhere to live, and more than one somewhere', () => {
	const found = starts();
	assert.ok(found.length > 0, 'the start search found nowhere to open a realm at all');
	// A continent's worth of ground should hold dozens of openings, not one. A single start is the
	// signature of a world whose terrain has stopped mixing at local scale — see the forest test.
	assert.ok(found.length >= 20, `only ${found.length} opening(s) on a ${GRID_SIZE}² world`);
});

test('a realm opens on grass, with two clear tiles on every side', () => {
	// The rule the start search exists to hold, asserted from the outside: the three buildings, the
	// settlers' row below them, and a two-tile margin around the lot — all of it meadow. This catches
	// a retuned threshold quietly putting a hamlet in a lake.
	for (let x = START.hamletX - 3; x <= START.hamletX + 3; x++)
		for (let y = START.hamletY - 2; y <= START.hamletY + 3; y++) {
			assert.ok(x >= 0 && y >= 0 && x < GRID_SIZE && y < GRID_SIZE, `(${x},${y}) is off the map`);
			assert.equal(terrainCharAt(x, y), '.', `(${x},${y}) beside the hamlet is not grass`);
		}
	// The buildings and the settlers are placed relative to the hamlet, so the margin above only
	// means anything if they really are where it assumes.
	assert.deepEqual(
		[START.house2X - START.hamletX, START.barnX - START.hamletX, START.house2Y, START.barnY],
		[-1, 1, START.hamletY, START.hamletY]
	);
	assert.deepEqual([START.characterX, START.characterY], [START.hamletX, START.hamletY + 1]);
});

test('every start opens with wood and stone inside its own reach, not merely on the map', () => {
	// The reach gates gathering, not just building, so a realm can only work the circle it opens with
	// until its population earns the next milestone. "Wood and stone somewhere on the map" is
	// therefore not a playable start.
	//
	// Counted, not merely present: an earlier version asked only whether *a* Forest tile existed and
	// was satisfied by exactly one — 25 Wood, stripped in about eight hours, then thirty days of
	// nothing. A stone outcrop genuinely needs only one; it never runs down.
	//
	// Every opening, not just the first — a scattered start is only honest if all of them are real.
	for (const s of starts()) {
		const reach = { x: s.marketX, y: s.marketY, radius: START_REACH_RADIUS };
		let forest = 0;
		let stone = 0;
		for (let y = reach.y - reach.radius; y <= reach.y + reach.radius; y++)
			for (let x = reach.x - reach.radius; x <= reach.x + reach.radius; x++) {
				if (x < 0 || y < 0 || x >= GRID_SIZE || y >= GRID_SIZE) continue;
				if (!withinReach(x, y, reach)) continue;
				const c = terrainCharAt(x, y);
				if (c === 'f') forest++;
				else if (c === 's') stone++;
			}
		assert.ok(forest >= 8, `start (${s.hamletX},${s.hamletY}): only ${forest} Forest in reach`);
		assert.ok(stone >= 1, `start (${s.hamletX},${s.hamletY}): no Stone outcrop in reach`);
	}
});

test('every pair of starts is far enough apart to leave wilderness between them', () => {
	// Two mature reaches never touch, and then some: the separation is a multiple of the diameter, so
	// there is real unclaimed ground between neighbours rather than a shared border. That multiple is
	// what makes the world a continent with a frontier instead of a packed tessellation of domains.
	const found = starts();
	for (let i = 0; i < found.length; i++)
		for (let j = i + 1; j < found.length; j++) {
			const d = Math.hypot(
				found[i].hamletX - found[j].hamletX,
				found[i].hamletY - found[j].hamletY
			);
			assert.ok(
				d >= MATURE_REACH_RADIUS * 2,
				`starts ${i} and ${j} are ${d.toFixed(0)} apart — their mature reaches would overlap`
			);
		}
});

test('starts are ordered closest to the map centre first', () => {
	const found = starts();
	const mid = (GRID_SIZE - 1) / 2;
	const d = (s: { hamletX: number; hamletY: number }) =>
		Math.hypot(s.hamletX - mid, s.hamletY - mid);
	// Not a total sort — the packer accepts greedily from a distance-sorted candidate list, so a
	// later start can be nearer than an earlier one only by having been rejected first. What must
	// hold is that the *first* is the nearest, because that is the one every caller treats as home.
	for (const s of found) assert.ok(d(found[0]) <= d(s) + 1e-9, 'the first start is not the nearest');
});

test('a river is a detour, not a wall — the route bends around it', () => {
	// Terrain has to change the route, not merely cost time. Find a water tile in a sampled window,
	// then route across it: the path must not simply run through the channel.
	let crossing: { x: number; y: number } | null = null;
	for (let w = 0; w < WINDOWS.length && !crossing; w++)
		for (let y = 40; y < WINDOW - 40 && !crossing; y++)
			for (let x = 40; x < WINDOW - 40; x++)
				if (WINDOWS[w][y][x] === 'w') {
					crossing = { x: ORIGINS[w][0] + x, y: ORIGINS[w][1] + y };
					break;
				}
	assert.ok(crossing, 'no inland water found to route across');

	const cost = (x: number, y: number) => {
		const c = terrainCharAt(x, y);
		return c === 'w' ? 8 : c === 'm' ? 5 : c === 'f' ? 2 : 1;
	};
	const r = route(crossing!.x - 12, crossing!.y, crossing!.x + 12, crossing!.y, 1, cost, GRID_SIZE);
	const straightLine = 24;
	// A route that ignored terrain would be the straight line. Bending around costs steps.
	assert.ok(r.path.length > straightLine, 'the route did not bend at all around the water');
});

test('contentVersion is stable for the same inputs and moves when any of them does', () => {
	const base = contentVersion(1, 2, 'source');
	assert.equal(base, contentVersion(1, 2, 'source'), 'same inputs gave two different versions');
	assert.notEqual(base, contentVersion(2, 2, 'source'), 'a new seed did not move the version');
	assert.notEqual(base, contentVersion(1, 3, 'source'), 'a new grid size did not move the version');
	assert.notEqual(base, contentVersion(1, 2, 'other'), 'edited generator did not move the version');
});
