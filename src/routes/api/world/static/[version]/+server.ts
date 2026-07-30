import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { loadWorldStaticFor } from '$lib/features/world/world.server';

// The never-changing half of the wire payload, keyed on the content version `npm run seed` writes
// (see world.server.ts's `readWorldStatic`). Cached at the edge for a year and marked immutable —
// a version string never means two different things, so nothing here ever has to revalidate,
// only fetch the new one when the client's own `worldVersion` moves. `cdn-cache-control` is the
// header Vercel's CDN actually reads on a function response; plain `cache-control` alone only
// reaches the browser's own cache.
//
// A version in the URL that isn't current 404s rather than serving stale content under a live
// path — the client already knows to refetch under whatever version its next `/api/world` read
// reports.
export const GET: RequestHandler = async ({ params }) => {
	const payload = await loadWorldStaticFor(params.version);
	if (!payload) return new Response(null, { status: 404 });
	return json(payload, {
		headers: {
			'cache-control': 'public, max-age=31536000, immutable',
			'cdn-cache-control': 'max-age=31536000'
		}
	});
};
