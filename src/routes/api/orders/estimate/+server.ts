import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { estimateBuild } from '$lib/features/world/world.server';
import type { EstimateRequest } from '$lib/features/world/world';

// A verb in an otherwise resource-shaped API, deliberately: /api/new-game is already this
// project's precedent for one, and following the project's own convention beats the ideal here.
// The static segment resolves ahead of `[id]`, which only defines DELETE, so nothing is shadowed.
//
// POST rather than GET because it runs `resolveWorld` — the read that catches the world up to now
// — and a GET that writes is a worse lie than a POST that only reads.
export const POST: RequestHandler = async ({ request, locals }) => {
	const { x, y, buildingTypeId, crewSize } = (await request.json()) as EstimateRequest;
	const result = await estimateBuild(locals.playerId, x, y, buildingTypeId, crewSize);
	return result.ok ? json(result.estimate) : json({ reason: result.reason }, { status: 400 });
};
