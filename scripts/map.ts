// Run: npm run map — prints the world the generator makes, coloured, with a tile census.
// No database, no arguments. This is how the generator's thresholds get tuned: change them in
// worldgen.ts, run this, look at it.
//
//   npm run map              the whole world, downsampled to fit a terminal
//   npm run map -- 3000 2400 a 1:1 window with its top-left at (3000, 2400)
//
// The window form exists because a downsampled continent cannot show you a river. At the sizes this
// world is now built for, one printed character is dozens of tiles wide — fine for judging where
// the coast and the ranges are, useless for judging whether a channel is one tile across or reads
// as a canal. Those are the two questions this script gets asked and they need two different zooms.
import {
	COARSE,
	MAP_SEED,
	starts,
	terrainCensus,
	terrainWindow,
	WORLD_SEED
} from '../src/lib/features/world/worldgen.ts';
import { GRID_SIZE } from '../src/lib/features/world/world.ts';

// Rough ANSI stand-ins for each terrain's tile colour, so a lake reads as a lake at a glance.
const PAINT: Record<string, string> = {
	'.': '\x1b[42;30m', // meadow — green
	f: '\x1b[102;30m', // forest — bright green
	w: '\x1b[44;97m', // water — blue
	h: '\x1b[103;30m', // hills — bright yellow, between meadow green and mountain grey
	m: '\x1b[100;97m', // mountain — grey
	s: '\x1b[47;30m', // stone outcrop — white
	c: '\x1b[43;30m', // clay pit — yellow
	i: '\x1b[41;97m' // iron vein — red
};

// Plain when piped or when NO_COLOR is set — thousands of escape sequences are unreadable in a file.
const colour = !!process.stdout.isTTY && !process.env.NO_COLOR;
const DISPLAY = 200;

const [wx, wy] = process.argv.slice(2).map(Number);
const windowed = Number.isFinite(wx) && Number.isFinite(wy);

// Whole world downsampled, or a 1:1 window — `terrainWindow`'s `stride` is the only difference.
const stride = windowed ? 1 : Math.max(1, Math.ceil(GRID_SIZE / DISPLAY));
const originX = windowed ? wx : 0;
const originY = windowed ? wy : 0;
const size = windowed ? DISPLAY : Math.ceil(GRID_SIZE / stride);
const started = Date.now();
const rows = terrainWindow(originX, originY, size, stride);
const drawnMs = Date.now() - started;

// One mark per opening `starts()` found — base-36 so a two-digit start count still fits one
// character (0-9 then a-z), closest-to-the-map's-centre first, so the numbering itself shows the
// search order. Only the hamlet tile is marked, not its whole block: with dozens of openings,
// marking every tile of every start would bury the terrain under its own overlay. Keyed by the
// nearest character cell this rendering actually draws, so a start still shows up even when its
// exact tile isn't one the stride happens to land on.
// Tolerated rather than fatal: "no legal opening anywhere" is a *tuning* outcome, and the whole
// reason to run this script is to look at the world that caused it. Throwing here printed nothing
// at all, which is the least useful possible response to a map you need to inspect.
let found: ReturnType<typeof starts> = [];
let startsError = '';
try {
	found = starts();
} catch (e) {
	startsError = (e as Error).message;
}
const marks = new Map(
	found.map((s, i) => [
		`${Math.round((s.hamletX - originX) / stride)},${Math.round((s.hamletY - originY) / stride)}`,
		i.toString(36)
	])
);
rows.forEach((row, sy) => {
	let line = '';
	for (let sx = 0; sx < row.length; sx++) {
		const c = row[sx];
		const mark = marks.get(`${sx},${sy}`);
		line += colour ? `${PAINT[c] ?? ''}${mark ?? c}\x1b[0m` : (mark ?? c);
	}
	console.log(line);
});

// The census is sampled, never exhaustive — see `terrainCensus`. Its shares are what thresholds get
// tuned against, so the sampling stride is printed with them rather than left implicit: a share is
// an estimate now, and one that says so.
const CENSUS_STRIDE = 8;
const census = terrainCensus(CENSUS_STRIDE);
const samples = [...census.values()].reduce((a, b) => a + b, 0);
console.log(
	`\n${windowed ? `window ${DISPLAY}x${DISPLAY} at (${originX}, ${originY}), 1:1` : `whole world, downsampled ${stride}:1, nearest-neighbour`} · drawn in ${drawnMs} ms`
);
console.log(
	`seed ${MAP_SEED}${MAP_SEED === WORLD_SEED ? '' : ` (rerolled from ${WORLD_SEED})`} · ` +
		`${GRID_SIZE}x${GRID_SIZE} = ${GRID_SIZE * GRID_SIZE} tiles · coarse ${Math.ceil(GRID_SIZE / COARSE)}^2 · ` +
		(found.length ? `${found.length} start(s), closest at ${found[0].hamletX}, ${found[0].hamletY}` : `NO STARTS — ${startsError}`)
);
console.log(
	`census (1 tile in ${CENSUS_STRIDE * CENSUS_STRIDE}, ${samples} samples): ` +
		[...census.entries()]
			.sort((a, b) => b[1] - a[1])
			.map(([c, n]) => `${c} ${((n / samples) * 100).toFixed(2)}%`)
			.join(' · ')
);
