// Run: npm run map — prints the world the seed would write, coloured, with a tile census.
// No database, no arguments. This is how the generator's thresholds get tuned: change them in
// worldgen.ts, run this, look at it.
import { MAP_SEED, STARTS, terrainMap, WORLD_SEED } from '../src/lib/features/world/worldgen.ts';

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

// Plain when piped or when NO_COLOR is set — 2304 escape sequences are unreadable in a file.
const colour = !!process.stdout.isTTY && !process.env.NO_COLOR;
const rows = terrainMap();
// One mark per opening `findStarts` found — base-36 so a two-digit start count still fits one
// character (0-9 then a-z), closest-to-the-map's-centre first, so the numbering itself shows the
// search order. Only the hamlet tile is marked, not its whole block (house2/barn/market): with
// potentially dozens of openings on a big map, marking every tile of every start would bury the
// terrain the census is about under its own overlay.
const marks = new Map(STARTS.map((s, i) => [`${s.hamletX},${s.hamletY}`, i.toString(36)]));
rows.forEach((row, y) =>
	console.log(
		[...row]
			.map((c, x) => {
				const mark = marks.get(`${x},${y}`);
				return colour ? `${PAINT[c] ?? ''}${mark ?? c}\x1b[0m` : (mark ?? c);
			})
			.join('')
	)
);

const total = rows.length * rows.length;
const census = [...rows.join('')].reduce<Record<string, number>>(
	(acc, c) => ({ ...acc, [c]: (acc[c] ?? 0) + 1 }),
	{}
);
console.log(
	`\nseed ${MAP_SEED} (${MAP_SEED - WORLD_SEED} reroll(s) from ${WORLD_SEED}) · ` +
		`${rows.length}×${rows.length} = ${total} tiles · ${STARTS.length} start(s), closest at ` +
		`${STARTS[0].hamletX}, ${STARTS[0].hamletY} · ` +
		Object.entries(census)
			.sort((a, b) => b[1] - a[1])
			.map(([c, n]) => `${c} ${n} (${Math.round((n / total) * 100)}%)`)
			.join(' · ')
);
