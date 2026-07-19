import { integer, pgTable, real, serial, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

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
export const buildingType = pgTable('building_type', {
	id: serial('id').primaryKey(),
	displayName: text('display_name').notNull(),
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
	(t) => [uniqueIndex('building_player_tile_idx').on(t.playerId, t.x, t.y)]
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
	type: text('type').notNull(),
	status: text('status').notNull(),
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
