// Run: npm run seed   (Node 24 strips TS natively, so this needs no build step.)
// $lib/server/db is unimportable outside Vite ($env alias), so build our own handle —
// same as drizzle.config.ts does.
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { eq, sql } from 'drizzle-orm';
import {
	buildingCost,
	buildingType,
	player,
	resource,
	terrainType,
	tile
} from '../src/lib/server/db/schema.ts';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
const client = postgres(process.env.DATABASE_URL);
const db = drizzle(client);

// This script is the only thing in the codebase that destroys realms: `vercel-build` runs
// migrations and nothing else, so deploying never touches a player. Wiping a database that
// has players in it is therefore a deliberate act and has to be spelled as one — everyone
// who had a world loses it, and is told so on their next visit (see ensurePlayer).
const [{ players }] = await db.select({ players: sql<number>`count(*)::int` }).from(player);
if (players > 0 && !process.argv.includes('--wipe')) {
	throw new Error(
		`${players} player realm(s) exist and seeding destroys every one of them. ` +
			'Re-run as `npm run seed -- --wipe` if that is what you mean.'
	);
}

// ponytail: truncate-and-reseed, not idempotent upserts — no data worth keeping yet.
await db.execute(
	sql`TRUNCATE operation, building, character, building_cost, building_type, stock, tile_stock, settlement, player, tile, terrain_type, resource RESTART IDENTITY CASCADE`
);

// Only the global catalog is seeded now. Players, hamlets, and characters are created on
// demand by ensurePlayer() when a visitor first hits the API — seeding one here would just
// make an orphan world nobody holds the cookie for.
const buildingTypes = await db
	.insert(buildingType)
	.values([
		{ displayName: 'House', icon: 'house', buildSeconds: 20 },
		// Where stock is kept. Inert this epic — nothing reads it — but it makes "where your
		// things are" a place on the map, and it is the row storage capacity will hang off.
		{ displayName: 'Barn', icon: 'barn', buildSeconds: 30 },
		// The gate. Stone cannot be taken from an outcrop until one of these stands on it.
		{ displayName: 'Quarry', icon: 'quarry', buildSeconds: 60 },
		// The milestone, and the thing the project is named for: 石垣, fitted stone. It is the
		// first build that needs a resource you cannot simply walk out and pick up.
		{ displayName: 'Stone wall', icon: 'wall', buildSeconds: 90 }
	])
	.returning();
const bt = Object.fromEntries(buildingTypes.map((t) => [t.displayName, t.id]));

// units_per_hour is per worker, flat. Food is fast because forage is the bootstrap floor —
// it is what a realm with nothing can always do. Zero means seeded on the map but not yet
// wired: assignment refuses those tiles outright rather than paying nothing in silence.
const resources = await db
	.insert(resource)
	.values([
		{ displayName: 'Food', unitsPerHour: 12 },
		{ displayName: 'Wood', unitsPerHour: 3 },
		{ displayName: 'Stone', unitsPerHour: 2 },
		{ displayName: 'Clay', unitsPerHour: 0 },
		{ displayName: 'Iron ore', unitsPerHour: 0 }
	])
	.returning();
const res = Object.fromEntries(resources.map((r) => [r.displayName, r.id]));

// What a build costs. Rows, not constants: retuning this is an UPDATE against a live world,
// no deploy (VISION #10).
const COSTS = [
	{ building: 'House', resource: 'Wood', quantity: 6 },
	// The quarry is priced in wood alone on purpose: it is the rung that unlocks stone, so
	// paying for it in stone would seal the ladder shut.
	{ building: 'Quarry', resource: 'Wood', quantity: 12 },
	{ building: 'Stone wall', resource: 'Stone', quantity: 8 },
	{ building: 'Stone wall', resource: 'Wood', quantity: 4 }
];
await db.insert(buildingCost).values(
	COSTS.map((c) => ({
		buildingTypeId: bt[c.building],
		resourceId: res[c.resource],
		quantity: c.quantity
	}))
);

