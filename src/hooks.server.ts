import type { Handle } from '@sveltejs/kit';
import { ensurePlayer } from '$lib/features/world/world.server';

// Exported so the new-game route clears the same cookie this sets, rather than repeating
// the name and the path and hoping they stay in step.
export const PLAYER_COOKIE = 'pid';
const ONE_YEAR = 60 * 60 * 24 * 365;

/**
 * Identity is a cookie holding a player id — no accounts, no login. Losing the cookie loses
 * the realm, which is why the current worlds are disposable until accounts land (VISION #10).
 *
 * Deliberately scoped to `/api/`: the page itself needs no player to render, and a request
 * that never reaches the API is a crawler, a favicon, or a preflight. Bootstrapping there
 * instead of on every request keeps three rows from being written for each bot that looks at
 * the site — the client fetches `/api/world` on mount, so a real visitor still gets a world
 * on their first page load.
 *
 * ponytail: every cookie-less request to `/api/*` still mints a world — measured, three
 * parallel requests make three players. Harmless at this scale (three rows each, and the
 * worlds are disposable) but it is unbounded under a bot that ignores cookies. The fix is
 * whatever the accounts epic (VISION #10) does for identity, not a rate limiter bolted on
 * here; until then, garbage-collecting realms with no buildings beyond the starting hamlet
 * would do it.
 */
export const handle: Handle = async ({ event, resolve }) => {
	if (!event.url.pathname.startsWith('/api/')) return resolve(event);

	const claimed = Number(event.cookies.get(PLAYER_COOKIE));
	const { playerId, worldReset } = await ensurePlayer(
		Number.isInteger(claimed) && claimed > 0 ? claimed : null
	);

	// Re-set every time rather than only on creation: this slides the expiry forward, so an
	// active player doesn't lose their realm to a cookie that quietly aged out.
	event.cookies.set(PLAYER_COOKIE, String(playerId), {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: !event.url.hostname.includes('localhost'),
		maxAge: ONE_YEAR
	});

	event.locals.playerId = playerId;
	event.locals.worldReset = worldReset;
	return resolve(event);
};
