// Run: npm test  (node --test, no framework added)
//
// The generator is tuned by eye against `npm run map`, and eyes are not in CI. These are the two
// things a threshold edit can quietly break that looking at a map you already believe in will not
// catch: a world that is mostly sea, and a world whose authored middle has slid off its offset.
import assert from 'node:assert/strict';
import test from 'node:test';
import { GRID_SIZE } from './world.ts';
import { START, terrainCharAt, terrainMap } from './worldgen.ts';

const CHARS = new Set(['.', 'f', 'w', 'm', 's', 'c', 'i']);
const map = terrainMap();
const census = (char: string) => [...map.join('')].filter((c) => c === char).length;
const share = (char: string) => census(char) / (GRID_SIZE * GRID_SIZE);

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
});

test('a realm opens on grass, with two clear tiles on every side', () => {
	// The rule the start search exists to hold, asserted from the outside: the three buildings, the
	// settlers' row below them, and a two-tile margin around the lot — all of it meadow. This is the
	// one that catches a retuned threshold or an edited LAYOUT quietly putting the hamlet in a lake,
	// which is exactly what a hand-placed constant did before the search replaced it.
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

test('the authored core sits where the offset says it does', () => {
	// A 16-row LAYOUT centred in 48 starts at 16. Its first row opens with six mountains, and the
	// iron vein on its second row is one tile in — both would move if the offset drifted.
	assert.equal(map[16].slice(16, 22), 'mmmmmm');
	assert.equal(terrainCharAt(18, 17), 'i');
});
