import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { cancelBuild } from '$lib/features/world/world.server';

// The id is in the path, not a body: the order is the thing being cancelled, so it is the thing
// the URL names. Mirrors assignments/[id] — a build is cancelled, an assignment is recalled.
export const DELETE: RequestHandler = async ({ params, locals }) => {
	const result = await cancelBuild(locals.playerId, Number(params.id));
	return result.ok ? json(result.world) : json({ reason: result.reason }, { status: 400 });
};
