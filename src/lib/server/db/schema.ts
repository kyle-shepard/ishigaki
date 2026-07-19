import { pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';

// ponytail: infrastructure-only table so one migration proves the app→Drizzle→Postgres
// path. Game entities (tiles, buildings, characters, operations) arrive in the tracer epic.
export const healthCheck = pgTable('health_check', {
	id: serial('id').primaryKey(),
	note: text('note').notNull().default('ok'),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});
