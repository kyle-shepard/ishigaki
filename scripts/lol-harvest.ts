// Harvest the public Lands of Lords encyclopedia into structured JSON.
//
// Why: LoL is the design north star (CLAUDE.md), and its encyclopedia is the only place its
// mechanics are written down — what a building consumes, what it produces, which unit it trains,
// which skills gate it. Reading four index pages by hand told us the *shape*; this gets the
// actual chain data that Production & recipes (#14) and Tools & quality (#15) have to be
// designed against.
//
// Output is reference material, not content: it is somebody else's game data and it is written
// under `.lol/` (gitignored) rather than into the repo. Nothing here ships.
//
// ponytail: regex over machine-generated HTML, no DOM library. The markup is templated and
// uniform — every page is `div.block` sections with an `h2` and typed `/help/<kind>?type=<slug>`
// links — so a parser is ~40 lines. If the site ever restyles, this breaks loudly (zero sections
// parsed) rather than silently, which is what the --limit smoke run is for.
//
// Usage:
//   node scripts/lol-harvest.ts                 # everything, cached
//   node scripts/lol-harvest.ts --limit 3       # 3 items per section, for eyeballing
//   node scripts/lol-harvest.ts --sections bld  # just buildings

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const HOST = 'https://www.landsoflords.com';
const OUT = '.lol';
const CACHE = join(OUT, 'cache');

// The encyclopedia sections worth having. `act`, `org`, `cult` and `gnd` describe systems that
// are parked (VISION "Parked until the village works") — add them here when they stop being.
const SECTIONS = ['bld', 'res', 'unit', 'skill'] as const;

// Courtesy delay between requests. LoL is a small site with ~800 active players and this walks
// several hundred pages; it costs us minutes and it costs them nothing.
const DELAY_MS = 600;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const args = process.argv.slice(2);
const flag = (name: string) => {
	const i = args.indexOf(`--${name}`);
	return i === -1 ? null : args[i + 1];
};
const limit = Number(flag('limit') ?? 0) || null;
const sections = (flag('sections')?.split(',') ?? SECTIONS) as readonly string[];

/** Fetch with an on-disk cache, so re-running to fix the parser costs the site nothing. */
async function get(url: string, key: string): Promise<string> {
	const file = join(CACHE, `${key}.html`);
	if (existsSync(file)) return readFile(file, 'utf8');
	await sleep(DELAY_MS);
	const res = await fetch(url, {
		// Identify honestly. A scraper that pretends to be Chrome is the kind that gets sites to
		// start blocking scrapers.
		headers: { 'user-agent': 'ishigaki-harvest/1.0 (design research; one request per page)' }
	});
	if (!res.ok) throw new Error(`${res.status} ${url}`);
	const html = await res.text();
	await writeFile(file, html);
	return html;
}

const ENTITIES: Record<string, string> = {
	'&nbsp;': ' ',
	'&thinsp;': ' ',
	'&amp;': '&',
	'&lt;': '<',
	'&gt;': '>',
	'&quot;': '"',
	'&#039;': "'",
	'&times;': '×',
	'&sup2;': '²',
	'&sup3;': '³'
};

/** Tags out, entities decoded, whitespace collapsed. */
function text(html: string): string {
	let s = html.replace(/<[^>]*>/g, ' ');
	for (const [k, v] of Object.entries(ENTITIES)) s = s.split(k).join(v);
	s = s.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
	// Descriptions are authored in BBCode and served raw: `[URL=/help/org?type=abbey]abbey[/URL]`.
	// Keep the label, drop the markup.
	s = s.replace(/\[\/?[a-z]+(?:=[^\]]*)?\]/gi, '');
	return s.replace(/\s+/g, ' ').trim();
}

type Link = { kind: string; slug: string; title: string };

/** Every encyclopedia reference in a chunk — this is where the recipe graph actually lives. */
function links(html: string): Link[] {
	const out = new Map<string, Link>();
	// Both link shapes the site emits: `/help/res?type=barrel` and `/help/res/cabinet`.
	const re =
		/<a[^>]*href="\/help\/(bld|res|unit|skill|org|act|gnd|cult)(?:\?type=|\/)([a-z0-9:_-]+)"[^>]*>([\s\S]*?)<\/a>/gi;
	for (const m of html.matchAll(re)) {
		const [, kind, raw, inner] = m;
		// Category pages (`/help/bld/indus`) and item pages (`indus:oilmill`) share a shape; the
		// slug after the colon is the item.
		const slug = raw.includes(':') ? raw.split(':')[1] : raw;
		// Image-only anchors carry the name in `title=`; text anchors carry it as their content.
		const title = text(inner) || /title="([^"]*)"/.exec(m[0])?.[1] || '';
		if (!title) continue;
		out.set(`${kind}:${slug}`, { kind, slug, title });
	}
	return [...out.values()];
}

type Entry = {
	kind: string;
	slug: string;
	name: string;
	tier: number | null;
	category: string | null;
	description: string;
	conditions: string[];
	sections: { heading: string; text: string; links: Link[] }[];
};

