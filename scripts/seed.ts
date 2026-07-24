// Run: npm run seed   (Node 24 strips TS natively, so this needs no build step.)
// $lib/server/db is unimportable outside Vite ($env alias), so build our own handle —
// same as drizzle.config.ts does.
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { eq, sql } from 'drizzle-orm';
import {
	buildingCost,
	buildingType,
	gameConfig,
	player,
	profession,
	professionSkill,
	resource,
	skill,
	terrainType,
	tile
} from '../src/lib/server/db/schema.ts';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
const client = postgres(process.env.DATABASE_URL);
const db = drizzle(client);

// This script has two jobs, and only one of them is safe to run on a deploy.
//
// **The catalog** — building types, resources, costs, terrain, the tile grid — is content the
// code depends on: `ensurePlayer` throws without a House and a Barn to hand out. It has to
// arrive with the deploy that needs it, so it is written as upserts on each table's natural
// key and is idempotent. `vercel-build` runs exactly this, and running it twice changes
// nothing the second time.
//
// **Destroying realms** is the other job, and it happens only when asked for by name. Everyone
// who had a world loses it and is told so on their next visit (see ensurePlayer), so it is
// spelled as a flag rather than reached by default.
//
// These used to be one truncate-and-reseed, which was fine only while local development and
// production shared a database — content reached production because seeding "dev" *was*
// seeding prod. Splitting the Neon branches was right and severed that path; this is what
// replaces it.
const WIPE = process.argv.includes('--wipe');
const [{ players }] = await db.select({ players: sql<number>`count(*)::int` }).from(player);

if (WIPE) {
	await db.execute(
		sql`TRUNCATE operation, building, character, building_cost, building_type, stock, tile_stock, settlement, player, tile, terrain_type, resource RESTART IDENTITY CASCADE`
	);
}

// Players, hamlets, and characters are never seeded — ensurePlayer() creates them on demand
// when a visitor first hits the API. Seeding one here would make an orphan world nobody holds
// the cookie for.
const buildingTypes = await db
	.insert(buildingType)
	.values([
		// housingCapacity is the room a building adds to the population cap; only the House
		// houses anyone. Tunable (VISION #10) — a bigger dorm is a bigger number here.
		{ displayName: 'House', icon: 'house', buildSeconds: 20, housingCapacity: 4 },
		// Where stock is kept. Inert this epic — nothing reads it — but it makes "where your
		// things are" a place on the map, and it is the row storage capacity will hang off.
		{ displayName: 'Barn', icon: 'barn', buildSeconds: 30, housingCapacity: 0 },
		// The gate. Stone cannot be taken from an outcrop until one of these stands on it.
		{ displayName: 'Quarry', icon: 'quarry', buildSeconds: 60, housingCapacity: 0 },
		// The milestone, and the thing the project is named for: 石垣, fitted stone. It is the
		// first build that needs a resource you cannot simply walk out and pick up.
		{ displayName: 'Stone wall', icon: 'wall', buildSeconds: 90, housingCapacity: 0 },
		// Where a settler is trained into a specialist. Gates training exactly as the Quarry gates
		// Stone — no School, no specialists.
		{ displayName: 'School', icon: 'school', buildSeconds: 45, housingCapacity: 0 }
	])
	// Keyed on the name, so re-running against a live world retunes the row a player's
	// buildings already point at rather than making a second one beside it.
	.onConflictDoUpdate({
		target: buildingType.displayName,
		set: {
			icon: sql`excluded.icon`,
			buildSeconds: sql`excluded.build_seconds`,
			housingCapacity: sql`excluded.housing_capacity`
		}
	})
	.returning();
const bt = Object.fromEntries(buildingTypes.map((t) => [t.displayName, t.id]));

