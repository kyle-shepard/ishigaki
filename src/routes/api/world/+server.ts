import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { loadWorldLive } from '$lib/features/world/world.server';

// The live half only (see world.server.ts's `readWorldLive`) — the heartbeat's own endpoint, and
// the reason it no longer re-sends the tile grid every 30 seconds. The client merges this against
// its own cached `/api/world/static/[version]`, refetching that half whenever `worldVersion` here
// disagrees with what it has.
export const GET: RequestHandler = async ({ locals }) => {
	return json({ ...(await loadWorldLive(locals.playerId)), worldReset: locals.worldReset });
};
