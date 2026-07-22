import { sql } from 'drizzle-orm';
import type { OperationType as WireOperationType } from '$lib/features/world/world';
import {
	boolean,
	check,
	doublePrecision,
	foreignKey,
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
	buildSeconds: integer('build_seconds').notNull()
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
	// What must already stand on the tile before this can be taken from it. Null is a gathered
	// resource — wood and forage need a person and nothing else. Set means extracted: the
	// structure comes first. Expressing it as a column makes "stone needs a quarry on the
	// outcrop" one join rather than a rule written in code.
	requiresBuildingTypeId: integer('requires_building_type_id').references(() => buildingType.id)
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
	y: integer('y').notNull()
});

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
export const character = pgTable('character', {
	id: serial('id').primaryKey(),
	playerId: integer('player_id')
		.notNull()
		.references(() => player.id),
	x: integer('x').notNull(),
	y: integer('y').notNull(),
	speed: real('speed').notNull()
});

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
		characterId: integer('character_id')
			.notNull()
			.references(() => character.id),
		// Typed unions, not bare text: a misspelled status would compile fine and strand the
		// character busy forever, with no error to notice. Still `text` in Postgres so a new
		// type costs no migration.
		type: text('type').$type<WireOperationType>().notNull(),
		status: text('status').$type<OperationStatus>().notNull(),
		originX: integer('origin_x').notNull(),
		originY: integer('origin_y').notNull(),
		destX: integer('dest_x').notNull(),
		destY: integer('dest_y').notNull(),
		buildingTypeId: integer('building_type_id').references(() => buildingType.id),
		startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
		travelDoneAt: timestamp('travel_done_at', { withTimezone: true }).notNull(),
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
		check('operation_gather_accrues', sql`${t.type} <> 'gather' OR ${t.accruedAt} IS NOT NULL`)
	]
);
