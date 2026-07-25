import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { restyleRoad } from '$lib/features/world/world.server';

// PATCH, not POST: this changes one field of a thing that already exists. The id in the path is the
// *building* — a road is a building, and this route is the one verb that only makes sense for the
// kind of building that is a road.
//
// `roadMask` null means "however it joins up", which is a road's normal state, so the field is
// required rather than optional: an absent one would be indistinguishable from a client that meant
// to send a number and lost it.
export const PATCH: RequestHandler = async ({ params, request, locals }) => {
	const { roadMask } = await request.json();
	const result = await restyleRoad(locals.playerId, Number(params.id), roadMask ?? null);
	return result.ok ? json(result.world) : json({ reason: result.reason }, { status: 400 });
};
