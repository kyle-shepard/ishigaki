import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createCraftOrder } from '$lib/features/world/world.server';
import type { CraftRequest } from '$lib/features/world/world';

// No buildingTypeId in the body: the workshop standing on the tile *is* the recipe. Cancelling a
// batch reuses DELETE /api/orders/[id] — it is the same delete-and-refund path a build takes.
export const POST: RequestHandler = async ({ request, locals }) => {
	const { x, y, crewSize, allowedProfessionIds } = (await request.json()) as CraftRequest;
	const result = await createCraftOrder(locals.playerId, x, y, crewSize, allowedProfessionIds);
	return result.ok ? json(result.world) : json({ reason: result.reason }, { status: 400 });
};