function parse(kind: string, slug: string, html: string): Entry {
	const start = html.indexOf('<div class="column" id="main">');
	const end = html.indexOf('<div id="footer">');
	if (start === -1) throw new Error(`no main column in ${kind}:${slug}`);
	const main = html.slice(start, end === -1 ? undefined : end);

	const name = text(/<h1>([\s\S]*?)<\/h1>/.exec(main)?.[1] ?? '').replace(/\s*\d+$/, '');
	const tierRaw = /<span class="milestone">(\d+)<\/span>/.exec(main)?.[1];
	// The category comes from the breadcrumb table *only*. Scanning the whole column for a
	// category link picks up prose instead — "in contact with Squares west" made an Abbey Church
	// a Square.
	const crumb = /<table class="inlinemenu">([\s\S]*?)<\/table>/.exec(main)?.[1] ?? '';
	const crumbs = [
		...crumb.matchAll(new RegExp(`<a href="/help/${kind}/([a-z]+)">([^<]*)</a>`, 'g'))
	];
	const description = text(/<div class="bb[^"]*">([\s\S]*?)<\/div>/.exec(main)?.[1] ?? '');

	// Unlock rules and prerequisites live in the postit block as a two-column table; the first
	// cell is a tick image, the second is the rule.
	const cond = /<table class="cond">([\s\S]*?)<\/table>/.exec(main)?.[1] ?? '';
	const conditions = [...cond.matchAll(/<td>([\s\S]*?)<\/td>/g)]
		.map((m) => text(m[1]))
		.filter(Boolean);

	// Each `div.block` with an h2 is a named section: Specialisation, Production, Training, …
	const sections: Entry['sections'] = [];
	for (const raw of main.split('<div class="block"').slice(1)) {
		// The split eats the tag name but leaves its tail (` postit">`), which shows up as a
		// leading `>` in every section's text.
		const chunk = raw.replace(/^[^>]*>/, '');
		const heading = text(/<h2>([\s\S]*?)<\/h2>/.exec(chunk)?.[1] ?? '');
		if (!heading) continue;
		// Drop the carousel: it repeats the prose list below it as images, doubling every link's
		// title into the text.
		const body = chunk.replace(/<div class="hscroll">[\s\S]*?<\/div>/g, '');
		sections.push({
			heading,
			text: text(body.replace(/<h2>[\s\S]*?<\/h2>/, '')),
			links: links(body)
		});
	}

	return {
		kind,
		slug,
		name,
		tier: tierRaw ? Number(tierRaw) : null,
		category: crumbs.at(-1)?.[2] ?? null,
		description,
		conditions,
		sections
	};
}

/** Every item slug in a section: the index lists most, category pages catch the rest. */
async function slugsFor(section: string): Promise<string[]> {
	const index = await get(`${HOST}/help/${section}/`, `${section}-index`);
	const found = new Set<string>();
	// Two link shapes, and which one a section uses is not consistent: buildings and resources
	// list items as `?type=slug`, skills list them as `cat:slug` paths. Collect both.
	const collect = (html: string) => {
		for (const m of html.matchAll(new RegExp(`/help/${section}\\?type=([a-z0-9_-]+)`, 'g')))
			found.add(m[1]);
		for (const m of html.matchAll(new RegExp(`/help/${section}/[a-z]+:([a-z0-9_-]+)`, 'g')))
			found.add(m[1]);
	};
	collect(index);

	const categories = new Set(
		[...index.matchAll(new RegExp(`href="/help/${section}/([a-z]+)"`, 'g'))].map((m) => m[1])
	);
	for (const cat of categories)
		collect(await get(`${HOST}/help/${section}/${cat}`, `${section}-cat-${cat}`));

	return [...found].sort();
}

await mkdir(CACHE, { recursive: true });
const all: Entry[] = [];
const failures: string[] = [];

for (const section of sections) {
	let slugs = await slugsFor(section);
	if (limit) slugs = slugs.slice(0, limit);
	console.log(`${section}: ${slugs.length} items`);
	for (const [i, slug] of slugs.entries()) {
		try {
			const html = await get(`${HOST}/help/${section}?type=${slug}`, `${section}-${slug}`);
			all.push(parse(section, slug, html));
		} catch (e) {
			failures.push(`${section}:${slug} — ${(e as Error).message}`);
		}
		if ((i + 1) % 25 === 0) console.log(`  ${i + 1}/${slugs.length}`);
	}
}

await writeFile(join(OUT, 'encyclopedia.json'), JSON.stringify(all, null, '\t'));
console.log(`\n${all.length} entries -> ${join(OUT, 'encyclopedia.json')}`);
// A page that parsed to zero sections is the shape a restyle would take, so say so rather than
// writing a confidently empty file.
const empty = all.filter((e) => e.sections.length === 0);
if (empty.length) console.log(`${empty.length} entries with no sections (e.g. ${empty[0]?.slug})`);
if (failures.length) console.log(`${failures.length} failed:\n  ${failures.join('\n  ')}`);
