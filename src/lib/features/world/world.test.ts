// Run: npm test  (node --test, no framework added)
import assert from 'node:assert/strict';
import test from 'node:test';
import { positionAt, travelFraction, travelSeconds } from './world.ts';

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
