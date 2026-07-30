// Run: npm test  (node --test, no framework added)
import assert from 'node:assert/strict';
import test from 'node:test';
import {
	accrue,
	crewBuild,
	crewRate,
	eligibleTypeIds,
	NAME_POOL,
	netRates,
	pickName,
	population,
	positionAt,
	qualityBand,
	reachFor,
	roadArms,
	roadStyles,
	rollStats,
	skillValue,
	snappedEdge,
	STAT_MAX,
	STAT_MIN,
	route,
	tileAt,
	travelFraction,
	withinReach,
	zoomAbout
} from './world.ts';

// A 16-tile test grid, small enough to reason about by hand. The routing tests below use it rather
// than the real map: an invariant that needs the seed to hold is an invariant nobody can read.
const G = 16;
const idx = (x: number, y: number) => y * G + x;
const tiles = (path: number[]) => path.map((i) => [i % G, Math.floor(i / G)]);

const leg = (startedAt: string, travelDoneAt: string) => ({
	// Straight down the map, ten tiles: (0,0) → (10,20) is no longer expressible on a 16-wide grid,
	// and a straight run is what the fraction tests are about anyway.
	path: [idx(0, 0), idx(0, 5), idx(0, 10)],
	startedAt,
	travelDoneAt
});

const T0 = '2026-01-01T00:00:00.000Z';
const T10 = '2026-01-01T00:00:10.000Z';
const now = Date.parse(T0);

test('fraction is 0 at departure and clamps below', () => {
	assert.equal(travelFraction(leg(T0, T10), now), 0);
	assert.equal(travelFraction(leg(T0, T10), now - 5000), 0);
});

test('fraction interpolates mid-travel and clamps above', () => {
	assert.equal(travelFraction(leg(T0, T10), now + 2500), 0.25);
	assert.deepEqual(positionAt(leg(T0, T10), now + 5000, G), { x: 0, y: 5 });
	assert.equal(travelFraction(leg(T0, T10), now + 99000), 1);
});

test('a zero-length leg means arrived, not a divide by zero', () => {
	assert.equal(travelFraction(leg(T0, T0), now), 1);
	assert.deepEqual(positionAt(leg(T0, T0), now, G), { x: 0, y: 10 });
});

test('a body walks the corners of its route, not the straight line through them', () => {
	// An L: five east, then five south. Halfway in time is halfway along the *route*, which is the
	// corner itself — a straight-line reading would have put it out in the middle of the L instead.
	const bend = { path: [idx(0, 0), idx(5, 0), idx(5, 5)], startedAt: T0, travelDoneAt: T10 };
	assert.deepEqual(positionAt(bend, now + 5000, G), { x: 5, y: 0 });
	assert.deepEqual(positionAt(bend, now + 2500, G), { x: 2.5, y: 0 });
	assert.deepEqual(positionAt(bend, now + 7500, G), { x: 5, y: 2.5 });
});

const meadow = () => 1;
// A lake across the middle rows with a dry margin at each edge, so there is always a way round.
const lake = (x: number, y: number) => (y >= 3 && y <= 7 && x >= 2 && x <= 13 ? 8 : 1);

test('flat terrain routes in a straight line, at the old cost', () => {
	// Eight-way movement on uniform ground: a pure diagonal is hypot, an axis run is its length.
	assert.equal(route(1, 1, 8, 8, 0.5, meadow, G).seconds, Math.ceil(Math.hypot(7, 7) / 0.5));
	assert.equal(route(0, 0, 0, 4, 1, meadow, G).seconds, 4);
	// Straight means every step is one tile and there are no more of them than the distance.
	assert.equal(route(1, 1, 8, 8, 0.5, meadow, G).path.length, 8);
});

test('a body walks around costly ground rather than through it', () => {
	// The whole point of routing. Straight from (7,1) to (7,9) is eight tiles of lake; going round
	// the western shore is longer in distance and far cheaper in time.
	const wet = route(7, 1, 7, 9, 0.5, lake, G);
	const crossed = tiles(wet.path).filter(([x, y]) => lake(x, y) > 1);
	assert.equal(crossed.length, 0, `walked through ${crossed.length} tiles of lake`);
	// And it is still slower than the same trip over open ground — the detour costs something.
	assert.ok(wet.seconds > route(7, 1, 7, 9, 0.5, meadow, G).seconds);
});

test('a route is a connected chain of single steps from origin to destination', () => {
	const { path } = route(2, 12, 11, 2, 0.5, lake, G);
	assert.deepEqual(tiles(path)[0], [2, 12]);
	assert.deepEqual(tiles(path).at(-1), [11, 2]);
	for (const [i, [x, y]] of tiles(path).slice(1).entries()) {
		const [px, py] = tiles(path)[i];
		assert.ok(
			Math.abs(x - px) <= 1 && Math.abs(y - py) <= 1,
			`(${px},${py}) → (${x},${y}) is not one step`
		);
	}
});

