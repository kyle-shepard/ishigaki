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

// Downsampled for the terminal once the map genuinely stopped fitting one screen — printing the
// world at native resolution was fine at 256×256 (a scrollback, but a readable one) and stopped
// being fine at 1024×1024, where the grid itself no longer prints as a *shape* anybody's eye can
// take in at once. DISPLAY_MAX is a terminal-sized cap, not a grid one: nearest-neighbour picks one
// tile in every `stride`, which is a fair reading of the *coastline and ranges* — the features this
// script exists to eyeball — even though it necessarily drops individual tiles (a single-tile Stone
// outcrop can fall between samples). The census below is never downsampled — it walks the full
// `rows` data regardless of `stride`, so what gets tuned against is always the real distribution,
// only what gets *drawn* is thinned.
const DISPLAY_MAX = 200;
const stride = Math.max(1, Math.ceil(rows.length / DISPLAY_MAX));
const sampledSize = Math.ceil(rows.length / stride);

// One mark per opening `findStarts` found — base-36 so a two-digit start count still fits one
// character (0-9 then a-z), closest-to-the-map's-centre first, so the numbering itself shows the
// search order. Only the hamlet tile is marked, not its whole block (house2/barn/market): with
// potentially dozens of openings on a big map, marking every tile of every start would bury the
// terrain the census is about under its own overlay. Keyed by *sampled* coordinate — the nearest
// pixel this downsampling actually draws — so a start still shows up even when its exact tile isn't
// one of the ones `stride` happens to land on.
const marks = new Map(
	STARTS.map((s, i) => [
		`${Math.round(s.hamletX / stride)},${Math.round(s.hamletY / stride)}`,
		i.toString(36)
	])
);
for (let sy = 0; sy < sampledSize; sy++) {
	const y = Math.min(rows.length - 1, sy * stride);
	let line = '';
	for (let sx = 0; sx < sampledSize; sx++) {
		const x = Math.min(rows.length - 1, sx * stride);
		const c = rows[y][x];
		const mark = marks.get(`${sx},${sy}`);
		line += colour ? `${PAINT[c] ?? ''}${mark ?? c}\x1b[0m` : (mark ?? c);
	}
	console.log(line);
}
if (stride > 1)
	console.log(
		`\n(downsampled ${stride}:1 for the terminal, nearest-neighbour — the census below is exact, over the full ${rows.length}×${rows.length} grid)`
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