// Extracted, not gathered: for these the structure comes first. Everything absent from here
// needs a person and nothing else.
const REQUIRES: Record<string, string> = { Stone: 'Quarry' };
for (const [r, b] of Object.entries(REQUIRES)) {
	await db
		.update(resource)
		.set({ requiresBuildingTypeId: bt[b] })
		.where(eq(resource.displayName, r));
}

// A world starts with nothing, so every building has to be reachable *eventually* — not
// necessarily at once. Walk the ladder: whatever can be gathered bare-handed is reachable,
// anything payable from reachable resources is buildable, and any resource whose required
// building is buildable becomes reachable in turn. A building left outside that closure can
// never be built by anyone, which is a world that quietly cannot be won.
//
// Cheap to check, silent to break, and a future cost edit is exactly how it would break.
const takeable = resources.filter((r) => r.unitsPerHour > 0).map((r) => r.displayName);
const reachable = new Set(takeable.filter((r) => !REQUIRES[r]));
const buildable = new Set<string>();
// One pass per building type is enough to reach a fixed point: each pass adds at least one
// rung, or the ladder has stopped and no further pass would change anything.
for (let pass = 0; pass < buildingTypes.length; pass++) {
	for (const t of buildingTypes) {
		const needs = COSTS.filter((c) => c.building === t.displayName);
		if (needs.every((c) => reachable.has(c.resource))) buildable.add(t.displayName);
	}
	for (const r of takeable) if (REQUIRES[r] && buildable.has(REQUIRES[r])) reachable.add(r);
}
const stranded = buildingTypes.filter((t) => !buildable.has(t.displayName));
if (stranded.length > 0)
	throw new Error(
		`unbuildable from a fresh world: ${stranded.map((t) => t.displayName).join(', ')} — ` +
			'the ladder is sealed shut and no player could ever climb it'
	);

// Movement costs are tuning data (VISION #10), not physics: the spread is chosen to be
// perceptible, not realistic. Deposits are buildable=true because a terrain-level false
// would also block the future mine — so yes, a House can squat on an iron vein. That
// friction is what motivates a per-(building_type, terrain_type) matrix later.
// `icon` names a symbol in Sprites.svelte. Colour and icon are read together: the symbols draw
// no background of their own, so a tile's colour is what its art sits on, and the two have to
// contrast. Forest is the cautionary case — dark trees on a dark green tile were invisible,
// which is why its colour is a mid green rather than the obvious forest one.
const TERRAIN = [
	{
		char: '.',
		displayName: 'Meadow',
		color: '#a3c76d',
		icon: 'meadow',
		buildable: true,
		movementCost: 1.0,
		// Forage, not farming. It is the one thing a realm with nothing can always do, which is
		// what makes a zero-stock start playable rather than stuck.
		yields: 'Food'
	},
	{
		char: 'f',
		displayName: 'Forest',
		color: '#5c9448',
		icon: 'forest',
		buildable: true,
		movementCost: 2.0,
		yields: 'Wood',
		// A tile is about 20 m square — it fits a house — so ~400 m², or 0.04 ha. At roughly
		// 600 mature stems per hectare that is ~25 trees, and one tree is one Wood.
		//
		// At 3 Wood an hour a tile is stripped in about eight hours; it comes back in thirty
		// days. That ~90x gap is the whole mechanic: clear-cutting is a mistake you feel for a
		// month, and it is what pushes you outward to new ground.
		capacity: 25,
		regrowSeconds: 30 * 24 * 3600
	},
	{
		char: 'c',
		displayName: 'Clay pit',
		color: '#d08b4f',
		icon: 'clay',
		buildable: true,
		movementCost: 1.5,
		yields: 'Clay'
	},
	{
		char: 's',
		displayName: 'Stone outcrop',
		color: '#b0b3b8',
		icon: 'stone',
		buildable: true,
		movementCost: 2.5,
		yields: 'Stone'
	},
	{
		char: 'i',
		displayName: 'Iron vein',
		color: '#7a3b2e',
		icon: 'iron',
		buildable: true,
		movementCost: 2.5,
		yields: 'Iron ore'
	},
	{
		char: 'm',
		displayName: 'Mountain',
		color: '#6b6259',
		icon: 'mountain',
		buildable: false,
		movementCost: 5.0
	},
	{
		char: 'w',
		displayName: 'Water',
		color: '#2f6fb5',
		icon: 'water',
		buildable: false,
		movementCost: 8.0
	}
];