test('a trip costs the same in both directions', () => {
	// Averaging the two tiles of each step is what buys this; charging the tile you land on would
	// make A→B and B→A disagree, and the estimate is a separate call from the order it becomes.
	assert.equal(
		route(2, 12, 11, 2, 0.5, lake, G).seconds,
		route(11, 2, 2, 12, 0.5, lake, G).seconds
	);
});

test('a zero-length trip is 0 seconds on its own tile, not NaN', () => {
	const here = route(4, 4, 4, 4, 0.5, lake, G);
	assert.equal(here.seconds, 0);
	assert.deepEqual(here.path, [idx(4, 4)]);
});

// Accrual. This is the one mechanic that cannot be verified by watching it — a thirty-day
// regrowth is not a test anyone runs — so the arithmetic is pinned here rather than in the
// browser. `accrue` is pure and takes no database, which is what makes that possible.

const HOUR = 3600;
const DAY = 24 * HOUR;
// A forest tile as seeded: 25 trees, back to full in thirty days.
const forest = (quantity: number, agedSeconds: number) => ({
	quantity,
	capacity: 25,
	regrowSeconds: 30 * DAY,
	agedSeconds
});

test('an infinite deposit just pays the rate, prorated by the hour', () => {
	assert.equal(accrue(3, HOUR, null).harvested, 3);
	assert.equal(accrue(3, 1200, null).harvested, 1);
	assert.equal(accrue(12, 300, null).harvested, 1);
	// Nothing to count down, so nothing to report.
	assert.equal(accrue(3, HOUR, null).quantity, null);
});

test('nothing has been earned before any time passes', () => {
	assert.equal(accrue(3, 0, null).harvested, 0);
});

test('time that has not happened yet pays nothing, rather than owing', () => {
	// `accrued_at` starts when the worker *arrives*, so every read during the walk asks about
	// a negative interval. Answering with a negative number would drain stock on a refresh.
	assert.equal(accrue(3, -600, null).harvested, 0);
	assert.equal(accrue(3, -600, forest(25, -600)).quantity, 25);
});

test('a rate of zero is a tile that is on the map but not yet wired', () => {
	assert.equal(accrue(0, DAY, null).harvested, 0);
});

test('a week away equals a hundred visits — the property a tick would break', () => {
	const week = 7 * DAY;
	const away = accrue(3, week, null).harvested;

	let watched = 0;
	for (let i = 0; i < 100; i++) watched += accrue(3, week / 100, null).harvested;

	// The model is resolution-independent — the integral is linear, so how often you look
	// cannot change the total. What separates these two numbers is only the drift of adding
	// a double a hundred times, and at 504 units it is a part in 10^15.
	//
	// The tolerance is the point of the test, not a concession: stock is stored fractional
	// precisely so that this stays drift and never becomes truncation. If a future change
	// rounds on each read, this gap goes to ~50 units and the assertion fails loudly.
	assert.ok(Math.abs(watched - away) < 1e-9, `drifted by ${Math.abs(watched - away)}`);
});

test('a worked forest thins, and stops at exactly zero rather than going below', () => {
	// Eight hours at 3/h is 24 of the 25 trees, less the trickle that grew back meanwhile.
	const eight = accrue(3, 8 * HOUR, forest(25, 8 * HOUR));
	assert.ok(eight.quantity! > 0 && eight.quantity! < 2, `left ${eight.quantity}`);

	// A month of chopping cannot take more than the tile ever held plus what grew.
	const month = accrue(3, 30 * DAY, forest(25, 30 * DAY));
	assert.equal(month.quantity, 0);
	assert.equal(month.harvested, 25 + 25, 'everything that was there plus one full regrowth');
});

test('an emptied tile still yields the regrowth, and only that', () => {
	// The trickle, kept deliberately: the worker is cutting saplings. At 1 tree per 29 hours
	// against 1 per 20 minutes it reads as "this forest is finished" without a special case
	// that says so — and killing it would mean pausing regrowth under a standing worker,
	// making a tile's recovery depend on whether somebody happens to be there.
	const hour = accrue(3, HOUR, forest(0, HOUR));
	assert.equal(hour.quantity, 0);
	assert.equal(hour.harvested, 25 / (30 * 24), 'exactly what grew');
	assert.ok(hour.harvested < 3 / 80, 'and under an eightieth of the full rate');
});

test('an abandoned tile regrows to exactly full, and no further', () => {
	// Nobody on it: rate zero, no worked time, only the tile's own clock running.
	assert.equal(accrue(0, 0, forest(0, 15 * DAY)).quantity, 12.5);
	assert.equal(accrue(0, 0, forest(0, 30 * DAY)).quantity, 25);
	assert.equal(accrue(0, 0, forest(0, 300 * DAY)).quantity, 25, 'clamped at capacity');
	assert.equal(accrue(0, 0, forest(25, 300 * DAY)).quantity, 25);
});

