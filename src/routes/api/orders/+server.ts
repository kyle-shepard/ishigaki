import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createBuildOrder } from '$lib/features/world/world.server';
import type { OrderRequest } from '$lib/features/world/world';

export const POST: RequestHandler = async ({ request, locals }) => {
	const { x, y, buildingTypeId } = (await request.json()) as OrderRequest;
	const result = await createBuildOrder(locals.playerId, x, y, buildingTypeId);
	return result.ok ? json(result.world) : json({ reason: result.reason }, { status: 400 });
};
