// Run: npm test  (node --test, no framework added)
import assert from 'node:assert/strict';
import test from 'node:test';
import { accrue, positionAt, travelFraction, travelSeconds } from './world.ts';

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

// Accrual. This is the one mechanic that cannot be verified by watching it — the numbers it
// gets wrong are the ones that only show up after a week away — so the arithmetic is pinned
// here rather than in the browser.

test('a worker takes their rate, prorated by the hour', () => {
	assert.equal(accrue(3, 3600), 3);
	assert.equal(accrue(3, 1200), 1);
	assert.equal(accrue(12, 300), 1);
});

test('nothing has been earned before any time passes', () => {
	assert.equal(accrue(3, 0), 0);
});

test('time that has not happened yet pays nothing, rather than owing', () => {
	// `accrued_at` starts when the worker *arrives*, so every read during the walk asks about
	// a negative interval. Answering with a negative number would drain stock on a refresh.
	assert.equal(accrue(3, -600), 0);
});

test('a rate of zero is a tile that is on the map but not yet wired', () => {
	assert.equal(accrue(0, 86_400), 0);
});

test('a week away equals a hundred visits — the property a tick would break', () => {
	const week = 7 * 24 * 3600;
	const away = accrue(3, week);

	let watched = 0;
	for (let i = 0; i < 100; i++) watched += accrue(3, week / 100);

	// The model is resolution-independent — the integral is linear, so how often you look
	// cannot change the total. What separates these two numbers is only the drift of adding
	// a double a hundred times, and at 504 units it is a part in 10^15.
	//
	// The tolerance is the point of the test, not a concession: stock is stored fractional
	// precisely so that this stays drift and never becomes truncation. If a future change
	// rounds on each read, this gap goes to ~50 units and the assertion fails loudly.
	assert.ok(Math.abs(watched - away) < 1e-9, `drifted by ${Math.abs(watched - away)}`);
});