test('the display path and the work path agree over the same interval', () => {
	// `readWorld` projects an abandoned tile forward with no worker on it and writes nothing.
	// If it disagreed with the branch that does write, a forest would read one number and be
	// stored as another.
	const displayed = accrue(0, 0, forest(4, 3 * DAY));
	const worked = accrue(0, 3 * DAY, forest(4, 3 * DAY));
	assert.equal(displayed.quantity, worked.quantity);
});

// Population and food. Like accrual, real-time and unwatchable at speed — pinned here.
// Rates chosen so the common case holds: per-capita food (1/hr) below one forager's 12/hr yield.
const FED = { growthPerHour: 2, foodPerCapitaHour: 1, starvePerHour: 2 };

test('everyone eats, and a fed town below the cap grows', () => {
	// 3 mouths for an hour is 3 food; 2/hr growth for that hour is two settlers, exactly.
	const r = population(3, 10, 100, 0, FED, HOUR);
	assert.equal(r.foodDrained, 3);
	assert.equal(r.born, 2);
	assert.equal(r.died, 0);
	assert.ok(Math.abs(r.accrued - 0) < 1e-9, `carried ${r.accrued}`);
});

test('nobody is born before a whole settler has accrued', () => {
	// Quarter hour at 2/hr is 0.5 — still nobody, and the fraction is held in `accrued`.
	const r = population(3, 10, 100, 0, FED, HOUR / 4);
	assert.equal(r.born, 0);
	assert.ok(Math.abs(r.accrued - 0.5) < 1e-9);
});

test('growth stops at the housing cap and banks no backlog', () => {
	// At the cap, fed (food to spare): food still drains, but no births and no stored pressure.
	const r = population(10, 10, 5000, 0, FED, 100 * HOUR);
	assert.equal(r.born, 0);
	assert.equal(r.accrued, 0, 'a hundred hours full does not bank into an instant fill later');
	assert.equal(r.foodDrained, 1000, 'ten mouths at 1/hr still ate for a hundred hours');
});

// Starvation in isolation: growth switched off so the departure count is unambiguous. In play
// the two net against each other in one interval (grew while fed, left while hungry).
const STARVING = { ...FED, growthPerHour: 0 };

test('food that runs out mid-interval starves the hungry tail', () => {
	// 4 mouths at 1/hr drain 4 food/hr, so 6 food lasts 1.5h; the realm then starves for the
	// remaining 0.5h at 2/hr — one departure, and every scrap of food is gone.
	const r = population(4, 10, 6, 0, STARVING, 2 * HOUR);
	assert.equal(r.foodDrained, 6, 'drained to empty, not below');
	assert.equal(r.died, 1);
	assert.equal(r.born, 0);
});

test('an emptied realm owes no deaths once it hits zero', () => {
	// One mouth, no food, long absence: it leaves, and the negative pressure is not banked
	// into a debt that would kill the next arrival on sight.
	const r = population(1, 10, 0, 0, FED, 7 * DAY);
	assert.equal(r.died, 1);
	assert.equal(r.accrued, 0);
	assert.equal(r.foodDrained, 0, 'no food, nothing to drain');
});

test('an empty, unprovisioned settlement stays empty rather than conjuring settlers', () => {
	// Zero pop means zero drain, so food never gates the interval — without the food check this
	// would "grow" from nothing. With no food in store, it must not.
	const r = population(0, 10, 0, 0, FED, DAY);
	assert.deepEqual(r, { born: 0, died: 0, foodDrained: 0, accrued: 0 });
});

test('food drain is resolution-independent at a steady population', () => {
	// At the cap with food to spare, pop holds all interval, so the drain is exactly linear and
	// how often you look cannot change the total. Clean numbers keep it about the model, not float.
	const span = 10 * HOUR;
	const once = population(8, 8, 1000, 0, FED, span);
	assert.equal(once.foodDrained, 8 * 10);
	assert.equal(once.born, 0);

	let food = 1000;
	let drained = 0;
	for (let i = 0; i < 40; i++) {
		const step = population(8, 8, food, 0, FED, span / 40);
		food -= step.foodDrained;
		drained += step.foodDrained;
	}
	assert.ok(
		Math.abs(drained - once.foodDrained) < 1e-9,
		`drifted by ${drained - once.foodDrained}`
	);
});

// Specialist generation. The roll uses randomness in production, so it is pinned here with a
// seeded generator — a repeatable sequence, not a coin flip npm test can't check.
const seeded = (seed: number) => () => {
	seed = (seed * 1103515245 + 12345) & 0x7fffffff;
	return seed / 0x7fffffff;
};

