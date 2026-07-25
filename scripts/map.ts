// Run: npm run map — prints the world the seed would write, coloured, with a tile census.
// No database, no arguments. This is how the generator's thresholds get tuned: change them in
// worldgen.ts, run this, look at it.
import { terrainMap } from '../src/lib/features/world/worldgen.ts';

// Rough ANSI stand-ins for each terrain's tile colour, so a lake reads as a lake at a glance.
const PAINT: Record<string, string> = {
	'.': '\x1b[42;30m', // meadow — green
	f: '\x1b[102;30m', // forest — bright green
	w: '\x1b[44;97m', // water — blue
	m: '\x1b[100;97m', // mountain — grey
	s: '\x1b[47;30m', // stone outcrop — white
	c: '\x1b[43;30m', // clay pit — yellow
	i: '\x1b[41;97m' // iron vein — red
};

// Plain when piped or when NO_COLOR is set — 2304 escape sequences are unreadable in a file.
const colour = !!process.stdout.isTTY && !process.env.NO_COLOR;
const rows = terrainMap();
for (const row of rows) {
	console.log(colour ? [...row].map((c) => `${PAINT[c] ?? ''}${c}\x1b[0m`).join('') : row);
}

const total = rows.length * rows.length;
const census = [...rows.join('')].reduce<Record<string, number>>(
	(acc, c) => ({ ...acc, [c]: (acc[c] ?? 0) + 1 }),
	{}
);
console.log(
	`\n${rows.length}×${rows.length} = ${total} tiles · ` +
		Object.entries(census)
			.sort((a, b) => b[1] - a[1])
			.map(([c, n]) => `${c} ${n} (${Math.round((n / total) * 100)}%)`)
			.join(' · ')
);