// The one global-scalar row. Upserted on the fixed id=1 so a live edit retunes the world in
// place (VISION #10) rather than appending a second row the singleton CHECK would reject.
// growthPerHour ~2 → a 4-room House fills from 3 settlers in about half an hour, slow enough
// to feel real, fast enough to watch. foodPerCapitaHour 0.4 is set against the *settler* forage
// rate now that quality (Slice 6) applies: an untrained forager only yields ~12×0.15 ≈ 1.8/hr,
// so per-capita must sit below that for a schoolless hamlet to survive on settler labor — a
// trained Forager (~8/hr) then feeds a growing town easily. starvePerHour 1 is gentle — a hungry
// realm sheds a person an hour and the drain eases as it does. All tunable live (VISION #10).
// settlerBaseline 0.15 and skillCurve 0.3 set the quality band: a settler works at 0.15 of the
// reference rate, a matched specialist at ~0.6–0.85 (their ~0.7 bundle swung by rolled stats) —
// the ~4–5× the Q asks for. Both tunable live (VISION #10).
await db
	.insert(gameConfig)
	.values([
		{
			id: 1,
			growthPerHour: 2,
			foodPerCapitaHour: 0.4,
			starvePerHour: 1,
			settlerBaseline: 0.15,
			skillCurve: 0.3
		}
	])
	.onConflictDoUpdate({
		target: gameConfig.id,
		set: {
			growthPerHour: sql`excluded.growth_per_hour`,
			foodPerCapitaHour: sql`excluded.food_per_capita_hour`,
			starvePerHour: sql`excluded.starve_per_hour`,
			settlerBaseline: sql`excluded.settler_baseline`,
			skillCurve: sql`excluded.skill_curve`
		}
	});

// The action-skill catalog — six skills, each governed by two of the four base stats. Content,
// natural-keyed like everything else (VISION #10): a retuned governing stat is a row edit.
// The stat pairs are flavor, not physics — the spread they give two specialists is the point.
const skills = await db
	.insert(skill)
	.values([
		{ displayName: 'Foraging', statA: 'dexterity', statB: 'intelligence' },
		{ displayName: 'Woodcutting', statA: 'strength', statB: 'constitution' },
		{ displayName: 'Quarrying', statA: 'strength', statB: 'constitution' },
		{ displayName: 'Digging', statA: 'strength', statB: 'dexterity' },
		{ displayName: 'Mining', statA: 'strength', statB: 'constitution' },
		{ displayName: 'Construction', statA: 'dexterity', statB: 'intelligence' }
	])
	.onConflictDoUpdate({
		target: skill.displayName,
		set: { statA: sql`excluded.stat_a`, statB: sql`excluded.stat_b` }
	})
	.returning();
const sk = Object.fromEntries(skills.map((s) => [s.displayName, s.id]));

// The five professions and their skill bundles. A Mason carries two skills; everyone else one.
// value ~0.7 is the trained competence (Slice 6 scales output by it against a ~0.15 settler
// baseline — the ~4–5× the Q asks for); Mason's Construction is a touch lower, a jack of two.
const professions = await db
	.insert(profession)
	.values([
		{ displayName: 'Forager' },
		{ displayName: 'Woodcutter' },
		{ displayName: 'Mason' },
		{ displayName: 'Digger' },
		{ displayName: 'Miner' }
	])
	.onConflictDoUpdate({
		target: profession.displayName,
		set: { displayName: sql`excluded.display_name` }
	})
	.returning();
const pr = Object.fromEntries(professions.map((p) => [p.displayName, p.id]));

const BUNDLE = [
	{ profession: 'Forager', skill: 'Foraging', value: 0.7 },
	{ profession: 'Woodcutter', skill: 'Woodcutting', value: 0.7 },
	{ profession: 'Mason', skill: 'Quarrying', value: 0.7 },
	{ profession: 'Mason', skill: 'Construction', value: 0.6 },
	{ profession: 'Digger', skill: 'Digging', value: 0.7 },
	{ profession: 'Miner', skill: 'Mining', value: 0.7 }
];
await db
	.insert(professionSkill)
	.values(
		BUNDLE.map((b) => ({ professionId: pr[b.profession], skillId: sk[b.skill], value: b.value }))
	)
	.onConflictDoUpdate({
		target: [professionSkill.professionId, professionSkill.skillId],
		set: { value: sql`excluded.value` }
	});
// A bundle row dropped from BUNDLE must actually stop applying, same as building_cost — upserts
// alone would leave the stale row behind.
await db.execute(
	sql`DELETE FROM profession_skill WHERE (profession_id, skill_id) NOT IN (${sql.join(
		BUNDLE.map((b) => sql`(${pr[b.profession]}, ${sk[b.skill]})`),
		sql`, `
	)})`
);