test('rolled stats stay in range and are repeatable from a seed', () => {
	const s = rollStats(seeded(42));
	for (const v of Object.values(s)) {
		assert.ok(Number.isInteger(v), `${v} is not a whole stat`);
		assert.ok(v >= STAT_MIN && v <= STAT_MAX, `${v} out of [${STAT_MIN}, ${STAT_MAX}]`);
	}
	// Same seed, same sheet — determinism is the property that makes this testable at all.
	assert.deepEqual(rollStats(seeded(42)), s);
});

test('names prefer the unused, and never run dry', () => {
	// With all but one taken, the pick is forced to the survivor.
	const taken = new Set(NAME_POOL.slice(1));
	assert.equal(pickName(seeded(7), taken), NAME_POOL[0]);
	// Everyone taken: reuse rather than fail — a cosmetic collision, not an error.
	const all = new Set(NAME_POOL);
	assert.ok(NAME_POOL.includes(pickName(seeded(7), all)));
});

// Skill → quality. The whole "who does the job matters" mechanic, pinned so the 4–5× the design
// asks for can't quietly erode. Baseline 0.15, curve 0.3 mirror the seeded game_config.
const SKILL = { settlerBaseline: 0.15, skillCurve: 0.3 };
const MID = (STAT_MIN + STAT_MAX) / 2;

test('a settler works at the flat baseline, whatever the ground', () => {
	// No bundle and no stats — the anonymous many all work the same.
	assert.equal(skillValue(null, null, null, SKILL), 0.15);
});

test('an average-rolled specialist works at their trained value', () => {
	// Governing stats at the middle of the range ⇒ no swing ⇒ exactly the bundle value.
	assert.ok(Math.abs(skillValue(0.7, MID, MID, SKILL) - 0.7) < 1e-9);
});

test('a matched specialist beats a settler by the 4–5× the design asks for', () => {
	// Worst and best rolls bracket the specialist band; both are ~4–5× the settler baseline.
	const weak = skillValue(0.7, STAT_MIN, STAT_MIN, SKILL);
	const strong = skillValue(0.7, STAT_MAX, STAT_MAX, SKILL);
	assert.ok(weak > 0.55 && weak < 0.65, `weak specialist ${weak}`);
	assert.ok(strong > 0.75 && strong < 0.85, `strong specialist ${strong}`);
	assert.ok(strong > weak, 'a better roll is a better worker');
	assert.ok(weak / SKILL.settlerBaseline >= 4, `${weak / SKILL.settlerBaseline}× is under 4`);
	assert.ok(strong / SKILL.settlerBaseline <= 5.5, `${strong / SKILL.settlerBaseline}× over 5.5`);
});

test('a specialist off their craft falls back to the settler baseline', () => {
	// A Mason foraging: no Foraging bundle ⇒ null ⇒ no better than a settler, so profession bites.
	assert.equal(skillValue(null, STAT_MAX, STAT_MAX, SKILL), 0.15);
	// And even a wretched roll at your own trade never drops below a settler.
	assert.equal(skillValue(0.1, STAT_MIN, STAT_MIN, SKILL), 0.15);
});

test('a week away on a finite tile equals many visits', () => {
	const week = 7 * DAY;
	const away = accrue(3, week, forest(25, week));

	let q = 25;
	let taken = 0;
	for (let i = 0; i < 200; i++) {
		const step = accrue(3, week / 200, forest(q, week / 200));
		taken += step.harvested;
		q = step.quantity!;
	}
	// Conservation is why this holds even though the tile empties partway through: whatever
	// route you take, the total taken is what was there plus what grew, minus what is left.
	assert.ok(
		Math.abs(taken - away.harvested) < 1e-9,
		`harvest drifted by ${taken - away.harvested}`
	);
	assert.ok(Math.abs(q - away.quantity!) < 1e-9, `stock drifted by ${q - away.quantity!}`);
});

// eligibleTypeIds — the terrain-menu rule authored once for the server gate and the wire allow-list.
const CATALOG = [
	{ id: 1, playerBuildable: true }, // House
	{ id: 2, playerBuildable: true }, // Barn
	{ id: 3, playerBuildable: true }, // Quarry — the one extractor (Stone requires it)
	{ id: 4, playerBuildable: true }, // Stone wall
	{ id: 5, playerBuildable: true }, // School
	{ id: 6, playerBuildable: false } // Marketplace — never offered, whatever the ground
];
// Only Stone names a required building; everything else is gathered bare-handed.
const RES = [
	{ id: 10, requiresBuildingTypeId: null }, // Food
	{ id: 11, requiresBuildingTypeId: null }, // Wood
	{ id: 12, requiresBuildingTypeId: 3 }, // Stone ⇒ Quarry
	{ id: 13, requiresBuildingTypeId: null }, // Clay — no extractor exists
	{ id: 14, requiresBuildingTypeId: null } // Iron — no extractor exists
];

