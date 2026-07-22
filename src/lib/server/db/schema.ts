import {
	boolean,
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
	displayName: text('display_name').notNull(),
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

// What a tile can produce. A type catalog only — no stock, no inventory; extraction is a
// later epic and is the first thing that will read this.
export const resource = pgTable('resource', {
	id: serial('id').primaryKey(),
	displayName: text('display_name').notNull()
});

// A deposit is a terrain type, not an overlay on one: "iron vein" is a row with a yield,
// meadow is a row without. One table until something needs iron to sit *on* mountain.
// color is presentation data on the type row, same as display_name (VISION #10) — it goes
// straight into the tile's background with no client-side lookup table to keep in sync.
export const terrainType = pgTable('terrain_type', {
	id: serial('id').primaryKey(),
	displayName: text('display_name').notNull(),
	color: text('color').notNull(),
	// Same deal as building_type.icon — the row picks the symbol, Sprites.svelte draws it.
	icon: text('icon').notNull(),
	buildable: boolean('buildable').notNull(),
	movementCost: real('movement_cost').notNull(),
	yieldsResourceId: integer('yields_resource_id').references(() => resource.id)
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
		// ponytail: written by the seed, read by nothing until extraction exists. Carried now
		// because how much a vein holds is a tuning value (VISION #10) and the seed is where
		// tuning values are recorded — not because backfilling would be expensive, since tile
		// is truncate-and-reseeded derived data.
		quantity: integer('quantity')
	},
	(t) => [primaryKey({ columns: [t.x, t.y] })]
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

export type OperationType = 'build';
export type OperationStatus = 'in-progress' | 'completed';

// ponytail: travel is a phase of the build operation rather than its own operation row.
// `type` is carried now despite having one value — it's the discriminator the Movement
// epic adds rows against, and backfilling a nullable column later costs more.
export const operation = pgTable('operation', {
	id: serial('id').primaryKey(),
	playerId: integer('player_id')
		.notNull()
		.references(() => player.id),
	characterId: integer('character_id')
		.notNull()
		.references(() => character.id),
	// Typed unions, not bare text: a misspelled status would compile fine and strand the
	// character busy forever, with no error to notice. Still `text` in Postgres so the
	// Movement epic can add a type without a migration.
	type: text('type').$type<OperationType>().notNull(),
	status: text('status').$type<OperationStatus>().notNull(),
	originX: integer('origin_x').notNull(),
	originY: integer('origin_y').notNull(),
	destX: integer('dest_x').notNull(),
	destY: integer('dest_y').notNull(),
	buildingTypeId: integer('building_type_id')
		.notNull()
		.references(() => buildingType.id),
	startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
	travelDoneAt: timestamp('travel_done_at', { withTimezone: true }).notNull(),
	completeAt: timestamp('complete_at', { withTimezone: true }).notNull()
});
