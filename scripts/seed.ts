// Run: npm run seed   (Node 24 strips TS natively, so this needs no build step.)
// $lib/server/db is unimportable outside Vite ($env alias), so build our own handle —
// same as drizzle.config.ts does.
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { eq, inArray, sql } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
	buildingCost,
	buildingType,
	gameConfig,
	player,
	profession,
	professionSkill,
	reachMilestone,
	recipeInput,
	resource,
	skill,
	terrainType,
	tile
} from '../src/lib/server/db/schema.ts';
import { GRID_SIZE, START_REACH_RADIUS } from '../src/lib/features/world/world.ts';
import {
	contentVersion,
	START,
	terrainCharAt,
	WORLD_SEED
} from '../src/lib/features/world/worldgen.ts';

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
		{ displayName: 'School', icon: 'school', buildSeconds: 45, housingCapacity: 0 },
		// The first building that is worth having for what it does to the *ground* rather than for
		// what stands on it. movementCost 0.4 against meadow's 1.0 makes a road two and a half times
		// quicker than open grass and better than six times quicker than forest — enough that routing
		// bends onto it from a couple of tiles away, which is the only way a road can matter when
		// nothing tells a body to prefer one.
		//
		// Cheap and quick on purpose: a road is bought by the dozen, so the per-tile price has to
		// suit a network rather than a landmark. buildSeconds is *ideal* effort — an untrained settler
		// works at 0.15, so 6 here is about 40 seconds of one settler's afternoon per tile, and a
		// ten-tile road is an evening's work rather than a week's. All three numbers are seed tuning
		// (VISION #10).
		{
			displayName: 'Road',
			icon: 'road',
			buildSeconds: 6,
			housingCapacity: 0,
			movementCost: 0.4
		},
		// The first building that *makes* something. Every other type is a place to stand; a Sawmill
		// turns 20 Wood into 10 Planks, which is a good no tile anywhere on the map yields. Its
		// recipe columns are set in a second pass below — `resource` does not exist yet up here.
		{ displayName: 'Sawmill', icon: 'sawmill', buildSeconds: 40, housingCapacity: 0 },
		// The second rung, and the one that makes the middle good load-bearing: a Joinery is priced
		// in **Planks**, so it cannot be reached without running the Sawmill first. That is also what
		// forces the winnability walker below to traverse a recipe rather than only costs.
		{ displayName: 'Joinery', icon: 'joinery', buildSeconds: 60, housingCapacity: 0 },
		// The payoff. Houses 10 against a House's 4 — and it is priced in Planks and Furniture, so no
		// amount of raw wood could ever have bought it. This is where the chain lands in the one
		// number a player already watches.
		{ displayName: 'Longhouse', icon: 'longhouse', buildSeconds: 120, housingCapacity: 10 },
		// The reach's anchor. Placed once by ensurePlayer at realm creation (and backfilled onto
		// every existing realm below) — never ordered, so buildSeconds is a number nothing ever
		// reads. player_buildable: false is the whole of "never offer it in the menu"; no cost rows,
		// because nobody ever pays for one. Added last so it stays the highest id, which is what
		// keeps rules-check.ts's "pick the first free-to-build type" still landing on the Barn.
		{
			displayName: 'Marketplace',
			icon: 'market',
			buildSeconds: 0,
			housingCapacity: 0,
			playerBuildable: false
		}
	])
	// Keyed on the name, so re-running against a live world retunes the row a player's
	// buildings already point at rather than making a second one beside it.
	.onConflictDoUpdate({
		target: buildingType.displayName,
		set: {
			icon: sql`excluded.icon`,
			buildSeconds: sql`excluded.build_seconds`,
			housingCapacity: sql`excluded.housing_capacity`,
			movementCost: sql`excluded.movement_cost`,
			playerBuildable: sql`excluded.player_buildable`
		}
	})
	.returning();
const bt = Object.fromEntries(buildingTypes.map((t) => [t.displayName, t.id]));