test('plain ground offers every player-buildable type except an extractor', () => {
	const meadow = { buildable: true, isDeposit: false, yieldsResourceId: 10 };
	assert.deepEqual(eligibleTypeIds(meadow, CATALOG, RES), [1, 2, 4, 5]);
});

test('a deposit offers only the extractor that takes its yield', () => {
	const outcrop = { buildable: true, isDeposit: true, yieldsResourceId: 12 };
	assert.deepEqual(eligibleTypeIds(outcrop, CATALOG, RES), [3]);
});

test('a deposit with no extractor yet offers nothing', () => {
	const clay = { buildable: true, isDeposit: true, yieldsResourceId: 13 };
	assert.deepEqual(eligibleTypeIds(clay, CATALOG, RES), []);
	const iron = { buildable: true, isDeposit: true, yieldsResourceId: 14 };
	assert.deepEqual(eligibleTypeIds(iron, CATALOG, RES), []);
});

test('unbuildable ground offers nothing, subsuming the old buildable check', () => {
	const mountain = { buildable: false, isDeposit: false, yieldsResourceId: null };
	assert.deepEqual(eligibleTypeIds(mountain, CATALOG, RES), []);
});

// ---- Reach --------------------------------------------------------------------------------------
// The sphere of influence: one Euclidean test shared by the drawn circle and the server gate
// (`withinReach`), and one milestone lookup shared by the tested function and the SQL ratchet that
// only ever does GREATEST (`reachFor`).

test('withinReach is a circle, and the edge itself counts as inside', () => {
	const reach = { x: 10, y: 10, radius: 5 };
	assert.equal(withinReach(10, 10, reach), true, 'the centre is inside its own reach');
	assert.equal(withinReach(15, 10, reach), true, 'exactly on the radius is inside');
	assert.equal(withinReach(16, 10, reach), false, 'one tile past the radius is outside');
	// Off-axis: a 3-4-5 triangle lands exactly on the boundary too.
	assert.equal(withinReach(13, 14, reach), true, '3-4-5 puts this exactly on the radius');
	assert.equal(withinReach(14, 14, reach), false);
});

test('withinReach has nothing to be inside with no reach at all', () => {
	assert.equal(withinReach(0, 0, null), false);
});

const MILESTONES = [
	{ population: 3, radius: 6 },
	{ population: 8, radius: 9 },
	{ population: 15, radius: 13 },
	{ population: 25, radius: 18 },
	{ population: 40, radius: 24 }
];

test('reachFor is 0 below the first milestone — no reach earned yet', () => {
	assert.equal(reachFor(0, MILESTONES), 0);
	assert.equal(reachFor(2, MILESTONES), 0);
});

test('reachFor steps at each threshold and holds until the next one', () => {
	assert.equal(reachFor(3, MILESTONES), 6);
	assert.equal(reachFor(7, MILESTONES), 6);
	assert.equal(reachFor(8, MILESTONES), 9);
	assert.equal(reachFor(14, MILESTONES), 9);
	assert.equal(reachFor(15, MILESTONES), 13);
	assert.equal(reachFor(24, MILESTONES), 13);
	assert.equal(reachFor(25, MILESTONES), 18);
	assert.equal(reachFor(39, MILESTONES), 18);
	assert.equal(reachFor(40, MILESTONES), 24);
	assert.equal(reachFor(999, MILESTONES), 24, 'the last milestone holds forever past it');
});

test('reachFor takes the highest threshold met, regardless of table order', () => {
	assert.equal(reachFor(20, [...MILESTONES].reverse()), 13);
});

test('reachFor with an empty table is 0 — the case the seed throws to prevent', () => {
	assert.equal(reachFor(100, []), 0);
});

// ---- The crew ---------------------------------------------------------------------------------
// The four feel invariants, as assertions rather than something felt for in a browser. Numbers are
// the design's reference case: a 300-second building, a settler at 0.15, a Mason at 0.60.
const BUILD = 300;
const SETTLER = 0.15;
const MASON = 0.6;
// Everyone on the site from the off, unless a case says otherwise — travel is the *other* thing
// crewBuild folds in, and it gets its own cases below.
const together = (...multipliers: number[]) =>
	multipliers.map((multiplier) => ({ multiplier, arrivesAtSeconds: 0 }));
const build = (...multipliers: number[]) => {
	const { seconds, quality } = crewBuild(together(...multipliers), BUILD);
	return { seconds: Math.round(seconds), quality: Number(quality.toFixed(2)) };
};
const settlers = (n: number) => build(...new Array(n).fill(SETTLER));

