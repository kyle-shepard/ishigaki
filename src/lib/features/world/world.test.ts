// Run: npm test  (node --test, no framework added)
import assert from 'node:assert/strict';
import test from 'node:test';
import { accrue, grow, positionAt, travelFraction, travelSeconds } from './world.ts';

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

// Population growth. Like accrual, real-time and unwatchable at speed — pinned here.

test('nobody is born before a whole settler has accrued', () => {
	// 2/hr for half an hour is 1.0 settlers — but only just; a shade under is still zero.
	assert.deepEqual(grow(3, 10, 2, HOUR / 2), { born: 1, consumedSeconds: HOUR / 2 });
	assert.equal(grow(3, 10, 2, HOUR / 4).born, 0);
	// And the anchor doesn't move while the fraction is still building, so it isn't lost.
	assert.equal(grow(3, 10, 2, HOUR / 4).consumedSeconds, 0);
});

test('growth stops at the housing cap', () => {
	// Room for 2 more, but an hour at 2/hr wants 2 — exactly fills it.
	assert.deepEqual(grow(8, 10, 2, HOUR), { born: 2, consumedSeconds: HOUR });
	// Already full: no births, but the anchor syncs forward so full time cannot bank.
	assert.deepEqual(grow(10, 10, 2, HOUR), { born: 0, consumedSeconds: HOUR });
	// Over a long absence, still only the room — the extra time is discarded, not owed.
	assert.deepEqual(grow(9, 10, 2, 100 * HOUR), { born: 1, consumedSeconds: 100 * HOUR });
});

test('no housing means no anchor drift into an instant fill', () => {
	// A realm sat a week over/at capacity, then a House opens 4 rooms. The week must not
	// have banked into four instant arrivals — the anchor was synced each read while full.
	const away = grow(4, 4, 2, 7 * DAY); // at cap all week
	assert.equal(away.born, 0);
	assert.equal(away.consumedSeconds, 7 * DAY, 'anchor advanced to now, no backlog');
});

test('population growth is resolution-independent below the cap', () => {
	// Far-off cap so nothing clamps: how often you look cannot change who is born. Clean
	// half-hour steps at 1/hr keep every value exact, so this tests the model, not float drift.
	const capacity = 1000;
	const rate = 1;
	const span = 10.5 * HOUR;
	const away = grow(0, capacity, rate, span).born;
	assert.equal(away, 10);

	let pop = 0;
	let carry = 0; // the time the anchor was left short of, re-counted next read
	for (let i = 0; i < 21; i++) {
		const elapsed = HOUR / 2 + carry;
		const step = grow(pop, capacity, rate, elapsed);
		pop += step.born;
		carry = elapsed - step.consumedSeconds;
	}
	assert.equal(pop, away, 'same total whether watched once or twenty-one times');
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
