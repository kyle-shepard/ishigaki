import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { recallWorker } from '$lib/features/world/world.server';

// The id is in the path, not a body: the assignment is the thing being ended, so it is the
// thing the URL names.
export const DELETE: RequestHandler = async ({ params, locals }) => {
	const result = await recallWorker(locals.playerId, Number(params.id));
	return result.ok ? json(result.world) : json({ reason: result.reason }, { status: 400 });
};
