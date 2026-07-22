import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { loadWorld } from '$lib/features/world/world.server';

export const GET: RequestHandler = async ({ locals }) => {
	return json(await loadWorld(locals.playerId));
};