// units_per_hour is per worker, flat. Food is fast because forage is the bootstrap floor —
// it is what a realm with nothing can always do. Zero means seeded on the map but not yet
// wired: assignment refuses those tiles outright rather than paying nothing in silence.
// skillId names the action-skill that takes each resource, so assignment (Slice 6) can rank
// workers by it; build always uses Construction, looked up there.
const RESOURCE_SKILL: Record<string, string> = {
	Food: 'Foraging',
	Wood: 'Woodcutting',
	Stone: 'Quarrying',
	Clay: 'Digging',
	'Iron ore': 'Mining'
};
const resources = await db
	.insert(resource)
	.values([
		// startingStock is the fresh-realm runway (VISION #10, tunable): a stocked hamlet so a new
		// realm can build and grow for a good while before it has to work for materials, and a
		// Food buffer to ride out the opening before forage and specialists ramp (People epic,
		// Slice 4). Tune freely — this is a seed edit, not schema.
		{
			displayName: 'Food',
			unitsPerHour: 12,
			startingStock: 50,
			isSustenance: true,
			skillId: sk[RESOURCE_SKILL.Food]
		},
		{ displayName: 'Wood', unitsPerHour: 3, startingStock: 100, skillId: sk[RESOURCE_SKILL.Wood] },
		{
			displayName: 'Stone',
			unitsPerHour: 2,
			startingStock: 100,
			skillId: sk[RESOURCE_SKILL.Stone]
		},
		{ displayName: 'Clay', unitsPerHour: 0, startingStock: 50, skillId: sk[RESOURCE_SKILL.Clay] },
		{
			displayName: 'Iron ore',
			unitsPerHour: 0,
			startingStock: 50,
			skillId: sk[RESOURCE_SKILL['Iron ore']]
		}
	])
	.onConflictDoUpdate({
		target: resource.displayName,
		set: {
			unitsPerHour: sql`excluded.units_per_hour`,
			startingStock: sql`excluded.starting_stock`,
			isSustenance: sql`excluded.is_sustenance`,
			skillId: sql`excluded.skill_id`
		}
	})
	.returning();
const res = Object.fromEntries(resources.map((r) => [r.displayName, r.id]));

// Every settlement holds a row per resource, at zero if nothing else. `ensurePlayer` sets that
// up at creation, which covers new realms and nothing else — so a resource added later would
// leave every existing realm without a row for it. Accrual is an UPDATE, so it would match
// nothing and the harvest would vanish without a word. One backfill, and the invariant that
// "a settlement has a row per resource" holds for content added after the fact too.
await db.execute(
	sql`INSERT INTO stock (settlement_id, resource_id, quantity)
	    SELECT s.id, r.id, 0 FROM settlement s CROSS JOIN resource r
	    ON CONFLICT DO NOTHING`
);

// What a build costs. Rows, not constants: retuning this is an UPDATE against a live world,
// no deploy (VISION #10).
const COSTS = [
	{ building: 'House', resource: 'Wood', quantity: 6 },
	// The quarry is priced in wood alone on purpose: it is the rung that unlocks stone, so
	// paying for it in stone would seal the ladder shut.
	{ building: 'Quarry', resource: 'Wood', quantity: 12 },
	{ building: 'Stone wall', resource: 'Stone', quantity: 8 },
	{ building: 'Stone wall', resource: 'Wood', quantity: 4 },
	// The School is priced in Wood alone — reachable bare-handed from the start, so the path to
	// specialists never strands (the winnability check below proves it).
	{ building: 'School', resource: 'Wood', quantity: 15 }
];
await db
	.insert(buildingCost)
	.values(
		COSTS.map((c) => ({
			buildingTypeId: bt[c.building],
			resourceId: res[c.resource],
			quantity: c.quantity
		}))
	)
	.onConflictDoUpdate({
		target: [buildingCost.buildingTypeId, buildingCost.resourceId],
		set: { quantity: sql`excluded.quantity` }
	});

