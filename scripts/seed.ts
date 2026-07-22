// Run: npm run seed   (Node 24 strips TS natively, so this needs no build step.)
// $lib/server/db is unimportable outside Vite ($env alias), so build our own handle —
// same as drizzle.config.ts does.
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { buildingType } from '../src/lib/server/db/schema.ts';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
const client = postgres(process.env.DATABASE_URL);
const db = drizzle(client);

// ponytail: truncate-and-reseed, not idempotent upserts — no data worth keeping yet.
//
// Note this drops every player, so it invalidates every visitor's cookie: everyone who had
// a world gets a brand-new one on their next request. Harmless while worlds are disposable,
// and the reason ensurePlayer() verifies the cookie's id rather than trusting it.
await db.execute(
	sql`TRUNCATE operation, building, character, building_type, player RESTART IDENTITY CASCADE`
);

// Only the global catalog is seeded now. Players, hamlets, and characters are created on
// demand by ensurePlayer() when a visitor first hits the API — seeding one here would just
// make an orphan world nobody holds the cookie for.
const [house] = await db
	.insert(buildingType)
	.values({ displayName: 'House', buildSeconds: 20 })
	.returning();

console.log(
	`seeded: building type ${house.id} (House). Players self-create on first visit — no player rows.`
);
await client.end();