test('a one-member crew is exactly the old arithmetic — solo builds keep their numbers', () => {
	assert.deepEqual(build(SETTLER), { seconds: BUILD / SETTLER, quality: SETTLER });
	assert.deepEqual(build(MASON), { seconds: BUILD / MASON, quality: MASON });
	// And the travel leg is simply carried: the clock is the whole time from the order.
	const { seconds } = crewBuild([{ multiplier: MASON, arrivesAtSeconds: 90 }], BUILD);
	assert.equal(seconds, 90 + BUILD / MASON);
});

test('more bodies is faster, and visibly flattening — the whole no-cap argument', () => {
	const times = [1, 2, 4, 8, 12].map((n) => settlers(n).seconds);
	assert.deepEqual(times, [2000, 1172, 718, 458, 356]);
	// Monotone (a body never slows the site) with shrinking gains (so piling on self-punishes).
	const gains = times.slice(1).map((t, i) => times[i] - t);
	assert.ok(gains.every((g) => g > 0));
	assert.ok(gains.every((g, i) => i === 0 || g < gains[i - 1]));
	// Quality is untouched by headcount when everyone is equally unskilled.
	assert.ok([1, 2, 4, 8, 12].every((n) => settlers(n).quality === SETTLER));
});

test('a lone specialist beats a crowd of settlers on workmanship, and 4 of them outright', () => {
	assert.deepEqual(build(MASON), { seconds: 500, quality: 0.6 });
	assert.ok(build(MASON).seconds < settlers(4).seconds);
	// The trade stated the other way: enough bodies do beat him on speed, at a quarter the quality.
	assert.ok(settlers(12).seconds < build(MASON).seconds);
	assert.ok(settlers(12).quality < build(MASON).quality);
});

test('bodies buy speed and cost workmanship — the trade, made visible', () => {
	assert.deepEqual(build(MASON, SETTLER), { seconds: 425, quality: 0.53 });
	assert.deepEqual(build(MASON, SETTLER, SETTLER, SETTLER, SETTLER), {
		seconds: 321,
		quality: 0.44
	});
	// Each settler added to the Mason is faster than the last crew and worse than it.
	const crews = [build(MASON), build(MASON, SETTLER), build(MASON, SETTLER, SETTLER)];
	assert.ok(
		crews.every(
			(c, i) => i === 0 || (c.seconds < crews[i - 1].seconds && c.quality < crews[i - 1].quality)
		)
	);
});

test('specialists are the only lever that buys speed without paying quality', () => {
	assert.deepEqual(build(MASON, MASON), { seconds: 293, quality: 0.6 });
	assert.deepEqual(build(MASON, MASON, MASON), { seconds: 219, quality: 0.6 });
	// Faster than the Mason alone *and* holding his quality — "fast AND good", the epic's point.
	assert.ok(build(MASON, MASON).seconds < build(MASON).seconds);
	assert.equal(build(MASON, MASON).quality, build(MASON).quality);
});

test('the better specialist leads, and the crew reads above its second-best', () => {
	assert.deepEqual(build(0.68, 0.6), { seconds: 272, quality: 0.65 });
	// Order in is irrelevant — competence decides the rank, not argument position.
	assert.deepEqual(build(0.6, 0.68), build(0.68, 0.6));
});

test('a late member contributes from arrival, and a no-show not at all', () => {
	const late = (delay: number) =>
		crewBuild(
			[
				{ multiplier: MASON, arrivesAtSeconds: 0 },
				{ multiplier: MASON, arrivesAtSeconds: delay }
			],
			BUILD
		);
	// 60s late: slower than arriving together (293s), faster than working alone (500s).
	assert.equal(Math.round(late(60).seconds), 318);
	// 600s late: the build finished at 500s without them, so they never touched it — and the
	// quality is the first Mason's alone, with no special case written to say so.
	assert.equal(Math.round(late(600).seconds), 500);
	assert.equal(Number(late(600).quality.toFixed(2)), MASON);
	// A member who misses the whole build cannot drag the workmanship either way.
	const noShow = crewBuild(
		[
			{ multiplier: MASON, arrivesAtSeconds: 0 },
			{ multiplier: SETTLER, arrivesAtSeconds: 600 }
		],
		BUILD
	);
	assert.equal(Number(noShow.quality.toFixed(2)), MASON);
});

test('adding a body never slows a build, however late it lands', () => {
	const solo = crewBuild([{ multiplier: SETTLER, arrivesAtSeconds: 0 }], BUILD).seconds;
	for (const delay of [0, 1, 50, 500, 1999, 2000, 5000]) {
		const pair = crewBuild(
			[
				{ multiplier: SETTLER, arrivesAtSeconds: 0 },
				{ multiplier: MASON, arrivesAtSeconds: delay }
			],
			BUILD
		).seconds;
		assert.ok(pair <= solo, `a helper arriving at ${delay}s made it slower`);
	}
});

