// Run: npm test  (node --test, no framework added)
//
// The generator is tuned by eye against `npm run map`, and eyes are not in CI. This is the thing a
// threshold edit can quietly break that looking at a map you already believe in will not catch: a
// world that is mostly sea or mountain, or one with nowhere left for a fresh hamlet to open — and,
// since the Phase 3 rewrite, the geography tests below: a river that pools in a basin, a coastline
// that touches two edges, a mountain range that reads as speckle. All of it is pinned here because
// none of it is visible from the numeric census alone.
import assert from 'node:assert/strict';
import test from 'node:test';
import { GRID_SIZE, MATURE_REACH_RADIUS, route, START_REACH_RADIUS, withinReach } from './world.ts';
import { contentVersion, START, STARTS, terrainCharAt, terrainMap } from './worldgen.ts';

const CHARS = new Set(['.', 'f', 'w', 'h', 'm', 's', 'c', 'i']);
const map = terrainMap();
const census = (char: string) => [...map.join('')].filter((c) => c === char).length;
const share = (char: string) => census(char) / (GRID_SIZE * GRID_SIZE);
const idx = (x: number, y: number) => y * GRID_SIZE + x;

test('the map is the right shape and speaks only the seed alphabet', () => {
	assert.equal(map.length, GRID_SIZE);
	for (const row of map) {
		assert.equal(row.length, GRID_SIZE);
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
	for (const c of ['s', 'c', 'i']) assert.ok(census(c) > 0, `no ${c} anywhere on the map`);

	// And floors, not just ceilings — the bounds above are all upper, and a map can fail by being
	// *bland* as easily as by being an ocean. This is not hypothetical: the 128→256 grid change kept
	// the elevation cuts that suited the smaller lattice and took mountain from 9% of the map to 2%
	// and stone from 1% to 0.4%, a flatter and duller world with every assertion in this file still
	// green. The noise lattices are sized in tiles, so a grid-size change draws a different field
	// rather than a scaled one; these floors are what turn "re-tune the thresholds" from something
	// somebody has to remember into something the suite insists on.
	assert.ok(
		share('m') > 0.05,
		`mountain is only ${(share('m') * 100).toFixed(1)}% — the map is flat`
	);
	assert.ok(share('h') > 0.02, `hills are only ${(share('h') * 100).toFixed(1)}% — no gradient`);
	assert.ok(
		share('s') > 0.005,
		`stone is only ${(share('s') * 100).toFixed(2)}% — a realm may not find any in reach`
	);
});

test('a realm opens on grass, with two clear tiles on every side', () => {
	// The rule the start search exists to hold, asserted from the outside: the three buildings, the
	// settlers' row below them, and a two-tile margin around the lot — all of it meadow. This is the
	// one that catches a retuned threshold quietly putting the hamlet in a lake, which is exactly
	// what a hand-placed constant did before the search replaced it.
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

test('a realm opens with wood and stone inside its own reach, not merely on the map', () => {
	// The reach gates gathering, not just building, so a realm can only work the circle it opens
	// with until its population earns the next milestone. "Wood and stone somewhere on the map" is
	// therefore not a playable start — this asserts they are inside the opening circle, around the
	// Marketplace tile rather than the hamlet, because the Marketplace is what the reach is measured
	// from.
	//
	// Counted, not merely present. An earlier version of this rule asked only whether a Forest tile
	// existed in reach and was satisfied by exactly one — 25 Wood, stripped in about eight hours by
	// three settlers, then thirty days of nothing, which is the rationing race the rule exists to
	// prevent. A stone outcrop genuinely needs only one: it has no capacity and never runs down.
	const reach = { x: START.marketX, y: START.marketY, radius: START_REACH_RADIUS };
	let forest = 0;
	let stone = 0;
	for (let y = 0; y < GRID_SIZE; y++)
		for (let x = 0; x < GRID_SIZE; x++) {
			if (!withinReach(x, y, reach)) continue;
			if (terrainCharAt(x, y) === 'f') forest++;
			else if (terrainCharAt(x, y) === 's') stone++;
		}
	assert.ok(forest >= 8, `only ${forest} Forest tile(s) in the opening reach — a realm cannot cut`);
	assert.ok(
		stone >= 1,
		`no Stone outcrop in the opening reach — the ladder is sealed at the start`
	);
	// The Marketplace stands one north of the hamlet, on ground the start block already cleared.
	assert.deepEqual([START.marketX, START.marketY], [START.hamletX, START.hamletY - 1]);
});

test('every start the map offers, not just the first, opens on grass with wood and stone in reach', () => {
	// The same two guarantees the tests above pin for `START` alone, held for every entry in
	// `STARTS` — a scattered start is only honest if *every* opening it hands out is actually
	// playable, not just the one every other test happens to exercise.
	assert.ok(STARTS.length > 0, 'findStarts found nowhere to open a realm at all');
	for (const s of STARTS) {
		for (let x = s.hamletX - 3; x <= s.hamletX + 3; x++)
			for (let y = s.hamletY - 2; y <= s.hamletY + 3; y++) {
				assert.ok(x >= 0 && y >= 0 && x < GRID_SIZE && y < GRID_SIZE, `(${x},${y}) is off the map`);
				assert.equal(
					terrainCharAt(x, y),
					'.',
					`(${x},${y}) beside start (${s.hamletX},${s.hamletY}) is not grass`
				);
			}
		const reach = { x: s.marketX, y: s.marketY, radius: START_REACH_RADIUS };
		let forest = 0;
		let stone = 0;
		for (let y = 0; y < GRID_SIZE; y++)
			for (let x = 0; x < GRID_SIZE; x++) {
				if (!withinReach(x, y, reach)) continue;
				if (terrainCharAt(x, y) === 'f') forest++;
				else if (terrainCharAt(x, y) === 's') stone++;
			}
		assert.ok(
			forest >= 8,
			`start (${s.hamletX},${s.hamletY}): only ${forest} Forest tile(s) in reach`
		);
		assert.ok(stone >= 1, `start (${s.hamletX},${s.hamletY}): no Stone outcrop in reach`);
	}
});

test('every pair of starts is far enough apart that their mature reaches never touch', () => {
	// Two mature reaches (MATURE_REACH_RADIUS each) just touching is twice that — the same
	// derivation `findStarts` uses for MIN_START_SEPARATION, recomputed here rather than imported
	// so this pins the *invariant* (no overlap at the ladder's top rung) and not merely whatever
	// worldgen.ts's own private constant happens to hold.
	const minSeparation = MATURE_REACH_RADIUS * 2;
	for (let i = 0; i < STARTS.length; i++)
		for (let j = i + 1; j < STARTS.length; j++) {
			const a = STARTS[i];
			const b = STARTS[j];
			const d = Math.hypot(a.hamletX - b.hamletX, a.hamletY - b.hamletY);
			assert.ok(
				d >= minSeparation,
				`starts (${a.hamletX},${a.hamletY}) and (${b.hamletX},${b.hamletY}) are only ${d.toFixed(1)} tiles apart, need ${minSeparation}`
			);
		}
});

test('STARTS is ordered closest to the map centre first, and START is simply its first entry', () => {
	const mid = (GRID_SIZE - 1) / 2;
	const dist = (s: { hamletX: number; hamletY: number }) =>
		Math.hypot(s.hamletX - mid, s.hamletY - mid);
	for (let i = 1; i < STARTS.length; i++)
		assert.ok(
			dist(STARTS[i]) >= dist(STARTS[i - 1]),
			`start ${i} is closer to centre than start ${i - 1}`
		);
	assert.deepEqual(START, STARTS[0]);
});

// Four-way and eight-way, and which terrain gets which is a deliberate call per terrain, not a
// house style. Water is walked and routed on orthogonally (`route`'s eight-way movement still
// prices a diagonal step, but between two *open* tiles — a strand of water one corner wide is not
// a crossing, it's a gap two puddles happen to share a corner with) — a channel a body could
// actually follow has to be 4-connected, so every water assertion below uses DIRS4. This is not
// pedantry: an earlier version of this file used DIRS8 throughout, on the reasoning that D8
// hydrology and `route`'s own eight-way movement made it the "consistent" choice, and it reported
// zero orphaned Water tiles on a map where 682 of 3,123 were single-tile puddles joined to their
// neighbours only diagonally — corner contact was enough to call the whole thing one component.
// Mountain and forest are area/gradient claims, not walkability ones — nobody has to trace a
// mountain range end to end — so DIRS8 stays deliberate there; see the tests below.
const DIRS4: [number, number][] = [
	[1, 0],
	[-1, 0],
	[0, 1],
	[0, -1]
];
const DIRS8: [number, number][] = [...DIRS4, [1, 1], [1, -1], [-1, 1], [-1, -1]];

/** Every tile `pred` accepts, grouped into its connected components under the given adjacency —
 * size and which map edges (if any) each one touches. Shared by the sea, mountain and forest tests
 * below: "how many blobs, how big, do they reach the border" is the same question asked of three
 * different terrains, at whichever connectivity that terrain's own test decides matters. */
function components(pred: (x: number, y: number) => boolean, dirs: [number, number][]) {
	const seen = new Uint8Array(GRID_SIZE * GRID_SIZE);
	const result: { size: number; edges: Set<string> }[] = [];
	for (let y = 0; y < GRID_SIZE; y++)
		for (let x = 0; x < GRID_SIZE; x++) {
			const i = idx(x, y);
			if (!pred(x, y) || seen[i]) continue;
			let size = 0;
			const edges = new Set<string>();
			const queue = [i];
			seen[i] = 1;
			while (queue.length) {
				const j = queue.pop()!;
				size++;
				const jx = j % GRID_SIZE;
				const jy = (j / GRID_SIZE) | 0;
				if (jx === 0) edges.add('west');
				if (jy === 0) edges.add('north');
				if (jx === GRID_SIZE - 1) edges.add('east');
				if (jy === GRID_SIZE - 1) edges.add('south');
				for (const [dx, dy] of dirs) {
					const nx = jx + dx;
					const ny = jy + dy;
					if (nx < 0 || ny < 0 || nx >= GRID_SIZE || ny >= GRID_SIZE) continue;
					const k = idx(nx, ny);
					if (!pred(nx, ny) || seen[k]) continue;
					seen[k] = 1;
					queue.push(k);
				}
			}
			result.push({ size, edges });
		}
	return result;
}

/** Flood-fill from one tile under the given adjacency, for the "does every Water tile reach the
 * sea" check. */
function floodFill(
	startX: number,
	startY: number,
	pred: (x: number, y: number) => boolean,
	dirs: [number, number][]
) {
	const seen = new Set<number>([idx(startX, startY)]);
	const queue = [idx(startX, startY)];
	while (queue.length) {
		const j = queue.pop()!;
		const jx = j % GRID_SIZE;
		const jy = (j / GRID_SIZE) | 0;
		for (const [dx, dy] of dirs) {
			const nx = jx + dx;
			const ny = jy + dy;
			if (nx < 0 || ny < 0 || nx >= GRID_SIZE || ny >= GRID_SIZE) continue;
			const k = idx(nx, ny);
			if (seen.has(k) || !pred(nx, ny)) continue;
			seen.add(k);
			queue.push(k);
		}
	}
	return seen;
}

const isWater = (x: number, y: number) => terrainCharAt(x, y) === 'w';

// The sea, as a *shape* rather than a hardcoded column: erode the Water mask (a tile survives only
// if it and all 4 orthogonal neighbours are Water — nothing narrower than about 3 tiles across
// lives through that), then dilate the survivors back out by one tile to restore the coastline the
// erosion ate. What's left is the sea's own solid mass; a river, however long, never has an
// interior to survive erosion in the first place. Derived from the water this generator actually
// drew, so it keeps working if the sea's width, edge or shape ever changes — the alternative,
// picking an inland cutoff column by eye, is exactly the kind of number that quietly stops meaning
// anything the day someone retunes SEA_BAND.
const seaMask = new Uint8Array(GRID_SIZE * GRID_SIZE);
{
	const solid = (x: number, y: number) =>
		isWater(x, y) &&
		isWater(x + 1, y) &&
		isWater(x - 1, y) &&
		isWater(x, y + 1) &&
		isWater(x, y - 1);
	for (let y = 0; y < GRID_SIZE; y++)
		for (let x = 0; x < GRID_SIZE; x++) {
			if (!solid(x, y)) continue;
			seaMask[idx(x, y)] = 1;
			if (x + 1 < GRID_SIZE) seaMask[idx(x + 1, y)] = 1;
			if (x - 1 >= 0) seaMask[idx(x - 1, y)] = 1;
			if (y + 1 < GRID_SIZE) seaMask[idx(x, y + 1)] = 1;
			if (y - 1 >= 0) seaMask[idx(x, y - 1)] = 1;
		}
}
const isInlandWater = (x: number, y: number) => isWater(x, y) && !seaMask[idx(x, y)];

// Horizontal/vertical run lengths through every *inland* Water tile, computed once and shared by
// the width and straightness tests below — both are just different questions asked of the same two
// arrays. Built from `isInlandWater`, not `isWater`: a run has to break at the sea's own boundary,
// or a river tile sitting one step from the coast would inherit the sea's width or length along
// whichever axis happens to run into it.
const hrun = new Int32Array(GRID_SIZE * GRID_SIZE);
const vrun = new Int32Array(GRID_SIZE * GRID_SIZE);
for (let y = 0; y < GRID_SIZE; y++) {
	let run = 0;
	for (let x = 0; x < GRID_SIZE; x++) {
		run = isInlandWater(x, y) ? run + 1 : 0;
		hrun[idx(x, y)] = run;
	}
	run = 0;
	for (let x = GRID_SIZE - 1; x >= 0; x--) {
		run = isInlandWater(x, y) ? run + 1 : 0;
		hrun[idx(x, y)] = Math.max(hrun[idx(x, y)], run);
	}
}
for (let x = 0; x < GRID_SIZE; x++) {
	let run = 0;
	for (let y = 0; y < GRID_SIZE; y++) {
		run = isInlandWater(x, y) ? run + 1 : 0;
		vrun[idx(x, y)] = run;
	}
	run = 0;
	for (let y = GRID_SIZE - 1; y >= 0; y--) {
		run = isInlandWater(x, y) ? run + 1 : 0;
		vrun[idx(x, y)] = Math.max(vrun[idx(x, y)], run);
	}
}

test('the sea is one connected body of water, 4-connected, and touches exactly one edge', () => {
	// worldgen.ts's `edgeLift` keeps the other three edges high and dry by construction, and
	// `SEA_DEPTH` is derived, not tuned, to guarantee the sea edge itself is wet — so this isn't
	// asserting a threshold so much as checking that guarantee actually held for this seed.
	const water = components(isWater, DIRS4);
	assert.equal(water.length, 1, `water forms ${water.length} disconnected bodies, not one sea`);
	assert.equal(
		water[0].edges.size,
		1,
		`water touches ${[...water[0].edges].join(', ') || 'no edge at all'}`
	);
});

test('every Water tile connects to the sea by orthogonal steps', () => {
	// Flood-fill outward from a Water tile on the sea edge, 4-connected — a diagonal-only touch
	// doesn't count, because a river you can't walk the length of isn't a river (see the DIRS4/
	// DIRS8 note above). If the reach is smaller than the total census, something — a river
	// segment, a puddle — sits disconnected from it under any connectivity a body could use.
	let seaTile: [number, number] | null = null;
	for (let y = 0; y < GRID_SIZE && !seaTile; y++)
		if (terrainCharAt(GRID_SIZE - 1, y) === 'w') seaTile = [GRID_SIZE - 1, y];
	assert.ok(seaTile, 'no Water tile at all on the sea edge to flood-fill from');
	const reached = floodFill(seaTile![0], seaTile![1], isWater, DIRS4);
	assert.equal(
		reached.size,
		census('w'),
		`${census('w') - reached.size} Water tile(s) don't orthogonally connect to the sea`
	);
});

test('essentially no Water tile is an isolated singleton', () => {
	// The specific shape of the corner-contact bug: 682 of 3,123 Water tiles were their own
	// 4-connected component of size 1 — a puddle touching its neighbours only at a corner. The two
	// tests above already imply zero once the sea is confirmed to be one 4-connected component, but
	// that's exactly the reasoning that let the bug hide behind an 8-connected "1 component, 0
	// orphans" reading before — so this checks the singleton count directly rather than trusting
	// another test's math.
	const singletons = components(isWater, DIRS4).filter((c) => c.size === 1).length;
	assert.ok(singletons <= 1, `${singletons} Water tiles are isolated 4-connected singletons`);
});

test('rivers are thin — mostly one or two tiles wide, inland of the coast', () => {
	// Local "width" at a Water tile: the shorter of the horizontal and vertical run of Water tiles
	// running through it. A river is long in one axis and thin in the other, so this measurement
	// stays small along its whole length; the sea is wide in both axes at once, which is exactly why
	// the sample is restricted to `isInlandWater` — the sea's own shape, not a hardcoded column.
	//
	// Two numbers, not one, because they catch different failures. The 90th percentile catches the
	// systemic one: a threshold too low reads as diffuse wet texture rather than a channel, and that
	// pushes width *everywhere*, not just at a few tiles — this generator sits at 1-2 comfortably.
	// The max catches the acute one this test is named after: a single wide flood-plain "lake" was
	// once 21 tiles across at its worst while every percentile up to p95 still read 2-3, because a
	// basin that wide is still a small fraction of the total Water census. A real confluence — two
	// tributaries actually joining — does read as briefly wider than either one alone, which is why
	// this isn't pinned at 2: the cap is generous enough to let a junction through and still catch a
	// basin.
	const widths: number[] = [];
	for (let y = 0; y < GRID_SIZE; y++)
		for (let x = 0; x < GRID_SIZE; x++)
			if (isInlandWater(x, y)) widths.push(Math.min(hrun[idx(x, y)], vrun[idx(x, y)]));
	assert.ok(widths.length > 0, 'no inland Water tiles to measure — is there a river at all?');
	widths.sort((a, b) => a - b);
	const p90 = widths[Math.floor(0.9 * widths.length)];
	const max = widths[widths.length - 1];
	assert.ok(p90 <= 2, `90th percentile inland river width is ${p90} tiles`);
	assert.ok(max <= 10, `a spot on the river is ${max} tiles wide — that's a basin, not a channel`);
});

test('rivers meander — no long dead-straight inland run', () => {
	// The third distinct way this has been wrong, and the first two were both invisible until
	// measured: a fixed generator can still produce a hydrologically valid, properly thin, fully
	// connected channel that runs arrow-straight for tens of tiles, because `priorityFlood` visiting
	// cells in order of rising elevation degenerates to "shortest path to the coast" wherever the
	// ground is flat — and a straight canal reads as infrastructure, not landscape. One seed of this
	// generator, pre-fix, ran dead straight for 38 tiles (18% of every inland Water tile on the
	// map) before `hydroNoise` in worldgen.ts went from a smooth field to a chaotic per-tile one;
	// this pins the fix. 16 is headroom over what the fixed generator actually produces (9 and 14
	// at the time this was written) while still well short of anything that would read as dug —
	// pushing the amplitude higher shortens the vertical run further but widens the channel enough
	// to fail the thinness test above, so this is the balance, not the ceiling.
	const longestRun = (runs: Int32Array) => {
		let longest = 0;
		for (let y = 0; y < GRID_SIZE; y++)
			for (let x = 0; x < GRID_SIZE; x++)
				if (isInlandWater(x, y)) longest = Math.max(longest, runs[idx(x, y)]);
		return longest;
	};
	const longestH = longestRun(hrun);
	const longestV = longestRun(vrun);
	assert.ok(longestH <= 16, `a straight inland horizontal run is ${longestH} tiles long`);
	assert.ok(longestV <= 16, `a straight inland vertical run is ${longestV} tiles long`);
});

// Mountain and forest are read below with DIRS8, deliberately and unlike water: neither test is
// asking "could a body walk this", it's asking "does this read as one connected *shape*" — a
// range whose two peaks touch only at a corner is still legibly one range, the way two forest
// stands touching at a corner still read as one wood from above. Water doesn't get that latitude
// because a river is specifically a thing you walk along or route across (see the DIRS4 note up
// top), and nothing here makes the same claim about a mountain or a tree.

test('mountain forms a few connected ranges, not speckle', () => {
	const ranges = components((x, y) => terrainCharAt(x, y) === 'm', DIRS8);
	const total = ranges.reduce((sum, r) => sum + r.size, 0);
	// Speckle is one component per tile or close to it; a set of chains is a handful of components
	// no matter how many tiles they cover between them. 5% is generous headroom over what this
	// generator actually produces (well under 1%) while still catching a regression toward
	// per-tile noise.
	assert.ok(
		ranges.length < total * 0.05,
		`${ranges.length} mountain components across ${total} tiles reads as speckle, not chains`
	);
});

test('every mountain tile has a hills or mountain neighbour', () => {
	// The elevation gradient made visible: nothing sits at the top band with lowland on every side.
	let stray = 0;
	for (let y = 0; y < GRID_SIZE; y++)
		for (let x = 0; x < GRID_SIZE; x++) {
			if (terrainCharAt(x, y) !== 'm') continue;
			const gradient = DIRS8.some(([dx, dy]) => {
				const nx = x + dx;
				const ny = y + dy;
				if (nx < 0 || ny < 0 || nx >= GRID_SIZE || ny >= GRID_SIZE) return false;
				const c = terrainCharAt(nx, ny);
				return c === 'm' || c === 'h';
			});
			if (!gradient) stray++;
		}
	assert.equal(stray, 0, `${stray} mountain tile(s) have no hills or mountain neighbour`);
});

test('forest reads as regions, not per-tile dice', () => {
	const clusters = components((x, y) => terrainCharAt(x, y) === 'f', DIRS8);
	const total = clusters.reduce((sum, c) => sum + c.size, 0);
	const mean = total / clusters.length;
	// Per-tile dice (the old generator's `vegetation(x, y) > threshold`, independent of its
	// neighbours) produces mostly 1-4 tile flecks. This generator's moisture field is coherent
	// enough that the mean sits in the hundreds; 20 is comfortably above what dice would give and
	// comfortably below what this generator actually produces.
	assert.ok(mean > 20, `mean forest cluster size is only ${mean.toFixed(1)} tiles`);
});

test('a river is a detour, not a wall — the route bends around it', () => {
	// Terrain has to change the route, not merely cost time. This lived in scripts/rules-check.ts as
	// an HTTP case until the reach began gating movement work: proving it needs a destination on the
	// far side of a river, and a fresh realm's circle is six tiles of meadow, forest, hills and
	// outcrop with no water in it at all, so the order is now refused OUTSIDE_REACH for exactly the
	// right reason. `route` is pure, so the claim tests better here anyway — it can ask about any two
	// tiles on the map without a realm big enough to own them.
	//
	// Movement costs come from seed.ts's TERRAIN table. Water is expensive (8.0) and never
	// impassable, which is the whole point: a river is something you walk around because it is dear,
	// not something that makes a tile unreachable. If it were impassable `route` would throw instead
	// of answering, which is one of the issue's named failure conditions.
	const COST: Record<string, number> = {
		'.': 1.0,
		f: 2.0,
		c: 1.5,
		s: 2.5,
		i: 2.5,
		h: 1.5,
		m: 5.0,
		w: 8.0
	};
	const cost = (x: number, y: number) => COST[terrainCharAt(x, y)];

	// Bresenham: which tiles a straight line would cross. Used only to pick a destination worth
	// walking to — the question `route` answers by actually walking.
	const lineTiles = (x0: number, y0: number, x1: number, y1: number) => {
		const pts: [number, number][] = [];
		const dx = Math.abs(x1 - x0);
		const dy = -Math.abs(y1 - y0);
		const sx = x0 < x1 ? 1 : -1;
		const sy = y0 < y1 ? 1 : -1;
		let err = dx + dy;
		let x = x0;
		let y = y0;
		for (;;) {
			pts.push([x, y]);
			if (x === x1 && y === y1) break;
			const e2 = 2 * err;
			if (e2 >= dy) {
				err += dy;
				x += sx;
			}
			if (e2 <= dx) {
				err += dx;
				y += sy;
			}
		}
		return pts;
	};

	// The nearest destination whose straight line from the hamlet crosses real water, so the detour
	// is about a river rather than a puddle. Found, never written down — a coordinate here would name
	// whatever the generator drew the day it was typed.
	let dest: [number, number] | null = null;
	let best = Infinity;
	for (let y = 0; y < GRID_SIZE; y++)
		for (let x = 0; x < GRID_SIZE; x++) {
			if (terrainCharAt(x, y) === 'w') continue;
			const d = Math.hypot(x - START.hamletX, y - START.hamletY);
			if (d >= best) continue;
			const wet = lineTiles(START.hamletX, START.hamletY, x, y).filter(
				([lx, ly]) => terrainCharAt(lx, ly) === 'w'
			).length;
			if (wet >= 3) {
				best = d;
				dest = [x, y];
			}
		}
	assert.ok(dest, 'no destination has a straight line from the hamlet crossing 3+ water tiles');

	const [dx, dy] = dest!;
	const walked = route(START.hamletX, START.hamletY, dx, dy, 1, cost, GRID_SIZE);
	const wetRoute = walked.path.filter(
		(i) => terrainCharAt(i % GRID_SIZE, Math.floor(i / GRID_SIZE)) === 'w'
	).length;
	const wetStraight = lineTiles(START.hamletX, START.hamletY, dx, dy).filter(
		([lx, ly]) => terrainCharAt(lx, ly) === 'w'
	).length;
	// Fewer, not none. `route` minimises *cost*, and water is dear (8.0) rather than forbidden — so
	// where going around would cost more than fording, fording is the right answer and the path takes
	// it. An earlier version of this asserted the route came back completely dry; it passed only
	// because the old hand-drawn lake was big enough that around was always cheaper, and a generated
	// river one tile wide is not. What terrain actually promises is that it *changes* the route, and
	// that is what this asks.
	assert.ok(
		wetRoute < wetStraight,
		`the route to (${dx},${dy}) crosses ${wetRoute} water tiles, no better than the straight line's ${wetStraight}`
	);
	// And it costs time. Steps are the wrong measure — movement is 8-directional, so a path can
	// sidestep a one-tile river and land on the same Chebyshev distance it started with, which is
	// exactly what happened when this asserted step count. What terrain actually promises is that it
	// *slows* travel, and `route` reports that directly: compare the real crossing against the same
	// trip priced as though every tile were open meadow.
	const overMeadow = route(START.hamletX, START.hamletY, dx, dy, 1, () => 1, GRID_SIZE);
	assert.ok(
		walked.seconds > overMeadow.seconds,
		`the crossing to (${dx},${dy}) took ${walked.seconds.toFixed(1)}s, no worse than ${overMeadow.seconds.toFixed(1)}s over open meadow — terrain cost nothing`
	);
});

// The cache key world.server.ts's egress fix rides on: same inputs, same version, forever — never
// a function of *when* the seed ran, which is the property that lets `vercel-build` reseed on
// every deploy without invalidating a client's cached statics or the server's in-process memo on a
// deploy that changed nothing about the world.
test('contentVersion is stable for the same inputs and moves when any of them does', () => {
	const a = contentVersion(90210, 128, 'source text');
	const b = contentVersion(90210, 128, 'source text');
	assert.equal(a, b);
	assert.notEqual(a, contentVersion(90210, 128, 'source texu')); // one character of the source
	assert.notEqual(a, contentVersion(90211, 128, 'source text')); // the seed
	assert.notEqual(a, contentVersion(90210, 129, 'source text')); // the grid size
});