// The content version: same WORLD_SEED, same GRID_SIZE, same generator source ⇒ the same string,
// forever (contentVersion's own comment has the full argument). Reading worldgen.ts's own text
// here, rather than importing some pre-computed constant from it, is what makes a threshold tweak
// inside that file roll the version without anybody having to remember to bump one by hand.
// `vercel-build` runs this seed on every deploy, so the version must NOT move with *when* it ran —
// a timestamp would invalidate world.server.ts's in-process memo and every client's cached statics
// on a deploy that changed nothing about the world.
const worldgenPath = fileURLToPath(
	new URL('../src/lib/features/world/worldgen.ts', import.meta.url)
);
const worldVersion = contentVersion(WORLD_SEED, GRID_SIZE, readFileSync(worldgenPath, 'utf8'));

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
// startX/startY ride the same upsert as the rest of this row: the terrain's own answer
// (worldgen.ts's findStart, via START), written here rather than recomputed at every cold
// start — see world.server.ts, which reads these instead of importing worldgen at all.
await db
	.insert(gameConfig)
	.values([
		{
			id: 1,
			growthPerHour: 2,
			foodPerCapitaHour: 0.4,
			starvePerHour: 1,
			settlerBaseline: 0.15,
			skillCurve: 0.3,
			startX: START.hamletX,
			startY: START.hamletY,
			worldVersion
		}
	])
	.onConflictDoUpdate({
		target: gameConfig.id,
		set: {
			growthPerHour: sql`excluded.growth_per_hour`,
			foodPerCapitaHour: sql`excluded.food_per_capita_hour`,
			starvePerHour: sql`excluded.starve_per_hour`,
			settlerBaseline: sql`excluded.settler_baseline`,
			skillCurve: sql`excluded.skill_curve`,
			startX: sql`excluded.start_x`,
			startY: sql`excluded.start_y`,
			worldVersion: sql`excluded.world_version`
		}
	});

// The tuning data behind the reach's growth (decision 8: LoL-style discrete steps, not a tile per
// head). Content, not code (VISION #10): retuning a threshold or its radius is an UPDATE against a
// live world, same shape as building_cost below.
const MILESTONES = [
	{ population: 3, radius: 6 },
	{ population: 8, radius: 9 },
	{ population: 15, radius: 13 },
	{ population: 25, radius: 18 },
	{ population: 40, radius: 24 }
];
// The first rung has to be the same circle `findStart` already searched the generated map for
// (world.ts's START_REACH_RADIUS, consumed there and here) — a mismatch would mean the map's own
// guarantee of reachable wood and stone and the seeded table describing the reach disagree about
// the shape of the opening circle.
if (MILESTONES[0].radius !== START_REACH_RADIUS)
	throw new Error(
		`the first reach milestone is radius ${MILESTONES[0].radius}, but findStart searched the map ` +
			`for a starting reach of ${START_REACH_RADIUS} — the two must agree`
	);
// A fresh realm opens at STARTING_CHARACTERS (world.server.ts) settlers — mirrored here as a plain
// number rather than an import, because world.server.ts pulls in `$lib/server/db` and is
// unimportable outside Vite (see the header comment). An empty or too-high milestone table would
// leave every new realm at reach_radius 0, refusing every build and gather as "outside your reach"
// — a world nobody could play, and one that would fail silently rather than at deploy time. Same
// shape as the "ladder is sealed shut" and missing-School throws elsewhere in this file.
const STARTING_POPULATION = 3;
if (!MILESTONES.some((m) => m.population <= STARTING_POPULATION))
	throw new Error(
		`no reach milestone covers the starting population of ${STARTING_POPULATION} — every fresh ` +
			'realm would open at reach_radius 0 and refuse every build and gather'
	);
await db
	.insert(reachMilestone)
	.values(MILESTONES)
	.onConflictDoUpdate({
		target: reachMilestone.population,
		set: { radius: sql`excluded.radius` }
	});