// A cost dropped from COSTS has to actually stop being charged, or a price could only ever be
// added to. Upserts alone would leave the old row behind and quietly keep taking it. Costs are
// the one catalog table safe to delete from — nothing references a cost row, unlike a building
// type someone has already built.
await db.execute(
	sql`DELETE FROM building_cost WHERE (building_type_id, resource_id) NOT IN (${sql.join(
		COSTS.map((c) => sql`(${bt[c.building]}, ${res[c.resource]})`),
		sql`, `
	)})`
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

// Realm-wide build prerequisites: a type here can't be placed until the player owns one of the
// named type anywhere. A Stone wall needs a Quarry standing first — the first build gated on
// owning *another* building, not just on affording it. Not cleared on re-run (mirrors REQUIRES
// above); the one prereq is stable content.
const BUILDING_REQUIRES: Record<string, string> = { 'Stone wall': 'Quarry' };
for (const [b, req] of Object.entries(BUILDING_REQUIRES)) {
	await db
		.update(buildingType)
		.set({ requiresBuildingTypeId: bt[req] })
		.where(eq(buildingType.displayName, b));
}

// A world starts with nothing, so every building has to be reachable *eventually* — not
// necessarily at once. Walk the ladder: whatever can be gathered bare-handed is reachable,
// anything payable from reachable resources is buildable, and any resource whose required
// building is buildable becomes reachable in turn. A building left outside that closure can
// never be built by anyone, which is a world that quietly cannot be won.
//
// Cheap to check, silent to break, and a future cost edit is exactly how it would break.
//
// ponytail: this walks *affordability* only — two blind spots this epic opened, both currently
// satisfied so neither is modelled. (1) It ignores build prerequisites (Stone wall → Quarry): the
// one we add is satisfiable, so the ladder stays open, but a future unsatisfiable prereq would slip
// past. (2) A Quarry is now placeable *only* on a Stone outcrop, yet nothing here checks the map
// actually contains one (nor a placeable tile for every extractor) — delete every outcrop and Stone
// silently strands while this passes. Guarded by the Slice 1/2 manual checks today; teach it to
// walk prereq chains and require a placeable tile per extractor the day a map/seed edit could seal either.
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
		// A deposit: extracted with a dedicated structure, not built on freely. Its extractor (a
		// future Kiln) doesn't exist yet, so a clay pit currently offers nothing to build.
		isDeposit: true,
		movementCost: 1.5,
		yields: 'Clay'
	},
	{
		char: 's',
		displayName: 'Stone outcrop',
		color: '#b0b3b8',
		icon: 'stone',
		buildable: true,
		// A deposit whose extractor is the Quarry (Stone.requiresBuildingTypeId), so an outcrop's
		// build menu offers a Quarry and nothing else.
		isDeposit: true,
		movementCost: 2.5,
		yields: 'Stone'
	},
	{
		char: 'i',
		displayName: 'Iron vein',
		color: '#7a3b2e',
		icon: 'iron',
		buildable: true,
		// A deposit; its extractor (a future Mine) doesn't exist yet, so nothing is buildable here.
		isDeposit: true,
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
			isDeposit: t.isDeposit ?? false,
			movementCost: t.movementCost,
			yieldsResourceId: t.yields ? res[t.yields] : null,
			regrowSeconds: t.regrowSeconds ?? null
		}))
	)
	.onConflictDoUpdate({
		target: terrainType.displayName,
		set: {
			color: sql`excluded.color`,
			icon: sql`excluded.icon`,
			buildable: sql`excluded.buildable`,
			isDeposit: sql`excluded.is_deposit`,
			movementCost: sql`excluded.movement_cost`,
			yieldsResourceId: sql`excluded.yields_resource_id`,
			regrowSeconds: sql`excluded.regrow_seconds`
		}
	})
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
meadowAt(6, 8);
meadowAt(8, 8);
meadowAt(7, 9);

// Upserted, never truncated: `tile_stock` has a foreign key into this table, so deleting and
// reinserting the grid would take every player's harvested-forest record with it.
await db
	.insert(tile)
	.values(tiles)
	.onConflictDoUpdate({
		target: [tile.x, tile.y],
		set: { terrainTypeId: sql`excluded.terrain_type_id`, quantity: sql`excluded.quantity` }
	});

console.log(
	(WIPE ? `WIPED ${players} player realm(s), then ` : 'content only, no realms touched: ') +
		`${buildingTypes.length} building types, ${resources.length} resources, ` +
		`${terrainRows.length} terrain types, ${tiles.length} tiles` +
		(WIPE ? '' : ` · ${players} existing realm(s) left alone`)
);
await client.end();