const terrainRows = await db
	.insert(terrainType)
	.values(
		TERRAIN.map((t) => ({
			displayName: t.displayName,
			color: t.color,
			icon: t.icon,
			buildable: t.buildable,
			movementCost: t.movementCost,
			yieldsResourceId: t.yields ? res[t.yields] : null,
			regrowSeconds: t.regrowSeconds ?? null
		}))
	)
	.returning();
const byChar = new Map(TERRAIN.map((t, i) => [t.char, terrainRows[i]]));

// Hand-authored, one char per terrain — diffable in a PR and editable in place. A 16-line
// string block is easy enough to iterate on that a generator would be inventing a problem;
// real world generation belongs to the world-gen epic, at a size where this actually fails.
//
// Load-bearing: from the character's start tile (7,9) this gives two equal-distance (7 tile)
// orders to buildable destinations — (14,9) across open meadow, and (7,2) through five tiles
// of lake. That pair is what demonstrates terrain slowing travel. Editing the lake or the
// row-9 corridor invalidates it.
const LAYOUT = [
	'mmmmmm....fff..m',
	'mmimm....ffff..m',
	'mmmm.....fff....',
	'.mm..www...f..s.',
	'....wwwww.......',
	'...wwwwwww..c...',
	'...wwwwww.......',
	'....wwww........',
	'................',
	'................',
	'..ff............',
	'.ffff..........s',
	'.fffff..........',
	'..fff..........m',
	'c..f........mmm.',
	'..........immmmm'
];

// A typo must fail the seed, not quietly produce a 255-tile world.
if (LAYOUT.length !== 16) throw new Error(`LAYOUT has ${LAYOUT.length} rows, expected 16`);
const tiles = LAYOUT.flatMap((row, y) => {
	if (row.length !== 16) throw new Error(`LAYOUT row ${y} is ${row.length} chars, expected 16`);
	return [...row].map((char, x) => {
		const t = byChar.get(char);
		if (!t) throw new Error(`LAYOUT (${x}, ${y}): unknown terrain char '${char}'`);
		const spec = TERRAIN.find((s) => s.char === char)!;
		// The invariant is "finite ⇔ regrow_seconds is set ⇔ quantity is set". A cross-table
		// CHECK can't express it without denormalizing, and this is the only writer, so it is
		// held here by construction — a terrain with one and not the other cannot be written.
		if ((spec.capacity === undefined) !== (spec.regrowSeconds === undefined))
			throw new Error(`${spec.displayName}: capacity and regrowSeconds must be set together`);
		return { x, y, terrainTypeId: t.id, quantity: spec.capacity ?? null };
	});
});

// Every new player's hamlet and character land on these tiles (START in world.server.ts), so
// the layout is authored around them. A one-character typo could put someone in a lake.
const meadowAt = (x: number, y: number) => {
	const name = terrainRows.find((t) => t.id === tiles[y * 16 + x].terrainTypeId)!.displayName;
	if (name !== 'Meadow') throw new Error(`start tile (${x}, ${y}) is ${name}, must be Meadow`);
	return name;
};
meadowAt(7, 8);
meadowAt(8, 8);
meadowAt(7, 9);

await db.insert(tile).values(tiles);

console.log(
	`seeded: ${buildingTypes.length} building types, ${resources.length} resources, ` +
		`${terrainRows.length} terrain types, ${tiles.length} tiles; start tiles (7,8), (8,8) and (7,9) are Meadow. ` +
		`Players self-create on first visit — no player rows.`
);
await client.end();
