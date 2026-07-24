// Run: npm test  (node --test, no framework added)
import assert from 'node:assert/strict';
import test from 'node:test';
import {
	accrue,
	crewBuild,
	crewRate,
	eligibleTypeIds,
	NAME_POOL,
	pickName,
	population,
	positionAt,
	qualityBand,
	rollStats,
	skillValue,
	STAT_MAX,
	STAT_MIN,
	travelFraction,
	travelSeconds
} from './world.ts';

const leg = (startedAt: string, travelDoneAt: string) => ({
	originX: 0,
	originY: 0,
	destX: 10,
	destY: 20,
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
	assert.deepEqual(positionAt(leg(T0, T10), now + 5000), { x: 5, y: 10 });
	assert.equal(travelFraction(leg(T0, T10), now + 99000), 1);
});

test('a zero-length leg means arrived, not a divide by zero', () => {
	assert.equal(travelFraction(leg(T0, T0), now), 1);
	assert.deepEqual(positionAt(leg(T0, T0), now), { x: 10, y: 20 });
});

const meadow = () => 1;
// A lake across the middle rows, matching the seed layout's shape.
const lake = (_x: number, y: number) => (y >= 3 && y <= 7 ? 8 : 1);

test('flat cost-1 terrain reproduces the pre-terrain formula exactly', () => {
	// The observed tracer trip before terrain existed: hypot(13,13)/0.5 = 36.77 → 37.
	assert.equal(travelSeconds(1, 1, 14, 14, 0.5, meadow), 37);
	assert.equal(travelSeconds(0, 0, 3, 4, 1, meadow), 5);
});

test('crossing costly terrain is slower than the same distance over meadow', () => {
	const dry = travelSeconds(7, 9, 14, 9, 0.5, lake);
	const wet = travelSeconds(7, 9, 7, 2, 0.5, lake);
	assert.equal(dry, 14);
	assert.equal(wet, 84);
	assert.ok(wet > dry * 3, `${wet}s vs ${dry}s is not a perceptible difference`);
});

test('a trip costs the same in both directions', () => {
	assert.equal(travelSeconds(3, 12, 11, 2, 0.5, lake), travelSeconds(11, 2, 3, 12, 0.5, lake));
});

test('a zero-length trip is 0 seconds, not NaN', () => {
	assert.equal(travelSeconds(4, 4, 4, 4, 0.5, lake), 0);
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
	{ id: 1 }, // House
	{ id: 2 }, // Barn
	{ id: 3 }, // Quarry — the one extractor (Stone requires it)
	{ id: 4 }, // Stone wall
	{ id: 5 } // School
];
// Only Stone names a required building; everything else is gathered bare-handed.
const RES = [
	{ id: 10, requiresBuildingTypeId: null }, // Food
	{ id: 11, requiresBuildingTypeId: null }, // Wood
	{ id: 12, requiresBuildingTypeId: 3 }, // Stone ⇒ Quarry
	{ id: 13, requiresBuildingTypeId: null }, // Clay — no extractor exists
	{ id: 14, requiresBuildingTypeId: null } // Iron — no extractor exists
];

test('plain ground offers every type except an extractor', () => {
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