test('crewRate is the 1/√k rule and nothing else', () => {
	assert.equal(crewRate([SETTLER]), SETTLER);
	assert.equal(crewRate([MASON, MASON]), MASON + MASON / Math.SQRT2);
	// Sorted descending, so the ranking is by competence rather than by the order handed in.
	assert.equal(crewRate([0.1, 0.9]), 0.9 + 0.1 / Math.SQRT2);
});

test('quality reads as a word, and the words are ordered', () => {
	// A raw 0.44 tells nobody anything; the band is what the panel says out loud.
	assert.equal(qualityBand(SETTLER), 'Rough', 'settlers alone are the floor');
	assert.equal(qualityBand(build(MASON, SETTLER, SETTLER, SETTLER, SETTLER).quality), 'Good');
	assert.equal(qualityBand(build(MASON, MASON).quality), 'Fine');
	// 0.80 is the observed ceiling — a Carpenter with a good stat roll, working alone.
	assert.equal(qualityBand(0.8), 'Masterwork', 'a trained builder at their best');
	// Monotone across the whole scale: better work never reads as a worse word.
	const seen: string[] = [];
	for (let q = 0; q <= 1.0001; q += 0.01) {
		const band = qualityBand(q);
		if (band !== seen[seen.length - 1]) seen.push(band);
	}
	assert.deepEqual(seen, ['Rough', 'Fair', 'Good', 'Fine', 'Masterwork']);
});

test('every band boundary belongs to the band above it', () => {
	// Half-open from below, so no value falls between two bands and none belongs to both.
	for (const [edge, below] of [
		[0.28, 'Rough'],
		[0.41, 'Fair'],
		[0.54, 'Good'],
		[0.67, 'Fine']
	] as const) {
		assert.equal(qualityBand(edge - 1e-9), below);
		assert.notEqual(qualityBand(edge), below);
	}
});

const NOW = Date.parse('2026-01-01T12:00:00.000Z');
const gather = (resourceId: number, unitsPerHour: number, arrivals: number[]) => ({
	resourceId,
	unitsPerHour,
	qualityMultiplier: 1,
	arrivals
});

test('the resource bar credits arrived workers and nobody else', () => {
	// Two on the same forest: one standing in it, one still walking. Only the first earns.
	const rates = netRates([gather(2, 3, [NOW - 60_000, NOW + 60_000])], NOW, null);
	assert.equal(rates.get(2), 3);
});

test('rates stack per resource and scale with workmanship', () => {
	const rates = netRates(
		[
			{ ...gather(2, 3, [NOW]), qualityMultiplier: 0.15 },
			{ ...gather(2, 3, [NOW]), qualityMultiplier: 0.7 },
			gather(1, 12, [NOW])
		],
		NOW,
		null
	);
	assert.equal(rates.get(2), 3 * 0.15 + 3 * 0.7);
	assert.equal(rates.get(1), 12);
});

test('food nets forage against mouths, and reads negative when it cannot keep up', () => {
	const mouths = { resourceId: 1, perCapitaHour: 0.4, population: 6 };
	// A settler forager (0.15 of 12/hr = 1.8) against six mouths (2.4) — the hamlet is losing.
	const losing = netRates([{ ...gather(1, 12, [NOW]), qualityMultiplier: 0.15 }], NOW, mouths);
	assert.ok(losing.get(1)! < 0, 'a settler cannot feed six');
	// A trained Forager covers them with room to spare.
	const winning = netRates([{ ...gather(1, 12, [NOW]), qualityMultiplier: 0.7 }], NOW, mouths);
	assert.ok(winning.get(1)! > 0, 'a Forager can');
	// Nobody working at all is the drain alone — the number a fresh realm shows.
	assert.ok(Math.abs(netRates([], NOW, mouths).get(1)! + 2.4) < 1e-9);
});

// Roads. The shape of a junction is a rule rather than fifteen hand-drawn sprites, so the rule is
// what gets pinned — and the override's one guarantee (it can hide an arm, never invent one) is the
// thing that would otherwise leave roads pointing at grass.
const roads = (...tiles: [number, number][]) => {
	const set = new Set(tiles.map(([x, y]) => `${x},${y}`));
	return (x: number, y: number) => set.has(`${x},${y}`);
};
const N = 1;
const E = 2;
const S = 4;
const W = 8;

test('a road joins the roads beside it and nothing else', () => {
	// A cross: the middle tile joins all four, each arm joins only back to the middle.
	const cross = roads([5, 5], [5, 4], [5, 6], [4, 5], [6, 5]);
	assert.equal(roadArms(5, 5, cross, null), N | E | S | W);
	assert.equal(roadArms(5, 4, cross, null), S);
	assert.equal(roadArms(6, 5, cross, null), W);
	// A lone road joins nothing — a stub, not an error.
	assert.equal(roadArms(9, 9, roads([9, 9]), null), 0);
});

