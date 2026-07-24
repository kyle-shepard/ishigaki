import { sql } from 'drizzle-orm';
import type { OperationType as WireOperationType } from '$lib/features/world/world';
import {
	type AnyPgColumn,
	boolean,
	check,
	doublePrecision,
	foreignKey,
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
export const buildingType = pgTable('building_type', {
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
	// A realm-wide build prerequisite: this type can't be placed until the player owns one of
	// the referenced type *anywhere* (a Stone wall needs a Quarry standing). Distinct from the
	// tile-local gate on resource.requiresBuildingTypeId (a Quarry on *this* outcrop before
	// Stone) — different scope, so its own column. Nullable self-FK; null means no prerequisite.
	requiresBuildingTypeId: integer('requires_building_type_id').references(
		(): AnyPgColumn => buildingType.id
	)
});

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
			.references(() => buildingType.id)
	},
	// ponytail: scoped by player_id so each visitor gets an isolated sandbox on the shared
	// map — see VISION #4's interim override. This REVERSES the original rule (a tile is a
	// physical place; whoever builds there first holds it), which is still the intended end
	// state. Drop player_id from this index and from the occupancy checks in world.server.ts
	// to restore it, once players are meant to see each other.
	(t) => [uniqueIndex('building_tile_idx').on(t.playerId, t.x, t.y)]
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

// Where a player's stock lives. One per player for now — the uniqueness is not decoration:
// the read-modify-write lock is `WHERE player_id = $1 FOR UPDATE`, and a second row would
// split the stock in two and lock only whichever came back first.
export const settlement = pgTable('settlement', {
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
	populationAccrued: real('population_accrued').notNull().default(0)
});

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
		skillCurve: real('skill_curve').notNull().default(0)
	},
	(t) => [check('game_config_singleton', sql`${t.id} = 1`)]
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
	regrowSeconds: integer('regrow_seconds')
});

// Natural key, unlike `building`'s serial + unique index. The rule: surrogate key for rows
// that get created and destroyed and referenced by id; natural key for a fixed exhaustive
// set. There are exactly GRID_SIZE² tiles forever, (x, y) *is* the identity, and nothing
// references a tile — a serial would be a second identity with no reader. The composite PK
// is also exactly the index the buildable lookup wants, so it costs one index fewer.
export const tile = pgTable(
	'tile',
	{
		x: integer('x').notNull(),
		y: integer('y').notNull(),
		terrainTypeId: integer('terrain_type_id')
			.notNull()
			.references(() => terrainType.id),
		// Capacity — how much this deposit holds when full. Global, seeded, and never written
		// at runtime; the live amount is per-player and lives in `tile_stock`. Null where the
		// deposit is infinite or the ground yields nothing at all.
		quantity: integer('quantity')
	},
	(t) => [primaryKey({ columns: [t.x, t.y] })]
);

// How much of a finite deposit *this player* has left. Per-player and not a column on `tile`
// for the same reason `building` is player-scoped: the grid is shared but the sandboxes are
// not (VISION #4 interim override), and one player's clear-cut must not thin another's
// forest. Scarcity here is against the map, not against a neighbour.
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
		// Free, since tile's primary key is already (x, y) — and without it a typo'd coordinate
		// would quietly create stock on a tile that does not exist.
		foreignKey({ columns: [t.x, t.y], foreignColumns: [tile.x, tile.y] }),
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
export type OperationStatus = 'in-progress' | 'completed';

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
		startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
		// Null means "never finishes on its own" — a gather runs until it is recalled.
		completeAt: timestamp('complete_at', { withTimezone: true }),
		// How much of a gather has already been paid into stock. Starts at travel_done_at, so
		// `now - accrued_at` is the *worked* interval and travel needs no special case: distance
		// costs a trip, not a yield.
		accruedAt: timestamp('accrued_at', { withTimezone: true })
	},
	(t) => [
		// The two columns above went nullable so a gather row could exist, but the build path
		// still dereferences both. Without these, a malformed build row would fail deep inside a
		// transaction on somebody's read — the least debuggable place in this codebase.
		check(
			'operation_build_is_complete',
			sql`${t.type} <> 'build' OR (${t.buildingTypeId} IS NOT NULL AND ${t.completeAt} IS NOT NULL)`
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
		/** When this body reaches the site. Its travel leg is (origin_x, origin_y) → the op's dest. */
		arrivesAt: timestamp('arrives_at', { withTimezone: true }).notNull(),
		originX: integer('origin_x').notNull(),
		originY: integer('origin_y').notNull()
	},
	(t) => [
		primaryKey({ columns: [t.operationId, t.characterId] }),
		// The PK leads with operation_id, so without this every DELETE FROM character (starvation,
		// deletePlayer) seq-scans this table to check the FK. Convention, not optimisation.
		index('operation_worker_character_idx').on(t.characterId),
		check('operation_worker_quality_positive', sql`${t.qualityMultiplier} > 0`)
	]
);
