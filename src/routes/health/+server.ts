import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { healthCheck } from '$lib/server/db/schema';

// Proves the full app → Drizzle → Postgres path: reads the seeded row back out.
export async function GET() {
	const [row] = await db.select().from(healthCheck).limit(1);
	return json({ ok: true, db: 'connected', check: row ?? null });
}
