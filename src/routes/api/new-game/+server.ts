import type { RequestHandler } from './$types';
import { PLAYER_COOKIE } from '../../../hooks.server';
import { deletePlayer } from '$lib/features/world/world.server';

export const POST: RequestHandler = async ({ locals, cookies }) => {
	await deletePlayer(locals.playerId);
	// Clearing the cookie rather than handing back a new id: the next request then looks like
	// a first visit, so the fresh realm comes from the same path every other new player takes
	// and doesn't get reported as a world that was lost.
	cookies.delete(PLAYER_COOKIE, { path: '/' });
	return new Response(null, { status: 204 });
};
