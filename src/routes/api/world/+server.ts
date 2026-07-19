import { json } from '@sveltejs/kit';
import { loadWorld, PLAYER_ID } from '$lib/features/world/world.server';

export async function GET() {
	return json(await loadWorld(PLAYER_ID));
}