test('a corner is a corner without anybody choosing an orientation', () => {
	// An L bending east then south: the elbow joins east and south, which *is* the corner sprite.
	const bend = roads([2, 2], [3, 2], [2, 3]);
	assert.equal(roadArms(2, 2, bend, null), E | S);
});

test('an override hides an arm and can never invent one', () => {
	const cross = roads([5, 5], [5, 4], [5, 6], [4, 5], [6, 5]);
	// Drawn straight north-south at a crossroads: the east and west arms go unpainted.
	assert.equal(roadArms(5, 5, cross, N | S), N | S);
	// Claiming an arm with no road behind it is intersected away rather than drawn into the grass.
	assert.equal(roadArms(5, 4, cross, N | S), S);
	// And a stored shape whose road is later torn up heals itself: no eastern neighbour, no east arm.
	assert.equal(roadArms(5, 5, roads([5, 5], [5, 4], [5, 6], [4, 5]), N | E | S), N | S);
});

test('only a junction offers a choice of shape, and only of the straights it contains', () => {
	// A crossroads reads three ways: as it joins, north-south, or east-west.
	assert.deepEqual(roadStyles(N | E | S | W), [null, N | S, E | W]);
	// A T with a north-south straight through it offers that one and no other.
	assert.deepEqual(roadStyles(N | S | E), [null, N | S]);
	// A corner, a through-road and a dead end are each already the only drawing of themselves.
	assert.deepEqual(roadStyles(N | E), [null]);
	assert.deepEqual(roadStyles(N | S), [null]);
	assert.deepEqual(roadStyles(N), [null]);
	assert.deepEqual(roadStyles(0), [null]);
});

// ---- Zoom-about-cursor -------------------------------------------------------------------------
// The map-client epic's own arithmetic: where the cursor sits in world space, and how to hold that
// point still while the scale under it changes. Both pure and scroll-position-free of the DOM, so
// the one property that actually matters — nothing drifts as you zoom — is a test, not a squint.

test('tileAt reads the world coordinate under a pane pixel', () => {
	assert.equal(tileAt(0, 0, 32), 0);
	// Scrolled ten tiles in, sixteen pixels further right: still inside tile 10.
	assert.equal(tileAt(320, 16, 32), 10.5);
});

test('zoomAbout keeps the point under the cursor fixed across a zoom step', () => {
	const scroll = 320;
	const px = 200;
	const cell = 32;
	const before = tileAt(scroll, px, cell);
	for (const nextCell of [48, 16, 64, 3]) {
		const nextScroll = zoomAbout(scroll, px, cell, nextCell);
		const after = tileAt(nextScroll, px, nextCell);
		assert.ok(Math.abs(after - before) < 1e-9, `drifted to ${after} at cell ${nextCell}`);
	}
});

test('zoomAbout round-trips: zooming out and back in lands on the original scroll', () => {
	const scroll = 517;
	const px = 137;
	const cell = 32;
	const out = zoomAbout(scroll, px, cell, 12);
	const back = zoomAbout(out, px, 12, cell);
	assert.ok(Math.abs(back - scroll) < 1e-9, `round-trip drifted by ${back - scroll}`);
});

// ---- Snapped tile edges --------------------------------------------------------------------
// Fault 2 was gridlines nobody drew: a fractional `cell` rounded independently at each tile's
// left and right edge can leave a one-pixel gap antialiasing shows as a lighter seam. Pinning
// this across a spread of fractional cell sizes and scroll offsets is what a screenshot can't do
// at every zoom level, and what a regression here would silently reintroduce.

test('snappedEdge tiles exactly: every tile’s right edge is the next tile’s left edge', () => {
	// Below cell 1, a tile can round to zero screen pixels wide — expected at the extreme end of
	// zoom-out (more world tiles than screen pixels), not a bug: the property that matters is that
	// no tile ever gets a *negative* width, and that the chain of edges never gaps or overlaps.
	for (const cell of [0.25, 0.4, 0.97, 1.3, 2.75, 8.01, 33.333, 63.99]) {
		for (const scroll of [0, 5.5, -3.2, 137.7, 1000.1]) {
			let prevRight = snappedEdge(0, cell, scroll);
			for (let x = 0; x < 300; x++) {
				const left = snappedEdge(x, cell, scroll);
				const right = snappedEdge(x + 1, cell, scroll);
				assert.equal(
					left,
					prevRight,
					`gap or overlap at tile ${x}, cell ${cell}, scroll ${scroll}`
				);
				assert.ok(right >= left, `negative width at tile ${x}, cell ${cell}`);
				prevRight = right;
			}
		}
	}
});
