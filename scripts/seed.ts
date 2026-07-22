// Run: npm run seed   (Node 24 strips TS natively, so this needs no build step.)
// $lib/server/db is unimportable outside Vite ($env alias), so build our own handle —
// same as drizzle.config.ts does.
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
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
	sql`TRUNCATE operation, building, character, building_cost, building_type, stock, settlement, player, tile, terrain_type, resource RESTART IDENTITY CASCADE`
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
		{ displayName: 'Barn', icon: 'house', buildSeconds: 30 }
	])
	.returning();
const bt = Object.fromEntries(buildingTypes.map((t) => [t.displayName, t.id]));

const resources = await db
	.insert(resource)
	.values([
		{ displayName: 'Wood' },
		{ displayName: 'Stone' },
		{ displayName: 'Clay' },
		{ displayName: 'Iron ore' }
	])
	.returning();
const res = Object.fromEntries(resources.map((r) => [r.displayName, r.id]));

// What a build costs. Rows, not constants: retuning this is an UPDATE against a live world,
// no deploy (VISION #10).
await db
	.insert(buildingCost)
	.values([{ buildingTypeId: bt['House'], resourceId: res['Wood'], quantity: 6 }]);

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
		movementCost: 1.0
	},
	{
		char: 'f',
		displayName: 'Forest',
		color: '#5c9448',
		icon: 'forest',
		buildable: true,
		movementCost: 2.0,
		yields: 'Wood'
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
			yieldsResourceId: t.yields ? res[t.yields] : null
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

// How much a fresh deposit holds. Tuning value, one number, no reader yet.
const DEPOSIT_QUANTITY = 1000;

// A typo must fail the seed, not quietly produce a 255-tile world.
if (LAYOUT.length !== 16) throw new Error(`LAYOUT has ${LAYOUT.length} rows, expected 16`);
const tiles = LAYOUT.flatMap((row, y) => {
	if (row.length !== 16) throw new Error(`LAYOUT row ${y} is ${row.length} chars, expected 16`);
	return [...row].map((char, x) => {
		const t = byChar.get(char);
		if (!t) throw new Error(`LAYOUT (${x}, ${y}): unknown terrain char '${char}'`);
		return {
			x,
			y,
			terrainTypeId: t.id,
			// The invariant "yields ⇒ quantity" is held here by construction. A cross-table CHECK
			// can't express it without denormalizing, and this is the only writer.
			quantity: t.yieldsResourceId ? DEPOSIT_QUANTITY : null
		};
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
