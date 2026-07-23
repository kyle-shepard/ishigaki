import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { assignTraining } from '$lib/features/world/world.server';
import type { TrainRequest } from '$lib/features/world/world';

export const POST: RequestHandler = async ({ request, locals }) => {
	const { x, y, professionId } = (await request.json()) as TrainRequest;
	const result = await assignTraining(locals.playerId, x, y, professionId);
	return result.ok ? json(result.world) : json({ reason: result.reason }, { status: 400 });
};
