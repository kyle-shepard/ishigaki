// Run: npm run seed   (Node 24 strips TS natively, so this needs no build step.)
// $lib/server/db is unimportable outside Vite ($env alias), so build our own handle —
// same as drizzle.config.ts does.
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { building, buildingType, character, player } from '../src/lib/server/db/schema.ts';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
const client = postgres(process.env.DATABASE_URL);
const db = drizzle(client);

// ponytail: truncate-and-reseed, not idempotent upserts — single player, no data worth
// keeping. RESTART IDENTITY keeps the seeded player's id stable at 1 across re-seeds.
await db.execute(
	sql`TRUNCATE operation, building, character, building_type, player RESTART IDENTITY CASCADE`
);

const [p] = await db.insert(player).values({}).returning();
const [house] = await db
	.insert(buildingType)
	.values({ displayName: 'House', buildSeconds: 20 })
	.returning();
await db.insert(building).values({ playerId: p.id, x: 7, y: 8, buildingTypeId: house.id });
await db.insert(character).values({ playerId: p.id, x: 7, y: 9, speed: 0.5 });

console.log(
	`seeded: player ${p.id}, building type ${house.id} (House), hamlet at (7,8), character at (7,9)`
);
await client.end();
