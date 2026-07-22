import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { assignWorker } from '$lib/features/world/world.server';
import type { AssignRequest } from '$lib/features/world/world';

export const POST: RequestHandler = async ({ request, locals }) => {
	const { x, y } = (await request.json()) as AssignRequest;
	const result = await assignWorker(locals.playerId, x, y);
	return result.ok ? json(result.world) : json({ reason: result.reason }, { status: 400 });
};
