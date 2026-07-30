import { sql } from 'drizzle-orm';
// Relative, with the extension, rather than `$lib/...`: this module is loaded by `scripts/` under
// plain Node (the seed and the migration generator), which resolves neither Vite's `$lib` alias nor
// an extensionless path. It got away with the alias for as long as everything it took from here was
// a *type* — type stripping erases those before Node ever sees them — and broke the moment
// `GRID_SIZE` became a value import for the start-position bounds. Same reason worldgen.ts writes
// its own import this way, and the type-only re-export at the bottom of this file can stay as it is.
import { GRID_SIZE, type OperationType as WireOperationType } from '../../features/world/world.ts';
import {
	type AnyPgColumn,
	boolean,
	check,
	doublePrecision,
	index,
	integer,
	pgTable,
	primaryKey,
	real,
	serial,
	text,
	timestamp,
	uniqueIndex
} from 'drizzle-orm/pg-core';

// Infrastructure-only table proving the app→Drizzle→Postgres path. Not a game entity.
export const healthCheck = pgTable('health_check', {
	id: serial('id').primaryKey(),
	note: text('note').notNull().default('ok'),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

export const player = pgTable('player', {
	id: serial('id').primaryKey()
});

// display_name is the future reskin column (VISION #10): swap the string, not the schema.
// icon names a symbol in Sprites.svelte. The *choice* of art is content (a new building type
// is a row, and it has to be able to say how it looks); the art itself is vector paths, so it
// stays in code — a path string in a column would be undiffable and still need a deploy to
// change. An unknown key renders nothing, which is a missing icon, not a broken tile.
export const buildingType = pgTable(
	'building_type',
	{
		id: serial('id').primaryKey(),
		// Unique because it is the natural key: the seed upserts on it so a deploy can carry content
		// forward without destroying realms, and `ensurePlayer` looks the hamlet up by it. Two rows
		// called "House" would make both of those pick one arbitrarily.
		displayName: text('display_name').notNull().unique(),
		icon: text('icon').notNull(),
		buildSeconds: integer('build_seconds').notNull(),
		// How many settlers this building houses. The population cap is the SUM over a player's
		// built buildings, so a House carries a number and everything else is 0 — build a House,
		// room opens, people arrive. A column, not a constant, so "a dorm holds more" is a row
		// edit (VISION #10), and so the cap is one relational SUM rather than a rule in code.
		housingCapacity: integer('housing_capacity').notNull().default(0),
		// What this building does to the ground it stands on: the movement cost a route pays to cross
		// that tile, replacing the terrain's own. Null — every type but a Road — means it changes
		// nothing, and a House is as slow to walk past as the meadow under it.
		//
		// This is the whole of what a road *is*. Routing already prefers cheap tiles, so a tile made
		// cheap is a tile bodies choose to walk on, and no rule anywhere says "follow the road".
		// A column rather than a constant so a paved road, a towpath or a bridge are row edits
		// (VISION #10), and so the number is tunable against travel times in a live world.
		movementCost: real('movement_cost'),
		// Whether a player may ever order this type built. True for everything except the
		// Marketplace, which every realm gets exactly once at creation (ensurePlayer) and can never
		// raise a second of — there is no demolish path, so "offer it in the menu" would just be a
		// button that always refuses. Filtered inside `eligibleTypeIds`, the one function the build
		// gate and the wire allow-list already share, so this is one column and one predicate rather
		// than a second code path next to it.
		playerBuildable: boolean('player_buildable').notNull().default(true),
		// A realm-wide build prerequisite: this type can't be placed until the player owns one of
		// the referenced type *anywhere* (a Stone wall needs a Quarry standing). Distinct from the
		// tile-local gate on resource.requiresBuildingTypeId (a Quarry on *this* outcrop before
		// Stone) — different scope, so its own column. Nullable self-FK; null means no prerequisite.
		requiresBuildingTypeId: integer('requires_building_type_id').references(
			(): AnyPgColumn => buildingType.id
		),
		// The recipe, if this type has one. **A type with these set *is* a workshop** — that is the
		// whole of "one recipe per type", with no flag column and nothing to keep in sync. A Sawmill
		// makes planks; that is what a Sawmill is.
		//
		// The inputs live in `recipe_input`, `building_cost`'s twin, rather than as a signed column on
		// `building_cost` itself: that table's five readers all mean "what this type costs to place",
		// and the first one that forgot a new filter would charge a Longhouse in planks it never took.
		//
		// The skill a batch is worked at is deliberately absent: it is the *output resource's*
		// `skill_id`, which widens that column from "what takes this off a tile" to "what produces
		// this". So a Carpenter finishes a plank batch faster than a settler with no rule saying so.
		//
		// Nullable and all-or-none (the shape `character_tier` uses), so a half-written recipe cannot
		// exist — a workshop that produces nothing, or produces it in no time, would be a batch that
		// pays out zero or completes instantly.
		producesResourceId: integer('produces_resource_id').references((): AnyPgColumn => resource.id),
		/** How much one batch makes. Fixed per recipe, not player-chosen — a row, retunable. */
		outputQuantity: integer('output_quantity'),
		/** Ideal effort for one batch, same units as build_seconds: a crew divides it by its own pace. */
		craftSeconds: integer('craft_seconds')
	},
	(t) => [
		check(
			'building_type_recipe',
			sql`(${t.producesResourceId} IS NULL AND ${t.outputQuantity} IS NULL AND ${t.craftSeconds} IS NULL)
			 OR (${t.producesResourceId} IS NOT NULL AND ${t.outputQuantity} IS NOT NULL AND ${t.craftSeconds} IS NOT NULL)`
		),
		// Every quantity column in this schema carries its own bound; the all-or-none check above only
		// says the three are set together, and 0 of them is set together perfectly well.
		check(
			'building_type_output_positive',
			sql`${t.outputQuantity} IS NULL OR ${t.outputQuantity} > 0`
		),
		check('building_type_craft_positive', sql`${t.craftSeconds} IS NULL OR ${t.craftSeconds} > 0`)
	]
);

// A row exists only once built — presence *is* built, so there is no status column.
export const building = pgTable(
	'building',
	{
		id: serial('id').primaryKey(),
		playerId: integer('player_id')
			.notNull()
			.references(() => player.id),
		x: integer('x').notNull(),
		y: integer('y').notNull(),
		buildingTypeId: integer('building_type_id')
			.notNull()
			.references(() => buildingType.id),
		// How well this was built, snapshotted from the crew that raised it. **The same scale and
		// the same quantity as operation.quality_multiplier** — the name differs only because
		// "multiplier" describes what it does to an in-flight operation, and a finished building
		// doesn't multiply anything.
		//
		// Nullable with no default, deliberately: the scale runs from a settler's ~0.15 to a
		// master's ~0.8, so DEFAULT 1 would backfill every building that predates this column as
		// off-scale super-quality. Null honestly says "built before quality was recorded".
		//
		// Mechanically inert for now — stored and shown, nothing reads it. Its consumers are decay
		// (better work degrades slower) and crafting (a workshop's quality feeds its output), both
		// their own later epics. Captured now because it cannot be reconstructed afterwards: the
		// operation that knows it is deleted the moment the building exists.
		quality: real('quality'),
		// Which arms a road draws, as a bitmask (N 1, E 2, S 4, W 8) — the player's override of the
		// shape derived from its neighbours. Null, and every building that is not a road, means
		// "work it out from what is next door", which is the ordinary case.
		//
		// Purely how it looks. A road tile is cheap to cross in every direction whatever this says,
		// because routing prices tiles rather than the edges between them — a junction set to N/S
		// still carries a body east. Rendering intersects it with the live neighbours, so an arm can
		// only ever be *hidden*, never invented, and a stored mask that later loses its road heals
		// itself instead of pointing at nothing.
		roadMask: integer('road_mask')
	},
	// VISION #4's reversal: a tile is a physical place again — whoever builds there first holds
	// it, world-wide, not per player. This index used to include player_id (each visitor's own
	// isolated sandbox on the shared map, an interim testing override); dropping it back to just
	// (x, y) is what makes a second player's build on an occupied tile a genuine uniqueness
	// violation rather than a row keyed differently. world.server.ts's occupancy checks in
	// `planBuild` were un-scoped to match — see the comment there for what that means for
	// overlapping reaches.
	(t) => [
		uniqueIndex('building_tile_idx').on(t.x, t.y),
		// Four bits, so a mask outside 0–15 cannot be written. The client only ever sends a subset of
		// a tile's real neighbours, but this is the wire's edge and the wire is not the client's.
		check('building_road_mask_range', sql`${t.roadMask} IS NULL OR ${t.roadMask} BETWEEN 0 AND 15`)
	]
);

// The action-skills a body can have — Foraging, Woodcutting, and so on. Global catalog,
// natural-keyed like resource/building_type. Each skill is governed by exactly two of the four
// base stats (Slice 6 modulates a specialist's competence by their rolled values of these), and
// "exactly two, fixed" is why they are two columns rather than a join table. stat_a/stat_b name
// a character stat column; the CHECK keeps a typo from naming one that does not exist.
export const skill = pgTable(
	'skill',
	{
		id: serial('id').primaryKey(),
		/** Natural key — see building_type.display_name. */
		displayName: text('display_name').notNull().unique(),
		statA: text('stat_a').notNull(),
		statB: text('stat_b').notNull()
	},
	(t) => [
		check(
			'skill_stat_a_valid',
			sql`${t.statA} IN ('strength','dexterity','constitution','intelligence')`
		),
		check(
			'skill_stat_b_valid',
			sql`${t.statB} IN ('strength','dexterity','constitution','intelligence')`
		)
	]
);

// A trained calling — Forager, Woodcutter, Mason. A profession is a bundle of skill values
// (profession_skill below); one row, one display name. New/retuned professions are row edits.
export const profession = pgTable('profession', {
	id: serial('id').primaryKey(),
	/** Natural key — see building_type.display_name. */
	displayName: text('display_name').notNull().unique()
});

// The bundle: how good a profession is at each skill it carries. This is the Q's "data table of
// skill bundles" — a Mason carries both Quarrying and Construction as two rows. `value` is the
// trained competence (Slice 6 scales output by it, modulated by the specialist's rolled stats);
// a profession with no row for a skill is simply untrained at it.
export const professionSkill = pgTable(
	'profession_skill',
	{
		professionId: integer('profession_id')
			.notNull()
			.references(() => profession.id),
		skillId: integer('skill_id')
			.notNull()
			.references(() => skill.id),
		value: real('value').notNull()
	},
	(t) => [primaryKey({ columns: [t.professionId, t.skillId] })]
);

// What a tile can produce.
export const resource = pgTable('resource', {
	id: serial('id').primaryKey(),
	/** Natural key — see building_type.display_name. */
	displayName: text('display_name').notNull().unique(),
	// Names a symbol in Sprites.svelte, same contract as building_type.icon — and the reason the
	// resource bar can be icons rather than words. Keyed on this rather than on display_name
	// because that column is the reskin one (VISION #10): the day 'Food' becomes 'koku' the icons
	// must not all go blank. Defaulted to empty so the column could be added to a live table;
	// an unknown key draws nothing, which is a missing icon rather than a broken bar.
	icon: text('icon').notNull().default(''),
	// How fast one worker takes it, flat — skill-derived rates need skills, and a character
	// carries only `speed` today. The seam is clean either way: the rate is a number.
	// Zero means "seeded on the map but not yet wired"; assignment refuses those outright
	// rather than letting a worker stand in a clay pit earning nothing forever.
	unitsPerHour: real('units_per_hour').notNull().default(0),
	// Whether population eats this. Exactly one resource is the settlement's food, and the drain
	// keys on this flag — never on display_name, which is the reskin column (VISION #10) and
	// would silently stop draining the day 'Food' becomes 'koku'. A boolean, seeded true on the
	// one, so "what people live on" is data, not a hard-coded name in the resolve loop.
	isSustenance: boolean('is_sustenance').notNull().default(false),
	// What a fresh realm starts holding of this resource — a runway so a new hamlet can eat and
	// afford its first House before forage ramps (and, once population drains Food, before it
	// starves). Content, not code (VISION #10): retuning the runway is an UPDATE. Default 0, so
	// a resource that says nothing starts at nothing.
	startingStock: real('starting_stock').notNull().default(0),
	// What must already stand on the tile before this can be taken from it. Null is a gathered
	// resource — wood and forage need a person and nothing else. Set means extracted: the
	// structure comes first. Expressing it as a column makes "stone needs a quarry on the
	// outcrop" one join rather than a rule written in code.
	requiresBuildingTypeId: integer('requires_building_type_id').references(() => buildingType.id),
	// Which action-skill takes this resource — Wood ⇒ Woodcutting, Stone ⇒ Quarrying. Lets
	// assignment (Slice 6) rank workers by the relevant skill, and is the seam by which quality
	// varies by who works. Nullable only because a resource can exist before its skill is wired;
	// the seed sets it for everything takeable.
	skillId: integer('skill_id').references(() => skill.id)
});

// What a building costs to order. Content, not code (VISION #10): retuning a cost is an
// UPDATE, and a new building type brings its own rows. No row for a type means it is free.
export const buildingCost = pgTable(
	'building_cost',
	{
		buildingTypeId: integer('building_type_id')
			.notNull()
			.references(() => buildingType.id),
		resourceId: integer('resource_id')
			.notNull()
			.references(() => resource.id),
		quantity: integer('quantity').notNull()
	},
	(t) => [
		primaryKey({ columns: [t.buildingTypeId, t.resourceId] }),
		// A zero-cost row and a missing row would mean the same thing said two ways; a negative
		// one would pay you to build.
		check('building_cost_positive', sql`${t.quantity} > 0`)
	]
);

// What one batch consumes — `building_cost`'s twin, and deliberately a second table rather than a
// direction column on it (see building_type.produces_resource_id). Same shape, same rules: content,
// not code (VISION #10), no row for a type means that side of the recipe takes nothing.
export const recipeInput = pgTable(
	'recipe_input',
	{
		buildingTypeId: integer('building_type_id')
			.notNull()
			.references(() => buildingType.id),
		resourceId: integer('resource_id')
			.notNull()
			.references(() => resource.id),
		quantity: integer('quantity').notNull()
	},
	(t) => [
		primaryKey({ columns: [t.buildingTypeId, t.resourceId] }),
		check('recipe_input_positive', sql`${t.quantity} > 0`)
	]
);

// Where a player's stock lives. One per player for now — the uniqueness is not decoration:
// the read-modify-write lock is `WHERE player_id = $1 FOR UPDATE`, and a second row would
// split the stock in two and lock only whichever came back first.
export const settlement = pgTable(
	'settlement',
	{
		id: serial('id').primaryKey(),
		playerId: integer('player_id')
			.notNull()
			.unique()
			.references(() => player.id),
		x: integer('x').notNull(),
		y: integer('y').notNull(),
		// The anchor population growth (and, later, food drain) is integrated from on read — the
		// same integrate-on-read trick `tile_stock.as_of` uses for regrowth, one timestamp for the
		// whole settlement. Defaults to now so a fresh realm starts counting from creation; existing
		// realms backfill to deploy time and grow from then, with no retroactive population.
		//
		// Unlike Slice 3, this anchor now advances fully to `now` on every read: food is stored
		// fractional and must drain smoothly with the clock, so the interval can't be held back the
		// way whole-settler growth once was. The sub-person growth/starvation remainder is carried
		// in populationAccrued instead — two concerns, two fields, each integrated cleanly.
		populationAsOf: timestamp('population_as_of', { withTimezone: true }).notNull().defaultNow(),
		// Signed fractional population pressure carried between reads: positive is a birth pending,
		// negative a departure pending. A person is whole but growth and starvation are rates, so the
		// leftover under one person rides here — this is what makes the result independent of how
		// often the world is read (a week away equals a hundred visits).
		populationAccrued: real('population_accrued').notNull().default(0),
		// The realm's build-and-gather radius, in tiles from its Marketplace — the sphere of influence
		// gates both what you may raise and what you may take (world.ts's `withinReach`, `OUTSIDE_REACH`).
		// Ratchets only: `resolveWorld` writes `GREATEST(reach_radius, reachFor(population, ...))`, so a
		// famine that drops population can never shrink it back (decision 9) — the arithmetic that picks
		// the target lives in world.ts's `reachFor`, tested there; this column only ever holds the
		// high-water mark. Defaults to 0 so a settlement predating this column reads as "hasn't earned any
		// reach yet" rather than an arbitrary guess, and the next read ratchets it up to where it belongs.
		reachRadius: integer('reach_radius').notNull().default(0)
	},
	(t) => [
		// Every quantity column in this schema carries its own bound; a radius is no exception.
		check('settlement_reach_radius_non_negative', sql`${t.reachRadius} >= 0`)
	]
);

// The reach radius steps at population milestones — LoL-style discrete jumps (decision 8), not a
// tile per head. Content, not code (VISION #10): retuning a threshold or its radius is an UPDATE
// against a live world, the same shape as building_cost. Natural-keyed on the population threshold
// itself, since two rows can't both want that number to mean a different radius.
export const reachMilestone = pgTable(
	'reach_milestone',
	{
		population: integer('population').primaryKey(),
		radius: integer('radius').notNull()
	},
	(t) => [check('reach_milestone_radius_positive', sql`${t.radius} > 0`)]
);

// Global scalars that shape play but aren't per-anything: growth rate now, food and skill
// tuning as later slices need them. One typed row, not a stringly key/value bag — VISION #10
// wants these as data, but data with columns a query can read, not strings to parse. The CHECK
// pins it to a single row so there is never a second, contradicting truth (same instinct as
// settlement's unique player_id).
export const gameConfig = pgTable(
	'game_config',
	{
		id: integer('id').primaryKey().default(1),
		// Settlers gained per real hour while there is spare housing and food.
		growthPerHour: real('growth_per_hour').notNull(),
		// Food each person eats per real hour. Seeded below one forager's yield so the common
		// "one forager feeds the hamlet" case stays fed (see population()'s ponytail note).
		foodPerCapitaHour: real('food_per_capita_hour').notNull().default(0),
		// People lost per real hour while starving. Gentle by design — the loss eases the drain,
		// so a hungry settlement self-corrects rather than dropping off a cliff.
		starvePerHour: real('starve_per_hour').notNull().default(0),
		// What an untrained settler works at, as a multiplier on a job's flat rate (~0.15). The
		// floor the whole quality curve is measured against.
		settlerBaseline: real('settler_baseline').notNull().default(1),
		// How much a specialist's governing stats swing their output around their trained value.
		skillCurve: real('skill_curve').notNull().default(0),
		// A content fingerprint of the generated world — worldgen.ts's own `contentVersion`: the same
		// WORLD_SEED, the same GRID_SIZE and the same generator source hash to the same string,
		// forever, never a function of *when* the seed happened to run (`vercel-build` runs it on
		// every deploy, and a timestamp version would invalidate every cache on a deploy that changed
		// nothing). world.server.ts's in-process memo of the tile grid and its resource join keys on
		// this one small column instead of re-reading 28,583 rows a request — see readWorld's own
		// note. Nullable: a row seeded before this column existed has none, and world.server.ts
		// throws on that the same way it throws on every other missing-catalog-row case in that
		// file — `run npm run seed`, not a silent guess.
		worldVersion: text('world_version'),
		// A hash of the *generated terrain data itself* — every tile's terrain char, not worldgen.ts's
		// source text (that's world_version's job, above). This is the safety property that makes it
		// safe for the read path to stop selecting the `tile` table and generate the grid instead: if
		// worldgen.ts ever changes and nobody reseeds, the server would otherwise generate a *different*
		// world than the one `tile_stock`, `building` and `settlement` rows refer to, silently. The seed
		// writes this; world.server.ts's `loadStaticWorld` regenerates the grid, hashes it the same way,
		// and throws rather than serving a world it can't prove matches the database. Nullable for the
		// same reason `world_version` is — a row seeded before this column existed has none.
		terrainHash: text('terrain_hash')
	},
	(t) => [check('game_config_singleton', sql`${t.id} = 1`)]
);

// Where a realm can open — one row per legal, mutually well-separated opening `findStarts`
// (worldgen.ts) found on the generated map, seeded once and claimed as realms are created. This
// used to be two columns on `game_config` (`start_x`/`start_y`) naming the single opening every
// realm shared (VISION #4's interim override — every visitor got an isolated sandbox at the same
// coordinates); now that occupancy is world-shared and starts are scattered, a realm needs its
// *own* opening, so the single pair became a table. `x`/`y` name the hamlet tile alone —
// world.server.ts's own `startBlockFrom` derives the rest (the two Houses, the Barn, the
// Marketplace, the settlers' row) from just that, the same way it always has.
export const startPosition = pgTable(
	'start_position',
	{
		id: serial('id').primaryKey(),
		x: integer('x').notNull(),
		y: integer('y').notNull(),
		// Null means unclaimed. `ensurePlayer` claims the first unclaimed row atomically
		// (`UPDATE ... WHERE claimed_by_player_id IS NULL ... LIMIT 1 ... RETURNING`), so two
		// realms created at the same moment can never land on the same opening. `ON DELETE SET
		// NULL` rather than the schema's usual no-cascade: a start slot isn't something a player
		// spent time on, it's infrastructure — when a realm is deleted (`deletePlayer`, the
		// "New game" verb) the opening it held goes back into the pool for the next visitor,
		// which is what keeps a finite map from running out of room for new realms as old ones
		// come and go.
		claimedByPlayerId: integer('claimed_by_player_id').references(() => player.id, {
			onDelete: 'set null'
		})
	},
	(t) => [
		// The natural key: the seed upserts on it, the same idiom as building_type/resource's own
		// display_name, so a reseed against an unchanged map touches no row.
		uniqueIndex('start_position_xy_idx').on(t.x, t.y),
		// Same reasoning and the same `sql.raw` mechanics as every other coordinate bound in this
		// schema (see building_road_mask_range for the general note) — a coordinate's bound is the
		// grid, sourced from the one constant rather than typed twice.
		check('start_position_x_range', sql`${t.x} >= 0 AND ${t.x} < ${sql.raw(String(GRID_SIZE))}`),
		check('start_position_y_range', sql`${t.y} >= 0 AND ${t.y} < ${sql.raw(String(GRID_SIZE))}`)
	]
);

// Held stock, one row per (settlement, resource). No cap this epic — capacity is a later
// lever and the barn is where it will hang off.
export const stock = pgTable(
	'stock',
	{
		settlementId: integer('settlement_id')
			.notNull()
			.references(() => settlement.id),
		resourceId: integer('resource_id')
			.notNull()
			.references(() => resource.id),
		// Not integer: accrual is continuous, and truncating each read would make a player who
		// refreshes often earn strictly less than one who stays away. Floored for display only.
		quantity: doublePrecision('quantity').notNull()
	},
	(t) => [
		primaryKey({ columns: [t.settlementId, t.resourceId] }),
		// "Stock can go negative" is a stated failure condition, and one guarded only by
		// application code is waiting for the one path that forgets. The app check stays too —
		// it is what produces the refusal the player reads.
		check('stock_non_negative', sql`${t.quantity} >= 0`)
	]
);

// A deposit is a terrain type, not an overlay on one: "iron vein" is a row with a yield,
// meadow is a row without. One table until something needs iron to sit *on* mountain.
// color is presentation data on the type row, same as display_name (VISION #10) — it goes
// straight into the tile's background with no client-side lookup table to keep in sync.
export const terrainType = pgTable('terrain_type', {
	id: serial('id').primaryKey(),
	/** Natural key — see building_type.display_name. */
	displayName: text('display_name').notNull().unique(),
	color: text('color').notNull(),
	// Same deal as building_type.icon — the row picks the symbol, Sprites.svelte draws it.
	icon: text('icon').notNull(),
	buildable: boolean('buildable').notNull(),
	// A deposit is ground you extract from with a dedicated structure (a Quarry on an outcrop),
	// not ground you build freely on. It filters the build menu: a deposit offers only its
	// extractor, plain ground offers everything but extractors. Separate from `buildable` because
	// a deposit *is* buildable (its extractor goes on it) — it just doesn't take a House.
	isDeposit: boolean('is_deposit').notNull().default(false),
	movementCost: real('movement_cost').notNull(),
	yieldsResourceId: integer('yields_resource_id').references(() => resource.id),
	// How long an emptied deposit takes to come back to full. Null means it never empties —
	// a quarry does not run out on this timescale, a forest does. One nullable column rather
	// than a flag plus a duration, so "infinite" cannot disagree with "regrows in 0s".
	regrowSeconds: integer('regrow_seconds'),
	// worldgen.ts's single-character terrain code ('.', 'f', 's', …) — what the generator's output
	// maps onto to become a row. world.server.ts's read path no longer selects the `tile` table (see
	// its own note), so this is how it turns a generated char back into a terrain_type id: a catalog
	// lookup instead of a 2M-row join. Nullable, like world_version, for the same reason: a row
	// seeded before this column existed has none, and the read path throws on that rather than
	// guessing (`run npm run seed`).
	char: text('char').unique(),
	// The same fact `tile.quantity` holds per row, lifted onto the type: every tile of one terrain
	// type is seeded with the identical capacity (seed.ts's own invariant), so storing it once here
	// is what lets the read path answer "how much does a Forest tile hold" without reading a single
	// `tile` row. Null where the deposit is infinite or the ground yields nothing — same reading as
	// `tile.quantity`'s own null.
	capacity: integer('capacity')
});

// There used to be a `tile` table here — one row per tile, the whole grid, written by `npm run
// seed` on every deploy. It is gone, and the reasoning is worth keeping.
//
// It stopped being read first: world.server.ts used to `SELECT *` the whole thing (plus its join to
// `terrain_type`/`resource`) on every world read, which is the egress problem CLAUDE.md and
// `loadStaticWorld` describe. The grid is a pure function of `WORLD_SEED` + `GRID_SIZE` +
// worldgen.ts's generator, so the read path generates it instead and trusts the result only once its
// hash matches `game_config.terrain_hash` (see that column's own comment). After that the table had
// exactly one reader left — `tile_stock`'s foreign key — and one writer, the seed, which paid two
// minutes of every deploy to write 2,096,704 rows nothing selected.
//
// That is a cost that scales with world *area*, and the world is headed for a continent (#24): the
// same loop at 6912² is ~47 minutes inside `vercel-build`, which is not a slope, it is a wall. A
// foreign key is not worth a deploy. `tile_stock.(x, y)` is now bare coordinates, bounded by the
// same `OUT_OF_BOUNDS` check every other coordinate on the write path already goes through.

// How much of a finite deposit *this player* has left. Per-player and not a column on a tile row —
// unlike `building`, this stayed player-scoped through VISION #4's reversal: gathering is its own,
// later question ("expansion & borders", parked), and one player's clear-cut still must not thin
// another's forest, or reach overlap would turn every shared forest into a race for the same
// numbers rather than each realm working its own copy of the ground. Scarcity here is against the
// map, not against a neighbour.
//
// Rows are created lazily on first harvest — no row means the tile is untouched and therefore
// full, so 256 rows per player never materialise.
export const tileStock = pgTable(
	'tile_stock',
	{
		playerId: integer('player_id')
			.notNull()
			.references(() => player.id),
		x: integer('x').notNull(),
		y: integer('y').notNull(),
		quantity: doublePrecision('quantity').notNull(),
		/** When `quantity` was last measured. Regrowth is integrated from here. */
		asOf: timestamp('as_of', { withTimezone: true }).notNull()
	},
	(t) => [
		primaryKey({ columns: [t.playerId, t.x, t.y] }),
		// There is no foreign key on (x, y) any more — see the note where `tile` used to be. What it
		// bought was "a typo'd coordinate cannot create stock on a tile that does not exist", and that
		// is now the write path's own `OUT_OF_BOUNDS` check, which every coordinate already passes
		// through before it reaches this table.
		// "A forest tile yields below zero trees" is a stated failure. The upper bound cannot be
		// a CHECK — capacity lives on another table — so the clamp in `accrue` is the only guard
		// there, and its test carries that weight.
		check('tile_stock_non_negative', sql`${t.quantity} >= 0`)
	]
);

// (x, y) is the position when idle; during travel it is derived from the active operation.
//
// The tier lives here, not in a separate table: a settler is a character with no profession, a
// specialist is one with a profession and a rolled stat sheet. Everything below profession_id is
// null for a settler and set for a specialist — the CHECK holds that all-or-nothing invariant at
// the DB (mirroring the operation build/gather CHECKs), so a half-rolled body can't be written.
export const character = pgTable(
	'character',
	{
		id: serial('id').primaryKey(),
		playerId: integer('player_id')
			.notNull()
			.references(() => player.id),
		x: integer('x').notNull(),
		y: integer('y').notNull(),
		speed: real('speed').notNull(),
		// Null ⇒ settler, set ⇒ specialist. The tier is a property of the body, so the whole
		// operation/travel/idle machinery works on both without a fork.
		professionId: integer('profession_id').references(() => profession.id),
		// A specialist you know by name; a settler is one of an anonymous many.
		name: text('name'),
		// Rolled once at training. Slice 6 turns these into the quality a specialist works at.
		strength: integer('strength'),
		dexterity: integer('dexterity'),
		constitution: integer('constitution'),
		intelligence: integer('intelligence')
	},
	(t) => [
		check(
			'character_tier',
			sql`(${t.professionId} IS NULL AND ${t.name} IS NULL AND ${t.strength} IS NULL AND ${t.dexterity} IS NULL AND ${t.constitution} IS NULL AND ${t.intelligence} IS NULL)
			 OR (${t.professionId} IS NOT NULL AND ${t.name} IS NOT NULL AND ${t.strength} IS NOT NULL AND ${t.dexterity} IS NOT NULL AND ${t.constitution} IS NOT NULL AND ${t.intelligence} IS NOT NULL)`
		)
	]
);

// Defined next to the wire types rather than here: the client branches on it too, and two
// copies of a union is one copy waiting to fall behind.
export type { OperationType } from '$lib/features/world/world';
// 'queued' is a build placed when nobody was free: it holds its tile and its paid-for cost, has no
// crew and no schedule, and starts itself the moment a qualifying worker frees.
export type OperationStatus = 'queued' | 'in-progress' | 'completed';

// ponytail: travel is a phase of the operation rather than its own operation row.
//
// A gather is an operation, not a table of its own. Widening beats adding: the travel leg,
// the "who is idle" derivation, and the client's position interpolation all keep working
// because a gather row carries real origin/dest/travel columns. The cost is two columns
// going nullable, and that cost is paid back by the CHECKs below.
export const operation = pgTable(
	'operation',
	{
		id: serial('id').primaryKey(),
		playerId: integer('player_id')
			.notNull()
			.references(() => player.id),
		// Typed unions, not bare text: a misspelled status would compile fine and strand the
		// character busy forever, with no error to notice. Still `text` in Postgres so a new
		// type costs no migration.
		type: text('type').$type<WireOperationType>().notNull(),
		status: text('status').$type<OperationStatus>().notNull(),
		destX: integer('dest_x').notNull(),
		destY: integer('dest_y').notNull(),
		buildingTypeId: integer('building_type_id').references(() => buildingType.id),
		// The profession a training operation is producing. Null on build/gather; a train row
		// carries the calling the settler will emerge with. Edge-triggered like a build, so it
		// also carries a complete_at (see the CHECK).
		professionId: integer('profession_id').references(() => profession.id),
		// The crew's workmanship, snapshotted at assignment — a gather multiplies its rate by it,
		// and a build's completion time is solved from it. Snapshotted (not re-derived on read) so
		// "skills are fixed at training" holds for an in-flight job and the read path stays a plain
		// multiply; the derivation from the live bundle happens once, at assignment. For a
		// one-member crew this is simply that worker's own multiplier. Default 1 (a train row, or
		// the pre-quality flat rate). CHECK > 0 because a zero would zero out a gather.
		qualityMultiplier: real('quality_multiplier').notNull().default(1),
		// Nullable because a queued build genuinely has not started — stamping a fake now() would
		// read as a bug later, and the CHECK below keeps it required everywhere it means something.
		startedAt: timestamp('started_at', { withTimezone: true }),
		// Null means "never finishes on its own" — a gather runs until it is recalled.
		completeAt: timestamp('complete_at', { withTimezone: true }),
		// How much of a gather has already been paid into stock. Starts at travel_done_at, so
		// `now - accrued_at` is the *worked* interval and travel needs no special case: distance
		// costs a trip, not a yield.
		accruedAt: timestamp('accrued_at', { withTimezone: true }),
		// Which professions may work this order. Null means anyone, which is every order that
		// doesn't ask. Settlers are not expressible — a filter is a list of professions and a
		// settler has none — so any filter at all excludes them; holding your good worker back is
		// already a choice you make by not picking them.
		//
		// An array rather than a join table because it is only ever read whole; a join would buy
		// relational querying nobody does. The cost is that **Postgres cannot put a foreign key on
		// an array element**, so this is the one place in the schema where referential integrity is
		// the writer's job — it validates the ids against the profession catalog and refuses
		// UNKNOWN_PROFESSION. Without that a typo'd id matches nobody, which reads as "everyone is
		// busy" and, once a filter can queue, becomes an order waiting forever for a worker who
		// cannot exist.
		allowedProfessionIds: integer('allowed_profession_ids').array(),
		// How many bodies the order asked for. Until a build could queue, the crew was resolved at
		// order time and never needed remembering; a queued one has to carry the number so that
		// auto-start can honour it minutes later. This is its first reader, so this is where it
		// belongs — a maximum, as everywhere else.
		crewSize: integer('crew_size').notNull().default(1)
	},
	(t) => [
		// The two columns above went nullable so a gather row could exist, but the build path
		// still dereferences both. Without these, a malformed build row would fail deep inside a
		// transaction on somebody's read — the least debuggable place in this codebase.
		// A queued build is exempt: it is precisely the row that has a building type but no
		// completion time yet, and this CHECK demanding one unconditionally is why a queued build
		// could not be written before.
		//
		// A craft is held to the same invariant, because it is the same shape: its building type
		// names the *workshop* (which is how completion finds the recipe) and its completion time
		// is when the batch lands.
		check(
			'operation_build_is_complete',
			sql`${t.type} NOT IN ('build', 'craft') OR ${t.status} = 'queued' OR (${t.buildingTypeId} IS NOT NULL AND ${t.completeAt} IS NOT NULL)`
		),
		check(
			'operation_in_progress_has_started',
			sql`${t.status} <> 'in-progress' OR ${t.startedAt} IS NOT NULL`
		),
		check('operation_gather_accrues', sql`${t.type} <> 'gather' OR ${t.accruedAt} IS NOT NULL`),
		check('operation_quality_positive', sql`${t.qualityMultiplier} > 0`),
		// A train row is edge-triggered like a build and names the profession it will grant — both
		// dereferenced on completion, so both are required at the DB rather than by convention.
		check(
			'operation_train_is_complete',
			sql`${t.type} <> 'train' OR (${t.professionId} IS NOT NULL AND ${t.completeAt} IS NOT NULL)`
		)
	]
);

// Who is working an operation. One row per body, and the *only* answer to "who is on this op" —
// `operation.character_id` is gone rather than kept alongside for gather/train, because two
// sources would make every idle/busy derivation a UNION of two truths that can disagree. Gather
// and train simply always have exactly one row.
//
// Travel is per-body: members of a crew leave from their own tiles and arrive at their own times,
// so origin and the arrival clock live here rather than on the operation.
export const operationWorker = pgTable(
	'operation_worker',
	{
		// Cascade because a membership row is genuinely a child of its operation — meaningless
		// without one. The schema's standing "no cascade for rows a player spent real time on" is
		// about buildings and characters; `character_id` below keeps that rule, so a cull has to
		// deal with its crews deliberately.
		operationId: integer('operation_id')
			.notNull()
			.references(() => operation.id, { onDelete: 'cascade' }),
		characterId: integer('character_id')
			.notNull()
			.references(() => character.id),
		/** This body's own workmanship — see operation.quality_multiplier for the combined one. */
		qualityMultiplier: real('quality_multiplier').notNull(),
		/** When this body reaches the site, walking `path`. */
		arrivesAt: timestamp('arrives_at', { withTimezone: true }).notNull(),
		// The route this body walks, as row-major tile indices — origin first, the operation's
		// destination last. Replaced origin_x/origin_y, which described a straight line: travel picks
		// its way around lakes now, so where it *started* no longer says where it goes.
		//
		// Stored rather than re-derived on read, for the same reason quality is snapshotted onto a
		// building: it is the route the arrival time was solved from, and re-routing on every read
		// would let a road built mid-journey silently change a trip already under way. An array
		// because it is only ever read whole — a row per step would buy relational querying nobody
		// does (same argument as operation.allowed_profession_ids).
		path: integer('path').array().notNull()
	},
	(t) => [
		primaryKey({ columns: [t.operationId, t.characterId] }),
		// The PK leads with operation_id, so without this every DELETE FROM character (starvation,
		// deletePlayer) seq-scans this table to check the FK. Convention, not optimisation.
		index('operation_worker_character_idx').on(t.characterId),
		check('operation_worker_quality_positive', sql`${t.qualityMultiplier} > 0`)
	]
);