// A milestone dropped from MILESTONES has to actually stop applying — same argument as
// building_cost and the other tuning tables below: upserts alone would leave the stale rung behind.
await db.execute(
	sql`DELETE FROM reach_milestone WHERE population NOT IN (${sql.join(
		MILESTONES.map((m) => sql`${m.population}`),
		sql`, `
	)})`
);

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
		{ displayName: 'Construction', statA: 'dexterity', statB: 'intelligence' },
		// The first skill that isn't about taking something off the ground. `resource.skill_id` means
		// "which action-skill *produces* this" — gathered or made — so naming Carpentry on Planks is
		// the whole of "a Carpenter finishes a plank batch faster than a settler".
		{ displayName: 'Carpentry', statA: 'dexterity', statB: 'intelligence' }
	])
	.onConflictDoUpdate({
		target: skill.displayName,
		set: { statA: sql`excluded.stat_a`, statB: sql`excluded.stat_b` }
	})
	.returning();
const sk = Object.fromEntries(skills.map((s) => [s.displayName, s.id]));

// The professions and their skill bundles. A Mason carries two skills; everyone else one.
// value ~0.7 is the trained competence (Slice 6 scales output by it against a ~0.15 settler
// baseline — the ~4–5× the Q asks for); Mason's Construction is a touch lower, a jack of two.
//
// Three trades carry Construction, at different competences. That spread is what makes a *mixed*
// crew of specialists mean anything: with only one carrier every other specialist on a build site
// scores the flat settler baseline, so "more specialists → faster and better" would have nothing
// to express itself with.
const professions = await db
	.insert(profession)
	.values([
		{ displayName: 'Forager' },
		{ displayName: 'Woodcutter' },
		{ displayName: 'Mason' },
		{ displayName: 'Carpenter' },
		{ displayName: 'Thatcher' },
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
	// The other two build trades. A Carpenter is the better builder outright; a Thatcher is
	// modest but still well clear of an untrained settler.
	{ profession: 'Carpenter', skill: 'Construction', value: 0.7 },
	// One new skill, not two: both recipes in the chain are Carpentry, so it needs one specialist
	// rather than a second School bottleneck. That makes the Carpenter the strongest profession —
	// a tuning knob (drop either value), not a structural problem.
	{ profession: 'Carpenter', skill: 'Carpentry', value: 0.7 },
	{ profession: 'Thatcher', skill: 'Construction', value: 0.55 },
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
	'Iron ore': 'Mining',
	// Made, not taken. No terrain yields either of these and their rate is 0, so the only way one
	// enters the world is through a recipe — which is the point of the whole epic. Furniture goes
	// one further: its own input is made too, so it exists only at the end of a two-step chain.
	Planks: 'Carpentry',
	Furniture: 'Carpentry'
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
			// `icon` names a symbol in Sprites.svelte — what the resource bar draws instead of the word.
			icon: 'res-food',
			unitsPerHour: 12,
			startingStock: 50,
			isSustenance: true,
			skillId: sk[RESOURCE_SKILL.Food]
		},
		{
			displayName: 'Wood',
			icon: 'res-wood',
			unitsPerHour: 3,
			startingStock: 100,
			skillId: sk[RESOURCE_SKILL.Wood]
		},
		{
			displayName: 'Stone',
			icon: 'res-stone',
			unitsPerHour: 2,
			startingStock: 100,
			skillId: sk[RESOURCE_SKILL.Stone]
		},
		{
			displayName: 'Clay',
			icon: 'res-clay',
			unitsPerHour: 0,
			startingStock: 50,
			skillId: sk[RESOURCE_SKILL.Clay]
		},
		{
			displayName: 'Iron ore',
			icon: 'res-iron',
			unitsPerHour: 0,
			startingStock: 50,
			skillId: sk[RESOURCE_SKILL['Iron ore']]
		},
		// The first made good. Rate 0 and on no terrain's yield list, so unlike Clay and Iron ore
		// this is not "seeded but unwired" — there is genuinely no tile to stand on for it, and a
		// gather order naming one is refused TILE_YIELDS_NOTHING as it should be. Starting stock 0:
		// a runway of something you are meant to make would undercut the first thing you make.
		{
			displayName: 'Planks',
			icon: 'res-planks',
			unitsPerHour: 0,
			startingStock: 0,
			skillId: sk[RESOURCE_SKILL.Planks]
		},
		// The far end of the chain: made from a made thing. Nothing gathers it, nothing starts with
		// it, and the only building that wants it is the one the whole epic is aimed at.
		{
			displayName: 'Furniture',
			icon: 'res-furniture',
			unitsPerHour: 0,
			startingStock: 0,
			skillId: sk[RESOURCE_SKILL.Furniture]
		}
	])
	.onConflictDoUpdate({
		target: resource.displayName,
		set: {
			icon: sql`excluded.icon`,
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

// Same idea, one column over: every existing settlement gets the Marketplace it predates.
// `ensurePlayer` places one for every *new* realm; this is what catches every realm made before
// this building type existed. (x, y - 1) is the exact tile worldgen.ts's START.marketX/marketY
// names and findStart's clear margin already guarantees empty — so nothing moves and no realm
// resets, which is what makes this backfill an INSERT rather than the wipe-and-reroll every other
// schema change in this epic needed. ON CONFLICT on the tile itself (building_tile_idx) rather than
// a check-then-insert: idempotent the same way the stock backfill above is, and harmless to re-run.
await db.execute(
	sql`INSERT INTO building (player_id, x, y, building_type_id)
	    SELECT s.player_id, s.x, s.y - 1, ${bt['Marketplace']}
	    FROM settlement s
	    ON CONFLICT (player_id, x, y) DO NOTHING`
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
	{ building: 'School', resource: 'Wood', quantity: 15 },
	// Per *tile*, and a network is dozens of them: 2 Wood is a road you lay as you go rather than
	// save up for. Wood rather than Stone deliberately — Stone is gated behind a Quarry, and roads
	// should be something a hamlet can do on its first afternoon.
	{ building: 'Road', resource: 'Wood', quantity: 2 },
	// Priced in Wood alone, like the Quarry: it is the rung that unlocks Planks, so charging planks
	// for it would seal the ladder shut before anybody could climb it.
	{ building: 'Sawmill', resource: 'Wood', quantity: 20 },
	// The Joinery *is* priced in Planks, deliberately — the middle good is load-bearing before it is
	// decorative, and this is the cost the winnability walker has to traverse a recipe to satisfy.
	{ building: 'Joinery', resource: 'Wood', quantity: 15 },
	{ building: 'Joinery', resource: 'Planks', quantity: 10 },
	// And the Longhouse is priced in both made goods. No amount of raw wood buys one.
	{ building: 'Longhouse', resource: 'Planks', quantity: 20 },
	{ building: 'Longhouse', resource: 'Furniture', quantity: 6 },
	{ building: 'Longhouse', resource: 'Wood', quantity: 10 }
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

// The recipes. One per building type — a type carrying these *is* a workshop, which is the whole of
// "a Sawmill makes planks; that is what a Sawmill is". All content (VISION #10): retuning a batch
// size, a duration or an input list is an UPDATE against a live world.
//
// craftSeconds is *ideal* effort, the same units as buildSeconds — a settler at 0.15 spends about
// three and a half minutes on a plank batch, a good Carpenter well under one.
const RECIPES = [
	{
		building: 'Sawmill',
		produces: 'Planks',
		outputQuantity: 10,
		craftSeconds: 30,
		inputs: [{ resource: 'Wood', quantity: 20 }]
	},
	// The second step, and the one that makes Planks a *middle* good rather than an end in itself:
	// its only input is something that had to be made.
	{
		building: 'Joinery',
		produces: 'Furniture',
		outputQuantity: 4,
		craftSeconds: 60,
		inputs: [{ resource: 'Planks', quantity: 12 }]
	}
];
// A second pass, like REQUIRES above: `building_type` is inserted before `resource` exists, so the
// FK cannot be set in the original upsert.
for (const r of RECIPES) {
	await db
		.update(buildingType)
		.set({
			producesResourceId: res[r.produces],
			outputQuantity: r.outputQuantity,
			craftSeconds: r.craftSeconds
		})
		.where(eq(buildingType.displayName, r.building));
}
// And the second pass is checked, because it is an UPDATE … WHERE display_name: a rename or a typo
// matches zero rows and every workshop comes out recipe-less, while the winnability walker below —
// which reads these constants and never the database — still passes happily. Same idiom as the
// capacity/regrow mismatch and the no-outcrop throw further down.
const workshops = await db
	.select({
		displayName: buildingType.displayName,
		producesResourceId: buildingType.producesResourceId
	})
	.from(buildingType)
	.where(
		inArray(
			buildingType.displayName,
			RECIPES.map((r) => r.building)
		)
	);
const recipeless = RECIPES.map((r) => r.building).filter(
	(name) => !workshops.some((w) => w.displayName === name && w.producesResourceId !== null)
);
if (recipeless.length > 0)
	throw new Error(
		`recipe not written for: ${recipeless.join(', ')} — the name in RECIPES matches no ` +
			'building_type row, so these would be workshops that make nothing'
	);

await db
	.insert(recipeInput)
	.values(
		RECIPES.flatMap((r) =>
			r.inputs.map((i) => ({
				buildingTypeId: bt[r.building],
				resourceId: res[i.resource],
				quantity: i.quantity
			}))
		)
	)
	.onConflictDoUpdate({
		target: [recipeInput.buildingTypeId, recipeInput.resourceId],
		set: { quantity: sql`excluded.quantity` }
	});
// An input dropped from RECIPES has to actually stop being charged — same argument as building_cost
// and profession_skill: upserts alone would leave the stale row behind and quietly keep taking it.
await db.execute(
	sql`DELETE FROM recipe_input WHERE (building_type_id, resource_id) NOT IN (${sql.join(
		RECIPES.flatMap((r) => r.inputs.map((i) => sql`(${bt[r.building]}, ${res[i.resource]})`)),
		sql`, `
	)})`
);

// A world starts with nothing, so every building has to be reachable *eventually* — not
// necessarily at once. Walk the ladder: whatever can be gathered bare-handed is reachable,
// anything payable from reachable resources is buildable, and a resource becomes reachable in turn
// by either of the two ways one can be produced — extracted behind a building that is buildable, or
// **made by a recipe whose workshop is buildable and whose every input is already reachable**. A
// building left outside that closure can never be built by anyone, which is a world that quietly
// cannot be won.
//
// The recipe clause is not decoration: the Joinery is priced in Planks, which nothing gathers, so
// without it this throws on a perfectly climbable ladder — and with a *wrong* one it would wave
// through a Longhouse nobody could ever pay for.
//
// Cheap to check, silent to break, and a future cost edit is exactly how it would break.
//
// ponytail: this walks *affordability* only. It ignores build prerequisites (Stone wall → Quarry):
// the one we add is satisfiable, so the ladder stays open, but a future unsatisfiable prereq would
// slip past — teach it to walk prereq chains the day one could. The other blind spot, "the map
// contains no tile to put the extractor on", is checked separately once the tiles exist below.
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
	// The third way in. Unlike `takeable`, a made good has no rate and appears on no tile, so this
	// clause is the only thing that can ever mark one reachable.
	for (const r of RECIPES)
		if (buildable.has(r.building) && r.inputs.every((i) => reachable.has(i.resource)))
			reachable.add(r.produces);
}
// A type nobody may ever order (the Marketplace) is placed once by ensurePlayer and never climbed
// to by a player, so it has no business in a walk asking "could a player reach this" — skip it, or
// it reports as stranded and this throws on a perfectly climbable ladder.
const stranded = buildingTypes.filter((t) => t.playerBuildable && !buildable.has(t.displayName));
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
		char: 'h',
		displayName: 'Hills',
		// Roughly the midpoint of Meadow's green and Mountain's grey below — the row is the missing
		// step between them, so its colour reads as one too.
		color: '#93a15e',
		icon: 'hills',
		buildable: true,
		// Slower than Meadow's 1.0 but nothing like Mountain's 5.0 — a climb, not a wall. No yields:
		// worldgen.ts bands the deposits within the habitable elevation range below this, so Hills
		// carries nothing to gather, same as Mountain.
		movementCost: 1.5
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

// The map itself — one char per tile, from worldgen.ts's generator. This script's job is turning
// those chars into rows, and refusing anything it can't.
const tiles = Array.from({ length: GRID_SIZE * GRID_SIZE }, (_, i) => {
	const x = i % GRID_SIZE;
	const y = Math.floor(i / GRID_SIZE);
	const char = terrainCharAt(x, y);
	const t = byChar.get(char);
	if (!t) throw new Error(`(${x}, ${y}): unknown terrain char '${char}'`);
	const spec = TERRAIN.find((s) => s.char === char)!;
	// The invariant is "finite ⇔ regrow_seconds is set ⇔ quantity is set". A cross-table
	// CHECK can't express it without denormalizing, and this is the only writer, so it is
	// held here by construction — a terrain with one and not the other cannot be written.
	if ((spec.capacity === undefined) !== (spec.regrowSeconds === undefined))
		throw new Error(`${spec.displayName}: capacity and regrowSeconds must be set together`);
	return { x, y, terrainTypeId: t.id, quantity: spec.capacity ?? null };
});

// Every new player's hamlet and characters land on these tiles, so this is the one check that
// ties the generated map to the start it hands out: a retuned threshold, a one-character typo,
// or a START edit that walks off the clear block all land here rather than putting somebody in a
// lake. It reads the real terrain row, so it also catches '.' being retuned to something that
// isn't Meadow.
const meadowAt = (x: number, y: number) => {
	const at = tiles[y * GRID_SIZE + x];
	const name = terrainRows.find((t) => t.id === at.terrainTypeId)!.displayName;
	if (name !== 'Meadow') throw new Error(`start tile (${x}, ${y}) is ${name}, must be Meadow`);
};
meadowAt(START.hamletX, START.hamletY);
meadowAt(START.house2X, START.house2Y);
meadowAt(START.barnX, START.barnY);
meadowAt(START.marketX, START.marketY);
meadowAt(START.characterX, START.characterY);
// The three starting characters stand shoulder to shoulder from characterX - 1 (see
// STARTING_CHARACTERS in world.server.ts), so their tiles have to be open ground too.
meadowAt(START.characterX - 1, START.characterY);
meadowAt(START.characterX + 1, START.characterY);

// An extracted resource needs somewhere to extract it from: a Quarry is placeable *only* on a
// Stone outcrop, so a map with no outcrop strands Stone and seals the ladder the winnability
// check above believes it proved open. That was a blind spot worth writing down while the map was
// hand-authored; now that most of it is generated, a threshold edit in worldgen.ts could close
// the last outcrop without anyone touching a layout, so it is checked rather than noted.
// Keyed on REQUIRES rather than on the `resources` rows: those were read back before the
// requires_building_type_id UPDATE below ran, so on a fresh database they all still say null.
const yieldingTerrain = new Set(
	tiles.map((t) => terrainRows.find((r) => r.id === t.terrainTypeId)!.yieldsResourceId)
);
for (const name of Object.keys(REQUIRES)) {
	if (yieldingTerrain.has(res[name])) continue;
	throw new Error(`no tile on the map yields ${name}, which is extracted — the ladder is sealed`);
}

// Upserted, never truncated: `tile_stock` has a foreign key into this table, so deleting and
// reinserting the grid would take every player's harvested-forest record with it.
//
// Chunked, because one statement for the whole grid stopped fitting: `tile` has 4 columns
// (x, y, terrainTypeId, quantity), so one INSERT for all of them at 128×128 binds
// 16,384 × 4 = 65,536 parameters against Postgres's limit of 65,535 — over by exactly one row's
// worth. 4,000 rows a batch keeps every batch to 16,000 params, comfortably clear, and the last
// batch is just whatever remains.
function* chunks<T>(items: T[], size: number): Generator<T[]> {
	for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}
for (const batch of chunks(tiles, 4000)) {
	await db
		.insert(tile)
		.values(batch)
		.onConflictDoUpdate({
			target: [tile.x, tile.y],
			set: { terrainTypeId: sql`excluded.terrain_type_id`, quantity: sql`excluded.quantity` }
		});
}

console.log(
	(WIPE ? `WIPED ${players} player realm(s), then ` : 'content only, no realms touched: ') +
		`${buildingTypes.length} building types, ${resources.length} resources, ` +
		`${terrainRows.length} terrain types, ${tiles.length} tiles · world_version ${worldVersion}` +
		(WIPE ? '' : ` · ${players} existing realm(s) left alone`)
);
await client.end();
