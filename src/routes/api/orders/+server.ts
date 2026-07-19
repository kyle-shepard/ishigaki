import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createBuildOrder, PLAYER_ID } from '$lib/features/world/world.server';
import type { OrderRequest } from '$lib/features/world/world';

export const POST: RequestHandler = async ({ request }) => {
	const { x, y, buildingTypeId } = (await request.json()) as OrderRequest;
	const result = await createBuildOrder(PLAYER_ID, x, y, buildingTypeId);
	return result.ok ? json(result.world) : json({ reason: result.reason }, { status: 400 });
};
