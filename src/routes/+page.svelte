<script lang="ts">
	import { onMount } from 'svelte';
	// SvelteKit polls its own version manifest (interval set in vite.config.ts) and flips this
	// when the deployed build changes. Rolling our own version field on the world payload
	// would have been the same feature, written twice.
	import { updated } from '$app/state';
	import MapCanvas from '$lib/features/world/MapCanvas.svelte';
	import Sprites from '$lib/features/world/Sprites.svelte';
	import {
		GRID_SIZE,
		positionAt,
		qualityBand,
		roadArms,
		ROAD_SIDES,
		roadStyles,
		TIER_CLOSE_MIN,
		TIER_MIDDLE_MIN,
		travelFraction,
		withinReach,
		zoomAbout,
		type EstimateResponse,
		type OrderReason,
		type TravelLeg,
		type WorldLive,
		type WorldPayload,
		type WorldStatic
	} from '$lib/features/world/world';

	// Continuous, where CELL was fixed — wheel, pinch and the +/- buttons all write this, and
	// everything that used to read the constant now reads the state instead: `centreOn`, the
	// `.grid` CSS var, and every overlay's own `translate(x * cell, y * cell)`.
	let cell = $state(32);
	// Past MAX_CELL there is nothing left to see that CLOSE tier doesn't already show; below
	// MIN_CELL the 48-tile world is under 100px wide and going further out buys nothing but a
	// smaller dot.
	const MIN_CELL = 2;
	const MAX_CELL = 64;
	const clampCell = (c: number) => Math.min(MAX_CELL, Math.max(MIN_CELL, c));
	// Derived, never set — there is no tier control anywhere in the UI. Same two numbers MapCanvas
	// gates its own art on, so "where a tier starts" can't read two different answers in two files.
	const tier = $derived(
		cell >= TIER_CLOSE_MIN ? 'close' : cell >= TIER_MIDDLE_MIN ? 'middle' : 'far'
	);

	const REASON_TEXT: Record<OrderReason, string> = {
		OUT_OF_BOUNDS: 'That tile is off the map.',
		UNKNOWN_BUILDING_TYPE: "You can't build that.",
		TILE_NOT_BUILDABLE: "You can't build on that ground.",
		TILE_OCCUPIED: 'Something is already on that tile.',
		NO_IDLE_CHARACTER: 'Everyone is busy.',
		INSUFFICIENT_RESOURCES: "You don't have the materials for that.",
		TILE_YIELDS_NOTHING: "There's nothing to take from that ground.",
		MISSING_REQUIRED_BUILDING: 'That needs a building on the tile before anyone can work it.',
		MISSING_PREREQUISITE: 'You need another building before you can raise that.',
		UNKNOWN_OPERATION: 'Nobody is working there.',
		NO_IDLE_SETTLER: 'You have no idle settler to train.',
		MISSING_SCHOOL: 'Training needs a School on the tile.',
		UNKNOWN_PROFESSION: "That isn't a profession anyone can learn.",
		NOT_A_ROAD: "That isn't a road you can change.",
		NOT_A_WORKSHOP: 'Nothing on that tile makes anything.',
		WORKSHOP_BUSY: 'That workshop is already working on a batch.',
		OUTSIDE_REACH: "That's outside your settlement's reach."
	};

	// A click selects a tile; the inspector panel to the right of the map owns the verbs. No
	// mode toggle — the tile decides which actions are offered (buildable+empty ⇒ Build, yields
	// something ⇒ Gather), and the panel shows them together.
	let selected = $state<{ x: number; y: number } | null>(null);
	// Which building to raise. Null until the first world arrives, then the first type in the catalog.
	let chosen = $state<number | null>(null);
	// Which profession to train at a School. Defaults to the first once a world arrives.
	let chosenProfession = $state<number | null>(null);
	// How many bodies to send. A maximum, not a demand — the order takes up to this many of whoever
	// is free. Persists across tiles like `chosen` does, so a chosen crew size sticks.
	let crewSize = $state(1);
	// Which professions may work the order. Empty is the common case and means anyone; settlers are
	// not on the list, because a settler has no profession to name — you hold your good worker back
	// by not picking them, not by asking for settlers.
	let allowedProfessionIds = $state<number[]>([]);

	// Which panel is showing. The inspector is one of three now: the tile you clicked, every
	// building you hold, every person in your realm. Not routes — the world payload already has
	// all three, so a page load to re-read what is in memory would be a slower way to show it.
	let tab = $state<'tile' | 'buildings' | 'citizens'>('tile');

	// The map's scroll box. 48×48 at 32px is wider than most windows, so the map pans by scrolling
	// and the roster panels need a way to bring a tile into view.
	let pane = $state<HTMLElement | null>(null);
	// A jump, not a glide. `behavior: 'smooth'` is animated by the compositor, so it doesn't run in
	// a tab that isn't painting — and a smooth pan across half a 1536px map is a long wait for
	// somebody who clicked a list row to *be* there. Instant also needs no reduced-motion carve-out.
	function centreOn(x: number, y: number) {
		if (!pane) return;
		// scrollTo clamps for us at every edge, so a tile in a corner just gets as centred as it can.
		pane.scrollTo({
			left: (x + 0.5) * cell - pane.clientWidth / 2,
			top: (y + 0.5) * cell - pane.clientHeight / 2,
			behavior: 'instant'
		});
	}
	// What a row in the buildings or citizens list does: select the tile, show it, and go there.
	function goToTile(x: number, y: number) {
		selectTile(x, y);
		centreOn(x, y);
	}

	// Take hold of the map and move it. The pane is still an ordinary scroll container — its bars are
	// hidden in CSS, not its scrolling — so a drag is just its scroll offset moved by the pointer's
	// delta. No transform and no second coordinate system, which is what keeps every tile's own hit
	// testing, focus ring and aria label working while the map moves under them.
	//
	// Mouse only, deliberately: a touch already pans the pane natively, and handling it here as well
	// would move the map twice as fast as the finger. A two-finger touch is pinch, tracked below —
	// distinct from this drag, which only ever answers to a single mouse button.
	// Plain, not $state: it is mutated on every pointermove and nothing renders from it. The cursor
	// does, so that is a separate boolean rather than a reactive proxy re-firing per mouse move.
	let pan: { lastX: number; lastY: number; travel: number } | null = null;
	let panning = $state(false);
	// True once a drag has actually travelled. Read by the click swallow below — a pan that happens to
	// end on a tile must not also select it.
	let dragged = false;
	// Under this it is a click with an unsteady hand, not a pan.
	const DRAG_SLOP = 4;

	// Zoom about a point: the world coordinate under (px, py) is read before the scale changes and
	// re-planted under that same pixel after. Wheel notches, pinch steps and the +/- buttons all
	// funnel through this one function, so "zoom" has exactly one implementation to get right.
	function zoomAt(px: number, py: number, factor: number) {
		if (!pane) return;
		const next = clampCell(cell * factor);
		if (next === cell) return;
		const left = zoomAbout(pane.scrollLeft, px, cell, next);
		const top = zoomAbout(pane.scrollTop, py, cell, next);
		cell = next;
		pane.scrollLeft = left;
		pane.scrollTop = top;
	}
	// The topbar buttons and the keyboard's +/- zoom about the pane's own centre — there is no
	// cursor position to hold still for either of them.
	function zoomButton(factor: number) {
		if (!pane) return;
		zoomAt(pane.clientWidth / 2, pane.clientHeight / 2, factor);
	}

	// Two-finger pinch, hand-rolled from pointer events: the browser's own pinch gesture zooms the
	// *page* (a visual transform outside the DOM), which never touches `cell` and so would never
	// change tier. `touch-action: pan-x pan-y` on the pane below is what stops the browser from also
	// running that gesture while this one does. Keyed by pointerId because a pinch is two
	// independent touch pointers, not one gesture object the platform hands us pre-summarised.
	const touches = new Map<number, { x: number; y: number }>();
	let pinchDist = 0;
	const touchDistance = () => {
		const [a, b] = [...touches.values()];
		return Math.hypot(a.x - b.x, a.y - b.y);
	};

	function panStart(e: PointerEvent) {
		if (e.pointerType === 'touch') {
			touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
			if (touches.size === 2) pinchDist = touchDistance();
			return;
		}
		if (e.button !== 0 || e.pointerType !== 'mouse') return;
		pan = { lastX: e.clientX, lastY: e.clientY, travel: 0 };
		panning = true;
		// Cleared here rather than after the swallow: a drag released outside the map never produces a
		// click to clear it, and a stale flag would eat the next real one.
		dragged = false;
	}
	function panMove(e: PointerEvent) {
		if (e.pointerType === 'touch' && touches.has(e.pointerId)) {
			touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
			if (touches.size === 2 && pane) {
				const dist = touchDistance();
				if (pinchDist > 0) {
					const [a, b] = [...touches.values()];
					const rect = pane.getBoundingClientRect();
					zoomAt((a.x + b.x) / 2 - rect.left, (a.y + b.y) / 2 - rect.top, dist / pinchDist);
				}
				pinchDist = dist;
			}
			return;
		}
		if (!pan || !pane) return;
		const dx = e.clientX - pan.lastX;
		const dy = e.clientY - pan.lastY;
		pan.lastX = e.clientX;
		pan.lastY = e.clientY;
		pan.travel += Math.hypot(dx, dy);
		if (pan.travel < DRAG_SLOP) return;
		dragged = true;
		// Assigning rather than scrollBy: it clamps at the edges for free and never animates.
		pane.scrollLeft -= dx;
		pane.scrollTop -= dy;
	}
	function panEnd(e: PointerEvent) {
		touches.delete(e.pointerId);
		pinchDist = touches.size === 2 ? touchDistance() : 0;
		pan = null;
		panning = false;
	}
	function swallowClick(e: MouseEvent) {
		if (!dragged) return;
		e.stopPropagation();
		e.preventDefault();
	}

	// Attached imperatively rather than as an onwheel attribute: Svelte's synthetic listener is
	// passive by default, and a passive listener's preventDefault is a silent no-op — the page would
	// scroll *and* the map would zoom.
	$effect(() => {
		if (!pane) return;
		const el = pane;
		function onWheel(e: WheelEvent) {
			e.preventDefault();
			const rect = el.getBoundingClientRect();
			// A fixed factor per event rather than one scaled by deltaY: a trackpad fires many small
			// deltas and a mouse wheel fires few large ones, and pricing the *event* keeps both
			// feeling like the same zoom speed instead of one crawling and the other flying.
			zoomAt(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 1.15 : 1 / 1.15);
		}
		el.addEventListener('wheel', onWheel, { passive: false });
		return () => el.removeEventListener('wheel', onWheel);
	});

	// Open on the hamlet rather than on the map's top-left corner. Not $state: writing it must not
	// re-run the effect, and nothing renders from it.
	let centred = false;
	$effect(() => {
		if (centred || !pane || !home) return;
		centred = true;
		// One task late, deliberately. Centring is measured off the pane's own size, and the effect
		// can run before the stylesheet has finished applying — which centres the map on a pane that
		// is not yet the size it is about to be. A timer rather than requestAnimationFrame because a
		// backgrounded tab suspends frames entirely, and a game opened in a second tab should still
		// be looking at the hamlet when you get to it.
		setTimeout(() => centreOn(home.x, home.y));
	});

	// Light/dark. The real source of truth is documentElement.dataset.theme (set pre-paint in
	// app.html); this mirrors it so the toggle button re-renders. Persisted to localStorage.
	let theme = $state<'light' | 'dark'>('light');
	function toggleTheme() {
		theme = theme === 'dark' ? 'light' : 'dark';
		document.documentElement.dataset.theme = theme;
		try {
			localStorage.setItem('theme', theme);
		} catch {
			// Private mode or blocked storage — the toggle still works for this session.
		}
	}

	let world = $state<WorldPayload | null>(null);
	// Where the keyboard cursor starts if nothing is selected yet, and where the far tier's own pin
	// sits — "your own first building, or wherever your first body happens to be", the same fallback
	// the centring effect above uses to open the map on load. `world.buildings` now carries every
	// realm's, not just yours (VISION #4's reversal), so this has to filter to your own — otherwise
	// the map could open centred on a stranger's hamlet.
	const home = $derived(
		world?.buildings.find((b) => b.playerId === world!.playerId) ?? world?.characters[0] ?? null
	);
	let message = $state('');
	// Sticky: the server reports a lost realm on one response only, and a heartbeat refresh
	// half a minute later must not quietly erase the notice before it has been read.
	let worldReset = $state(false);
	// Server time, advanced by rAF. Positions are *derived* from it rather than written by
	// the loop, so the very first paint is already correct — no frame has to fire first.
	let nowMs = $state(0);

	// The browser clock is never trusted directly — only its offset from the server's.
	let clockOffset = 0;

	// When the last successful read landed. Drives the idle heartbeat below.
	let lastReadMs = 0;

	function apply(payload: WorldPayload) {
		clockOffset = Date.now() - Date.parse(payload.now);
		world = payload;
		nowMs = Date.parse(payload.now);
		lastReadMs = Date.now();
		// Only until the player has picked for themselves — re-defaulting on every refresh
		// would snatch their choice back twice a minute.
		if (chosen === null) chosen = payload.buildingTypes[0]?.id ?? null;
		if (chosenProfession === null) chosenProfession = payload.professions[0]?.id ?? null;
		if (payload.worldReset) worldReset = true;
	}

	// The terrain/catalog half, cached in memory only — not sessionStorage: it is re-fetched at
	// most once a session (on boot, and again only if `worldVersion` ever moves), and Cache-Control:
	// immutable already makes that refetch a browser-cache hit, not a network round trip. Keyed by
	// version, not a bare flag: a reseed mid-session must refetch, not keep serving stale terrain.
	let cachedStaticVersion: string | null = null;
	let cachedStatic: WorldStatic | null = null;

	async function ensureStatic(version: string): Promise<WorldStatic> {
		if (cachedStatic && cachedStaticVersion === version) return cachedStatic;
		const res = await fetch(`/api/world/static/${version}`);
		if (!res.ok) throw new Error(`world statics failed: ${res.status}`);
		cachedStatic = (await res.json()) as WorldStatic;
		cachedStaticVersion = version;
		return cachedStatic;
	}

	// GET /api/world's own shape now — the live half alone. Merged with the statics for its own
	// `worldVersion` *before* `apply` ever sees it, so a mismatched pair is never rendered: the
	// consistency contract WorldLive's own comment describes. A write endpoint (act, below) still
	// hands `apply` a full WorldPayload directly — it already composed both halves server-side, so
	// there is nothing to merge.
	async function applyLive(payload: WorldLive) {
		const statics = await ensureStatic(payload.worldVersion);
		apply({ ...statics, ...payload });
	}

	// The server distinguishes "you broke a game rule" (400 with a reason) from "something
	// went wrong" (anything else). The client has to keep that distinction visible instead of
	// applying an error body as if it were a world.
	const TROUBLE = 'Lost contact with the world. Retrying…';
	// Slow on purpose: the economy runs in minutes, so this only has to be faster than a
	// player noticing that a live content edit hasn't landed.
	const IDLE_REFRESH_MS = 30_000;

	let refreshing = false;
	async function refresh() {
		if (refreshing) return;
		refreshing = true;
		try {
			const res = await fetch('/api/world');
			if (!res.ok) throw new Error(`world read failed: ${res.status}`);
			await applyLive(await res.json());
			if (message === TROUBLE) message = '';
		} catch (e) {
			console.error(e);
			message = TROUBLE;
		} finally {
			refreshing = false;
		}
	}

	// Operations we've already refetched for. Without this, an operation that came back still
	// in-progress would re-request every frame — a fetch storm at 60fps.
	const settled = new Set<number>();

	onMount(() => {
		// Mirror whatever app.html's pre-paint script settled on.
		theme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';

		let frame: number;

		// Runs on a timer, not on rAF: a backgrounded tab suspends animation frames entirely,
		// and neither reconnecting nor keeping up with the world is a rendering concern.
		//
		// Two jobs, one timer. Reconnect attempts stay fast; otherwise this is a slow heartbeat
		// so that a live content edit (VISION #10 — retune a movement cost, edit a display name,
		// no deploy) actually reaches an open tab. Without it an idle player never re-reads at
		// all: refreshes only fired on mount and when an operation came due, so "live on next
		// read" had no next read.
		//
		// `document.hidden` skips both jobs — a tab nobody is looking at is exactly the "open tab
		// doing nothing" CLAUDE.md's egress note names, and there is nothing here for the player to
		// see anyway. `onVisible` below is the other half: a returning player must not wait up to
		// 30 s for a heartbeat that was paused the whole time they were away.
		const retry = setInterval(() => {
			if (document.hidden) return;
			if (message === TROUBLE || Date.now() - lastReadMs > IDLE_REFRESH_MS) refresh();
		}, 3000);
		function onVisible() {
			if (!document.hidden) refresh();
		}
		document.addEventListener('visibilitychange', onVisible);

		const tick = () => {
			nowMs = Date.now() - clockOffset;

			// One refetch when a build or a batch comes due — the server resolves it on read. Gathers
			// are excluded because they never come due; they are collected by the idle heartbeat
			// above, which is also what keeps the resource bar creeping upward. A batch has to be in
			// here or the planks it made would sit unseen until the 30 s heartbeat noticed them.
			const due = world?.operations.filter(
				(o) =>
					(o.type === 'build' || o.type === 'craft') &&
					o.completeAt !== null &&
					Date.parse(o.completeAt) <= nowMs &&
					!settled.has(o.id)
			);
			if (due?.length) {
				for (const o of due) settled.add(o.id);
				refresh();
			}
			frame = requestAnimationFrame(tick);
		};

		(async () => {
			await refresh();
			frame = requestAnimationFrame(tick);
		})();

		return () => {
			clearInterval(retry);
			document.removeEventListener('visibilitychange', onVisible);
			cancelAnimationFrame(frame);
		};
	});

	// Every rule-bearing request answers the same two ways — a world, or a reason — so they
	// share one caller rather than three copies of the same try/catch.
	async function act(path: string, init: RequestInit) {
		try {
			const res = await fetch(path, {
				headers: { 'content-type': 'application/json' },
				...init
			});

			if (res.ok) {
				apply(await res.json());
				message = '';
				return;
			}
			// A 400 is a game rule and always carries a reason. Any other status is a failure,
			// not a rule, and must not be dressed up as one.
			if (res.status !== 400) throw new Error(`${path} failed: ${res.status}`);

			const { reason } = await res.json();
			message = REASON_TEXT[reason as OrderReason] ?? reason;
		} catch (e) {
			console.error(e);
			message = TROUBLE;
		}
	}

	// A click no longer acts — it selects. The panel's buttons act on the selection. Clearing
	// any prior refusal so a stale "everyone is busy" doesn't hang over a freshly picked tile.
	// Clicking the map also pulls the panel back to the tile view: you asked about a tile.
	function selectTile(x: number, y: number) {
		selected = { x, y };
		tab = 'tile';
		if (message !== TROUBLE) message = '';
	}

	// Nudges the pane just far enough that the tile is on screen — not centreOn's jump-to-middle,
	// which would fight a player walking the cursor step by step across the map.
	function scrollIntoView(x: number, y: number) {
		if (!pane) return;
		const left = x * cell;
		const top = y * cell;
		if (left < pane.scrollLeft) pane.scrollLeft = left;
		else if (left + cell > pane.scrollLeft + pane.clientWidth)
			pane.scrollLeft = left + cell - pane.clientWidth;
		if (top < pane.scrollTop) pane.scrollTop = top;
		else if (top + cell > pane.scrollTop + pane.clientHeight)
			pane.scrollTop = top + cell - pane.clientHeight;
	}

	// Replaces the 2,304 (soon 16,384) tab stops the tile buttons used to be: one focusable surface
	// (see the map-pane's own attributes below), an arrow-key cursor over the same coordinate space
	// the mouse already selects in, and +/- for the same zoom the topbar buttons and the wheel drive.
	function mapKeydown(e: KeyboardEvent) {
		if (!world) return;
		const step: Record<string, [number, number]> = {
			ArrowUp: [0, -1],
			ArrowDown: [0, 1],
			ArrowLeft: [-1, 0],
			ArrowRight: [1, 0]
		};
		const d = step[e.key];
		if (d) {
			e.preventDefault();
			const base = selected ?? home ?? { x: 0, y: 0 };
			const x = Math.min(GRID_SIZE - 1, Math.max(0, base.x + d[0]));
			const y = Math.min(GRID_SIZE - 1, Math.max(0, base.y + d[1]));
			selectTile(x, y);
			scrollIntoView(x, y);
		} else if (e.key === '+' || e.key === '=') {
			e.preventDefault();
			zoomButton(1.4);
		} else if (e.key === '-' || e.key === '_') {
			e.preventDefault();
			zoomButton(1 / 1.4);
		}
	}

	function buildHere() {
		if (!selected || chosen === null) return;
		const { x, y } = selected;
		act('/api/orders', {
			method: 'POST',
			body: JSON.stringify({ x, y, buildingTypeId: chosen, crewSize, allowedProfessionIds })
		});
	}

	function gatherHere() {
		if (!selected) return;
		const { x, y } = selected;
		act('/api/assignments', { method: 'POST', body: JSON.stringify({ x, y }) });
	}

	function trainHere() {
		if (!selected || chosenProfession === null) return;
		const { x, y } = selected;
		act('/api/training', {
			method: 'POST',
			body: JSON.stringify({ x, y, professionId: chosenProfession })
		});
	}

	// Order a batch at the workshop on the selected tile. No building type in the body — the thing
	// standing there is the recipe.
	function craftHere() {
		if (!selected) return;
		const { x, y } = selected;
		act('/api/craft', {
			method: 'POST',
			body: JSON.stringify({ x, y, crewSize, allowedProfessionIds })
		});
	}

	const recall = (id: number) => act(`/api/assignments/${id}`, { method: 'DELETE' });
	// Cancel an unfinished build or batch; the server deletes the operation and refunds in full.
	const cancelSite = (id: number) => act(`/api/orders/${id}`, { method: 'DELETE' });

	async function newGame() {
		// Native confirm, because this destroys a realm someone spent real time on and the
		// browser already ships the dialog.
		if (!confirm('Start a new realm? Everything you have built will be lost.')) return;
		try {
			const res = await fetch('/api/new-game', { method: 'POST' });
			if (!res.ok) throw new Error(`new game failed: ${res.status}`);
			// The cookie is gone, so the refresh below bootstraps a fresh realm the same way a
			// first visit does.
			worldReset = false;
			message = '';
			settled.clear();
			await refresh();
		} catch (e) {
			console.error(e);
			message = TROUBLE;
		}
	}

	const terrainById = $derived(new Map(world?.terrainTypes.map((t) => [t.id, t]) ?? []));
	const resourceName = $derived(new Map(world?.resources.map((r) => [r.id, r.displayName]) ?? []));
	const terrainAt = (i: number) => terrainById.get(world!.terrain[i]);
	const buildingTypeById = $derived(new Map(world?.buildingTypes.map((t) => [t.id, t]) ?? []));
	// The art carries what's on a tile for everyone who can see it. The label is the same
	// information for everyone who can't — so it names the building too, not just the ground.
	function tileLabel(i: number, x: number, y: number) {
		const t = terrainAt(i);
		if (!t) return `Tile ${x}, ${y}`;
		// Floored, so a tile reading "1 of 25" always has a whole unit in it and one reading
		// "0 of 25" really is stripped.
		const left = world!.tileQuantity[i];
		const full = t.capacity;
		const yield_ = t.yieldsResourceId
			? ` — yields ${resourceName.get(t.yieldsResourceId)}` +
				(left !== null && full !== null ? ` (${Math.floor(left)} of ${full} left)` : '')
			: '';
		const built = world!.buildings.find((b) => b.x === x && b.y === y);
		const site = world!.operations.find(
			(o) => o.type === 'build' && o.destX === x && o.destY === y
		);
		const on = built
			? ` — ${typeName(built.buildingTypeId)}`
			: site
				? ` — ${typeName(site.buildingTypeId!)} under construction`
				: '';
		return `Tile ${x}, ${y} — ${t.displayName}${yield_}${on}`;
	}
	const typeName = (id: number) => buildingTypeById.get(id)?.displayName ?? '?';
	// A build's price and a recipe's inputs are the same shape asked of two tables, so one formatter
	// serves both — "6 Wood", "20 Wood + 10 Planks". Empty for a type with no rows.
	const quantities = (
		rows: { buildingTypeId: number; resourceId: number; quantity: number }[],
		id: number
	) =>
		rows
			.filter((c) => c.buildingTypeId === id)
			.map((c) => `${c.quantity} ${resourceName.get(c.resourceId)}`)
			.join(' + ');
	// A building with no cost rows is free, and says so rather than showing an empty bracket.
	const priceOf = (id: number) => quantities(world?.buildingCosts ?? [], id) || 'free';
	const resourceAt = (x: number, y: number) => {
		const id = terrainById.get(world!.terrain[y * GRID_SIZE + x])?.yieldsResourceId;
		return id ? resourceName.get(id) : 'nothing';
	};
	// An unknown key resolves to no symbol and draws nothing — a tile missing its art, not a
	// broken page.
	const typeIcon = (id: number) => buildingTypeById.get(id)?.icon ?? '';
	// Each member of a crew walks their own route — from their own tile, their own way, arriving at
	// their own time — so a travel leg is composed per worker rather than read off the operation.
	type Op = WorldPayload['operations'][number];
	function legFor(op: Op, characterId: number): TravelLeg | undefined {
		const w = op.workers.find((w) => w.characterId === characterId);
		// A queued build has neither: nobody is walking anywhere yet.
		if (!w || op.startedAt === null) return undefined;
		return { path: w.path, startedAt: op.startedAt, travelDoneAt: w.arrivesAt };
	}
	// A character with an in-progress operation is walking or building; its stored tile is
	// where it left from, so the live position comes from the operation instead.
	function at(c: { id: number; x: number; y: number }) {
		const op = opFor(c.id);
		const leg = op && legFor(op, c.id);
		return leg ? positionAt(leg, nowMs, GRID_SIZE) : c;
	}
	const professionName = $derived(
		new Map(world?.professions.map((p) => [p.id, p.displayName]) ?? [])
	);
	const characterById = $derived(new Map(world?.characters.map((c) => [c.id, c]) ?? []));
	// A body's name if it's a specialist, else "a settler" — how the panel and roster label it.
	const who = (c: { name: string | null; professionId: number | null }) =>
		c.name ? `${c.name} (${professionName.get(c.professionId!)})` : 'a settler';
	const opFor = (id: number) =>
		world?.operations.find((o) => o.workers.some((w) => w.characterId === id));
	// What a worker is doing right now, for the panel. Walking is derived from the travel leg,
	// not a stored status — a worker mid-trip reads as walking whatever they'll do on arrival.
	function doing(c: { id: number }): string {
		const op = opFor(c.id);
		if (!op) return 'idle';
		const leg = legFor(op, c.id);
		if (leg && travelFraction(leg, nowMs) < 1) return `walking to ${op.destX}, ${op.destY}`;
		if (op.type === 'build') return `building ${typeName(op.buildingTypeId!)}`;
		if (op.type === 'train') return `training as ${professionName.get(op.professionId!)}`;
		// Before this branch existed, the fall-through reported a crafter as "gathering nothing" —
		// a craft's buildingTypeId names the workshop, so it names what is being *made*, not raised.
		if (op.type === 'craft') return `making ${outputOf(op.buildingTypeId!)}`;
		return `gathering ${resourceAt(op.destX, op.destY)}`;
	}
	// What a workshop type makes, as a phrase: "10 Planks". Empty for a type with no recipe.
	function outputOf(typeId: number) {
		const t = buildingTypeById.get(typeId);
		if (!t || t.producesResourceId === null) return '';
		return `${t.outputQuantity} ${resourceName.get(t.producesResourceId)}`;
	}

	// Everything the panel reads off the selected tile. Derived, so a build landing or a worker
	// arriving updates the open panel with no re-click. `present` keys on live position, so it
	// recomputes as nowMs advances and workers walk on and off the tile.
	const selIndex = $derived(selected ? selected.y * GRID_SIZE + selected.x : -1);
	const selTerrain = $derived(selected ? terrainAt(selIndex) : undefined);
	const selYields = $derived(selTerrain?.yieldsResourceId ?? null);
	const selBuilt = $derived(
		selected ? world?.buildings.find((b) => b.x === selected!.x && b.y === selected!.y) : undefined
	);
	// Whether the building on the selected tile is yours — `world.buildings` now carries every
	// realm's (VISION #4's reversal), so every verb below that only makes sense on your own
	// building (restyling a road, training, crafting) gates on this rather than on `selBuilt`
	// merely existing.
	const selMine = $derived(!!selBuilt && !!world && selBuilt.playerId === world.playerId);
	const selSite = $derived(
		selected
			? world?.operations.find(
					(o) => o.type === 'build' && o.destX === selected!.x && o.destY === selected!.y
				)
			: undefined
	);
	// Whether the selected tile is inside the realm's own sphere of influence — the same arithmetic
	// (`withinReach`) MapCanvas draws as a circle and the server enforces, so this can never predict
	// a refusal the server wouldn't also give, or the other way round.
	const selWithinReach = $derived(
		!!selected && !!world && withinReach(selected.x, selected.y, world.reach)
	);
	// Build is offered only where the ground allows *some* type, nothing already stands or is
	// rising, and the tile is inside reach. Keys on the terrain's eligible list (per-terrain,
	// server-authored), not the bare `buildable` flag — so a deposit still offers its extractor and
	// Mountain offers nothing.
	const buildableHere = $derived(
		!!selected && (selTerrain?.buildableTypeIds.length ?? 0) > 0 && !selBuilt && !selSite
	);
	const canBuild = $derived(buildableHere && selWithinReach);
	// Buildable, but outside the circle — the doomed-button case the panel explains instead of
	// offering, per the reach's own refusal (OUTSIDE_REACH).
	const outsideReachToBuild = $derived(buildableHere && !selWithinReach);
	// The building types the player owns, for greying a type whose realm-wide prerequisite isn't met.
	// Filtered to your own — `world.buildings` now carries every realm's (VISION #4's reversal), and
	// a prerequisite is "you own one", not "one exists anywhere on the map".
	const ownedTypeIds = $derived(
		new Set(
			world?.buildings.filter((b) => b.playerId === world!.playerId).map((b) => b.buildingTypeId) ??
				[]
		)
	);
	// The menu for the selected tile: only types this terrain allows, each flagged if its
	// prerequisite building isn't owned yet (greyed, "Requires a {name}").
	const buildOptions = $derived.by(() => {
		if (!world || !selTerrain) return [];
		const eligible = new Set(selTerrain.buildableTypeIds);
		return world.buildingTypes
			.filter((bt) => eligible.has(bt.id))
			.map((bt) => {
				const need = bt.requiresBuildingTypeId;
				const blocked = need !== null && !ownedTypeIds.has(need);
				return { ...bt, blocked, needName: need !== null ? typeName(need) : null };
			});
	});
	// The Build button is live only when the chosen type is actually placeable here — `chosen`
	// persists across tiles, so a Quarry picked on an outcrop mustn't fire a doomed order on a meadow.
	const chosenOk = $derived(buildOptions.some((o) => o.id === chosen && !o.blocked));
	// Training is offered where a finished School stands on the selected tile — yours: the inspector
	// must not offer a verb on a building you don't own (the server would refuse it as MISSING_SCHOOL
	// anyway, since that check is also ownership-scoped, but the button shouldn't be there to click).
	const selIsSchool = $derived(
		selMine && !!selBuilt && typeName(selBuilt.buildingTypeId) === 'School'
	);
	// A workshop is a *type* that carries a recipe — keyed on that rather than on the name 'Sawmill',
	// which is the reskin column (VISION #10), so a Joinery needs no client change to offer its verb.
	// Yours only, same reasoning as `selIsSchool`.
	const selWorkshop = $derived.by(() => {
		if (!selMine || !selBuilt) return undefined;
		const t = buildingTypeById.get(selBuilt.buildingTypeId);
		return t && t.producesResourceId !== null ? t : undefined;
	});
	// The batch in flight at the selected tile, if there is one. One at a time, so `find` is the
	// whole answer rather than the first of several.
	const selBatch = $derived(
		selected
			? world?.operations.find(
					(o) => o.type === 'craft' && o.destX === selected!.x && o.destY === selected!.y
				)
			: undefined
	);
	const present = $derived(
		selected && world
			? world.characters.filter((c) => {
					const p = at(c);
					return Math.round(p.x) === selected!.x && Math.round(p.y) === selected!.y;
				})
			: []
	);

	// Bodies on the map are dots, and bodies sharing a tile fan into a 2×2 so a stack reads as
	// a crowd rather than one pawn (LoL-style). A lone body sits centred (slot −1); past four on
	// a tile the extras are only in the panel's worker list — the map says "a crowd", the panel
	// says who. Keyed on live position, so it recomputes as workers walk and regroups on arrival.
	const DOT = 6; // how far a dot sits from cell centre, in the 32-unit viewBox
	const slotOffset = (slot: number) =>
		slot < 0 ? [0, 0] : [slot % 2 ? DOT : -DOT, slot < 2 ? -DOT : DOT];
	const dots = $derived.by(() => {
		if (!world) return [];
		// Settlers are the dots; specialists are drawn as their own pawns (below), so they don't
		// take a dot slot here.
		const settlers = world.characters.filter((c) => c.professionId === null);
		const groups = new Map<string, { id: number; x: number; y: number }[]>();
		for (const c of settlers) {
			const p = at(c);
			const key = `${Math.round(p.x)},${Math.round(p.y)}`;
			(groups.get(key) ?? groups.set(key, []).get(key)!).push({ id: c.id, x: p.x, y: p.y });
		}
		const out: { id: number; x: number; y: number; slot: number }[] = [];
		for (const arr of groups.values()) {
			const lone = arr.length === 1;
			arr.slice(0, 4).forEach((d, i) => out.push({ ...d, slot: lone ? -1 : i }));
		}
		return out;
	});
	// Named specialists, for both the map pawns and the roster. Live position so a pawn tracks a
	// walking specialist.
	const specialists = $derived(world?.characters.filter((c) => c.professionId !== null) ?? []);

	// ---- Roads -----------------------------------------------------------------------------------
	// A type that changes the ground's movement cost is drawn as linear infrastructure — a hub and
	// arms joining its own kind — rather than as one building sprite. Keyed on that rather than on the
	// name 'Road', which is the reskin column, so a towpath or a paved way needs no client change.
	const roadTypeIds = $derived(
		new Set(world?.buildingTypes.filter((t) => t.movementCost !== null).map((t) => t.id) ?? [])
	);
	// Every realm's roads, deliberately not just yours: a road is physically on the ground (VISION
	// #4's reversal), so a network built by two neighbours still has to draw as one continuous road
	// rather than stopping dead at whichever tile changed hands.
	const roadTiles = $derived(
		new Set(
			world?.buildings
				.filter((b) => roadTypeIds.has(b.buildingTypeId))
				.map((b) => b.y * GRID_SIZE + b.x) ?? []
		)
	);
	// Off the map is not a road, which is what stops an edge tile drawing an arm into nothing.
	const isRoad = (x: number, y: number) =>
		x >= 0 && y >= 0 && x < GRID_SIZE && y < GRID_SIZE && roadTiles.has(y * GRID_SIZE + x);
	type Built = WorldPayload['buildings'][number];
	// The rotations to draw, in bit order — one arm per side this tile joins.
	const armsOf = (b: Built) => {
		const mask = roadArms(b.x, b.y, isRoad, b.roadMask);
		return ROAD_SIDES.filter((s) => mask & s.bit).map((s) => s.degrees);
	};
	// The styles on offer for the selected road, from its *neighbours* rather than its current
	// override — the choice is a property of the junction, not of what it is drawn as right now.
	// Yours only: restyling is a verb, and the inspector must not offer one on a road you don't own.
	const selRoadStyles = $derived(
		selMine && selBuilt && roadTypeIds.has(selBuilt.buildingTypeId)
			? roadStyles(roadArms(selBuilt.x, selBuilt.y, isRoad, null))
			: []
	);
	function cycleRoad() {
		if (!selBuilt) return;
		// An override the junction no longer contains isn't in the list, so findIndex misses and this
		// lands back on "however it joins up" — the right answer for a shape that has gone stale.
		const at = selRoadStyles.findIndex((s) => s === selBuilt!.roadMask);
		const next = selRoadStyles[(at + 1) % selRoadStyles.length];
		act(`/api/roads/${selBuilt.id}`, {
			method: 'PATCH',
			body: JSON.stringify({ roadMask: next })
		});
	}

	// ---- The resource bar ----------------------------------------------------------------------
	const resourceIcon = $derived(new Map(world?.resources.map((r) => [r.id, r.icon]) ?? []));
	// Below this the number is noise: a rate rounds to 0.0 and a "+0.0" beside a still stock reads
	// as a promise nothing is keeping.
	const RATE_SHOWN = 0.05;
	const rateText = (r: number) => `${r > 0 ? '+' : '-'}${Math.abs(r).toFixed(1)}`;

	// ---- The buildings panel -------------------------------------------------------------------
	// Everything you have raised, plus everything you are raising — a site is a building you are
	// waiting on, and leaving it out would make the list disagree with the map.
	//
	// No maintenance column: nothing in the world decays, needs upkeep, or has a condition, so
	// there is no number to put there. It goes beside `quality` when the decay epic gives it one.
	type Row = {
		key: string;
		x: number;
		y: number;
		typeId: number;
		quality: number | null;
		state: 'built' | 'building' | 'waiting';
	};
	const allBuildingRows = $derived.by<Row[]>(() => {
		if (!world) return [];
		// Yours only — `world.buildings` now carries every realm's (VISION #4's reversal), and a
		// roster lists what you manage, not what everyone happens to have built.
		const rows: Row[] = world.buildings
			.filter((b) => b.playerId === world!.playerId)
			.map((b) => ({
				key: `b${b.id}`,
				x: b.x,
				y: b.y,
				typeId: b.buildingTypeId,
				quality: b.quality,
				state: 'built' as const
			}));
		for (const o of world.operations) {
			if (o.type !== 'build') continue;
			rows.push({
				key: `o${o.id}`,
				x: o.destX,
				y: o.destY,
				typeId: o.buildingTypeId!,
				quality: null,
				state: o.startedAt === null ? 'waiting' : 'building'
			});
		}
		// By kind, then down the map — so the same building is in the same place between reads, and
		// the two Houses sit together.
		return rows.sort(
			(a, b) => typeName(a.typeId).localeCompare(typeName(b.typeId)) || a.y - b.y || a.x - b.x
		);
	});
	// Roads are counted, never listed. A network is dozens of tiles and none of them is a thing you
	// go and look at — forty rows of "Road" would bury the four buildings you actually manage. They
	// stay in the summary line, which is the honest place for "you have paved thirty tiles".
	const buildingRows = $derived(allBuildingRows.filter((r) => !roadTypeIds.has(r.typeId)));
	// "3 House · 1 Barn · 24 Road" — the summary the list itself can't give at a glance once it's long.
	const buildingSummary = $derived.by(() => {
		const counts = new Map<string, number>();
		for (const r of allBuildingRows) {
			const name = typeName(r.typeId);
			counts.set(name, (counts.get(name) ?? 0) + 1);
		}
		return [...counts].map(([name, n]) => `${n} ${name}`).join(' · ');
	});

	// ---- The citizens panel --------------------------------------------------------------------
	// Specialists first, by trade then name; the anonymous many after them, in the order they
	// arrived. A roster you scan for a person, and the settlers are a block at the bottom.
	const citizens = $derived(
		[...(world?.characters ?? [])].sort((a, b) => {
			if ((a.professionId === null) !== (b.professionId === null))
				return a.professionId === null ? 1 : -1;
			if (a.professionId !== b.professionId)
				return (professionName.get(a.professionId!) ?? '').localeCompare(
					professionName.get(b.professionId!) ?? ''
				);
			return (a.name ?? '').localeCompare(b.name ?? '') || a.id - b.id;
		})
	);

	// ---- The live estimate ---------------------------------------------------------------------
	// What this build would cost you in time and workmanship, before you spend anything. The server
	// answers from the same code path the order takes, so the quote and the outcome are the same
	// arithmetic rather than two implementations that agree for now.
	let estimate = $state<EstimateResponse | null>(null);
	// A refusal the estimate saw — shown inline by the numbers rather than as a page-level error,
	// because nothing has been attempted yet.
	let estimateRefusal = $state<OrderReason | null>(null);

	// The quote, narrowed once. A build with nobody free answers with nulls — a real answer, not a
	// missing one — and splitting it here keeps the template from re-asking on every field.
	const quote = $derived(
		estimate && estimate.seconds !== null && estimate.quality !== null
			? { seconds: estimate.seconds, quality: estimate.quality, crew: estimate.crew }
			: null
	);

	function duration(seconds: number) {
		const m = Math.floor(seconds / 60);
		const s = Math.round(seconds % 60);
		return m ? `${m}m ${s}s` : `${s}s`;
	}

	// Re-quotes whenever the tile, the type or the crew size changes. Debounced, because the crew
	// stepper fires per keystroke and nobody needs a round trip per digit.
	$effect(() => {
		const target = selected;
		const type = chosen;
		const size = crewSize;
		// Read here, in the effect's synchronous part, so it is a tracked dependency: ticking a
		// profession has to re-quote, not sit on a stale number.
		const only = [...allowedProfessionIds];
		if (!target || type === null || !canBuild) {
			estimate = null;
			estimateRefusal = null;
			return;
		}
		const timer = setTimeout(async () => {
			try {
				const res = await fetch('/api/orders/estimate', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						x: target.x,
						y: target.y,
						buildingTypeId: type,
						crewSize: size,
						allowedProfessionIds: only
					})
				});
				if (res.status === 400) {
					estimate = null;
					estimateRefusal = (await res.json()).reason;
					return;
				}
				if (!res.ok) throw new Error(`estimate failed: ${res.status}`);
				estimate = await res.json();
				estimateRefusal = null;
			} catch (e) {
				// A quote that can't be fetched is not worth a page-level error — the Build button
				// still works, and the server is still the one that decides.
				console.error(e);
				estimate = null;
				estimateRefusal = null;
			}
		}, 200);
		return () => clearTimeout(timer);
	});
</script>

<Sprites />

<!-- The band across the top: the realm, what it holds, and the two verbs that aren't about a tile.
     Fixed, because the map beneath it is the whole window now and nothing scrolls the page. -->
<header class="topbar">
	<h1>石垣</h1>
	{#if world}
		<!-- Stellaris-style: the icon *is* the label, the number is what you hold, and the rate beside
		     it is where it's going. Floored, not rounded: showing 5 Wood when you hold 4.9 and then
		     refusing a 5-Wood build would read as the server lying. The name is kept for screen
		     readers and in the tooltip — an icon alone is not a label. -->
		<ul class="stock">
			{#each world.stock as s (s.resourceId)}
				<li
					title="{resourceName.get(s.resourceId)} — {Math.floor(s.quantity)}{Math.abs(
						s.ratePerHour
					) >= RATE_SHOWN
						? `, ${rateText(s.ratePerHour)} per hour`
						: ''}"
				>
					<svg class="res" viewBox="0 0 32 32" aria-hidden="true">
						<use href="#i-{resourceIcon.get(s.resourceId)}" />
					</svg>
					<span class="sr-only">{resourceName.get(s.resourceId)}</span>
					<b>{Math.floor(s.quantity)}</b>
					{#if Math.abs(s.ratePerHour) >= RATE_SHOWN}
						<span class="rate" class:loss={s.ratePerHour < 0}>{rateText(s.ratePerHour)}</span>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
	<div class="topbar-end">
		<!-- Reachable without a wheel or a pinch. Both zoom about the pane's own centre, the same as
		     the keyboard's +/- — there is no cursor position to hold still for a button press. -->
		<button onclick={() => zoomButton(1 / 1.4)} disabled={!pane} aria-label="Zoom out">−</button>
		<button onclick={() => zoomButton(1.4)} disabled={!pane} aria-label="Zoom in">+</button>
		<button onclick={toggleTheme} aria-label="Toggle light or dark mode">
			{theme === 'dark' ? '☀ Light' : '☾ Dark'}
		</button>
		<button onclick={newGame}>New game</button>
	</div>
</header>

<!-- Over the map rather than above it, since there is no page flow left to sit in. -->
<div class="notices">
	{#if updated.current}
		<p class="notice">
			A new version of the world has been deployed.
			<!-- Full reload, not goto(): the point is to drop the old JS this tab is running. -->
			<button onclick={() => location.reload()}>Refresh</button>
		</p>
	{/if}

	{#if worldReset}
		<p class="notice">
			Your previous realm couldn't be carried across a change to how the world works, so this is a
			fresh start. Sorry — the world is still being built.
		</p>
	{/if}
</div>

{#if world}
	<!-- The map owns the window and pans by scrolling. 48×48 doesn't fit on any screen, and a
	     viewport that shows the whole world is the one thing a map this size can't be.

	     One focusable surface replaces what used to be 2,304 tile buttons: role="application" because
	     the arrow keys are claimed for the map's own cursor rather than for scrolling the page, and
	     the aria-live region below carries the same sentence `tileLabel` always has, so what a mouse
	     click showed on screen and what a keyboard user hears are the same wording. -->
	<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<!-- Both rules read the element's *implicit* role and stop there: <main> is a landmark, so a
	     tabindex and a keydown handler on it look like a mistake. The explicit role="application"
	     directly above is the thing that makes them correct — it is what tells a screen reader to
	     hand the arrow keys to the map's own cursor instead of using them to browse. Kept as <main>
	     rather than a <div> that would silence the linter for free, because the map genuinely is
	     this page's main content and dropping the landmark to please a lint rule is the worse
	     accessibility trade. -->
	<main
		class="map-pane"
		class:panning
		bind:this={pane}
		tabindex="0"
		role="application"
		aria-label="World map"
		onpointerdown={panStart}
		onpointermove={panMove}
		onpointerup={panEnd}
		onpointercancel={panEnd}
		onpointerleave={panEnd}
		onclickcapture={swallowClick}
		onkeydown={mapKeydown}
	>
		<!-- The terrain layer. Canvas, not DOM — see MapCanvas's own header comment for why. -->
		<MapCanvas {world} {selected} {cell} onselect={selectTile} />
		<div
			class="grid"
			style="--cell: {cell}px; width: {cell * GRID_SIZE}px; height: {cell * GRID_SIZE}px"
		>
			{#if tier === 'close'}
				<!-- Roads first, so anything standing beside one is painted over its arms rather than
				     under them — and because a road is the ground, not a thing on it. `foreign` (a
				     player who isn't you) reads as muted art rather than a colour or an outline, so it
				     survives being drawn at any size and never gets confused with the selection ring
				     (blue outline) or a site under construction (dashed, see .site below). -->
				{#each world.buildings.filter((b) => roadTypeIds.has(b.buildingTypeId)) as b (b.id)}
					<svg
						class="over road"
						class:foreign={b.playerId !== world.playerId}
						viewBox="0 0 32 32"
						style="transform: translate({b.x * cell}px, {b.y * cell}px)"
					>
						<use href="#p-road-hub" />
						<!-- One arm per side it joins, rotated about the tile's centre. The shape of a
						     crossing, a corner and a dead end all fall out of this. -->
						{#each armsOf(b) as degrees (degrees)}
							<use href="#p-road-arm" transform="rotate({degrees} 16 16)" />
						{/each}
					</svg>
				{/each}
				{#each world.buildings.filter((b) => !roadTypeIds.has(b.buildingTypeId)) as b (b.id)}
					<svg
						class="over"
						class:foreign={b.playerId !== world.playerId}
						viewBox="0 0 32 32"
						style="transform: translate({b.x * cell}px, {b.y * cell}px)"
					>
						<use href="#i-{typeIcon(b.buildingTypeId)}" />
					</svg>
				{/each}
				<!-- Under construction is drawn from the operation: a building row only exists once
			     built, so presence in `buildings` means finished. Same art, ghosted and pegged out —
			     what's coming is legible before it's there. Builds only: a gather has no building
			     type, and would otherwise paint an empty dashed square wherever someone is working. -->
				{#each world.operations.filter((o) => o.type === 'build') as o (o.id)}
					<svg
						class="over site"
						class:waiting={o.startedAt === null}
						viewBox="0 0 32 32"
						style="transform: translate({o.destX * cell}px, {o.destY * cell}px)"
					>
						<use href="#i-{typeIcon(o.buildingTypeId!)}" />
					</svg>
				{/each}
				{#each dots as d (d.id)}
					{@const off = slotOffset(d.slot)}
					<svg
						class="over"
						viewBox="0 0 32 32"
						style="transform: translate({d.x * cell}px, {d.y * cell}px)"
					>
						<circle class="dot" cx={16 + off[0]} cy={16 + off[1]} r="5" />
					</svg>
				{/each}
				<!-- Specialists are pawns, not dots — a named individual reads as a body, not one of a
				     crowd. Distinct from the settler dots by silhouette. -->
				{#each specialists as c (c.id)}
					<svg
						class="over"
						viewBox="0 0 32 32"
						style="transform: translate({at(c).x * cell}px, {at(c).y * cell}px)"
					>
						<use href="#i-pawn" />
					</svg>
				{/each}
			{:else if tier === 'far'}
				<!-- Pulled back far enough that individual tiles stop being the point — one mark per
				     realm, public now like `buildings` (VISION #4's reversal): yours reads as the same
				     accent blue everything else on the map already uses for "this is yours" (the
				     selection ring, the reach circle); everyone else's is muted grey — the far tier's
				     own version of the `.foreign` treatment the close tier's buildings use. -->
				{#each world.settlements as s (s.playerId)}
					<div
						class="pin"
						class:foreign={s.playerId !== world.playerId}
						style="transform: translate({s.x * cell + cell / 2 - 5}px, {s.y * cell +
							cell / 2 -
							5}px)"
					></div>
				{/each}
			{/if}
			<!-- The selection ring: a div rather than an outline on a button, now that a tile is a
			     patch of canvas and not an element of its own to put an outline on. Drawn at every
			     tier — the keyboard cursor has to stay visible whether or not the buildings it's
			     walking past are. -->
			{#if selected}
				<div
					class="ring"
					style="transform: translate({selected.x * cell}px, {selected.y *
						cell}px); width: {cell}px; height: {cell}px"
				></div>
			{/if}
		</div>
		<!-- The keyboard's answer to the art: the same sentence the old per-tile aria-label gave,
		     spoken when the cursor moves rather than read tile-by-tile off a button that no longer
		     exists. -->
		<div class="sr-only" aria-live="polite">
			{selected ? tileLabel(selIndex, selected.x, selected.y) : ''}
		</div>
	</main>

	<!-- The inspector, and the two rosters. One surface pinned to the right edge, three tabs: which
	     buttons the tile view offers is the tile's decision, not a mode the player has to set. -->
	<aside class="panel">
		<nav class="tabs">
			<button class:on={tab === 'tile'} onclick={() => (tab = 'tile')}>Tile</button>
			<button class:on={tab === 'buildings'} onclick={() => (tab = 'buildings')}>
				Buildings <span class="count">{buildingRows.length}</span>
			</button>
			<button class:on={tab === 'citizens'} onclick={() => (tab = 'citizens')}>
				Citizens <span class="count">{world.characters.length}</span>
			</button>
		</nav>

		{#if tab === 'buildings'}
			{#if buildingRows.length === 0}
				<p class="hint">Nothing raised yet. Click a tile and build something.</p>
			{:else}
				<p class="hint">{buildingSummary}</p>
				<ul class="rows">
					{#each buildingRows as b (b.key)}
						<li>
							<!-- The row is the button: clicking it centres the map on the tile and opens it,
							     which is the whole reason to have a list rather than a count. -->
							<button onclick={() => goToTile(b.x, b.y)}>
								<svg class="rowart" viewBox="0 0 32 32" aria-hidden="true">
									<use href="#i-{typeIcon(b.typeId)}" />
								</svg>
								<span class="rowmain">
									<b>{typeName(b.typeId)}</b>
									<span class="price">{b.x}, {b.y}</span>
								</span>
								{#if b.state === 'built'}
									<!-- The same band the estimate quoted and the tile shows, from the same
									     function. A building raised before quality was recorded says nothing. -->
									<span
										class="price"
										title={b.quality !== null ? `quality ${b.quality.toFixed(2)}` : ''}
									>
										{b.quality !== null ? qualityBand(b.quality) : '—'}
									</span>
								{:else}
									<span class="price">{b.state === 'waiting' ? 'waiting' : 'building…'}</span>
								{/if}
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		{:else if tab === 'citizens'}
			<p class="hint">
				{world.characters.length} people, {specialists.length} trained
			</p>
			<ul class="rows">
				{#each citizens as c (c.id)}
					<li>
						<button onclick={() => goToTile(Math.round(at(c).x), Math.round(at(c).y))}>
							<svg class="rowart" viewBox="0 0 32 32" aria-hidden="true">
								{#if c.professionId !== null}
									<use href="#i-pawn" />
								{:else}
									<circle class="dot" cx="16" cy="16" r="7" />
								{/if}
							</svg>
							<span class="rowmain">
								<b>{c.name ?? 'Settler'}</b>
								<span class="price">
									{c.professionId !== null ? professionName.get(c.professionId) : 'untrained'} — {doing(
										c
									)}
								</span>
								<!-- The rolled sheet, for the one question a roster exists to answer: which of
								     your two Masons is the better one. Settlers have none. -->
								{#if c.strength !== null}
									<span class="stats">
										STR {c.strength} · DEX {c.dexterity} · CON {c.constitution} · INT {c.intelligence}
									</span>
								{/if}
							</span>
						</button>
					</li>
				{/each}
			</ul>
		{:else if !selected}
			<p class="hint">Click a tile to inspect it.</p>
		{:else}
			<h2>Tile {selected.x}, {selected.y}</h2>
			<p>
				{selTerrain?.displayName ?? 'Unknown ground'}
				{#if selYields !== null}
					— yields {resourceName.get(selYields)}
					{#if selTerrain && world.tileQuantity[selIndex] !== null && selTerrain.capacity !== null}
						({Math.floor(world.tileQuantity[selIndex]!)} of {selTerrain.capacity} left)
					{/if}
				{/if}
			</p>

			{#if selBuilt}
				<!-- The same band the estimate quoted, from the same function — so what you were
					     promised and what stands there can never read differently. A building raised
					     before quality was recorded says nothing, rather than "unknown" — and so does
					     one that isn't yours, since quality is private (see WorldLive's own comment). -->
				<p>
					<b>{typeName(selBuilt.buildingTypeId)}</b> stands here.{#if !selMine}
						<span class="price">Not yours.</span>
					{:else if selBuilt.quality !== null}{' '}<span
							class="price"
							title="quality {selBuilt.quality.toFixed(2)}"
							>{qualityBand(selBuilt.quality)} work.</span
						>{/if}
				</p>
				<!-- Only at a junction: a corner or a through-road is already the only sensible drawing
				     of itself, so there would be nothing for the button to do. -->
				{#if selRoadStyles.length > 1}
					<p>
						<button onclick={cycleRoad}>Change road</button>
						<span class="price">
							{selBuilt.roadMask === null
								? 'joins everything next to it'
								: 'drawn straight through'}
						</span>
					</p>
				{/if}
			{:else if selSite && selSite.startedAt === null}
				<p><b>{typeName(selSite.buildingTypeId!)}</b> — waiting for a builder.</p>
				<p class="crew">Starts itself as soon as someone is free.</p>
				<p><button onclick={() => cancelSite(selSite.id)}>Cancel — full refund</button></p>
			{:else if selSite}
				<p><b>{typeName(selSite.buildingTypeId!)}</b> under construction.</p>
				<!-- Who is raising it. The crew is the operation's own membership, so this says the
					     same thing the server acted on rather than guessing from who's standing nearby. -->
				<p class="crew">
					Raised by {selSite.workers
						.map((w) => {
							const c = characterById.get(w.characterId);
							return c ? who(c) : 'someone';
						})
						.join(', ')}
				</p>
				<p><button onclick={() => cancelSite(selSite.id)}>Cancel — full refund</button></p>
			{/if}

			<!-- A verb that appears on one kind of building only — the same shape as the School's Train
			     block below. Keyed on the type carrying a recipe, so every future workshop gets it. -->
			{#if selWorkshop}
				<h3>Make {outputOf(selWorkshop.id)}</h3>
				{#if selBatch && selBatch.startedAt === null}
					<!-- The same waiting state a build site already has: the inputs are spent and held, and
					     nothing more is asked of the player. -->
					<p class="crew">Waiting for a crafter — starts itself as soon as someone is free.</p>
					<p><button onclick={() => cancelSite(selBatch.id)}>Cancel — full refund</button></p>
				{:else if selBatch}
					<p class="crew">
						Being made by {selBatch.workers
							.map((w) => {
								const c = characterById.get(w.characterId);
								return c ? who(c) : 'someone';
							})
							.join(', ')}
					</p>
					<p><button onclick={() => cancelSite(selBatch.id)}>Cancel — full refund</button></p>
				{:else}
					<!-- The inputs leave stock the moment you press the button, so they are named before
					     it rather than discovered after. -->
					<p class="price">Uses {quantities(world.recipeInputs, selWorkshop.id)}</p>
					<label class="crew-size">
						Crew
						<input type="number" min="1" max={world.characters.length} bind:value={crewSize} />
						<span class="price">more hands, less craft</span>
					</label>
					<button onclick={craftHere}>Make a batch</button>
				{/if}
			{/if}

			{#if present.length}
				<h3>Workers here</h3>
				<ul class="present">
					{#each present as c (c.id)}
						{@const op = opFor(c.id)}
						<li>
							{#if c.name}<b>{c.name}</b> ({professionName.get(c.professionId!)}) —
							{/if}{doing(c)}
							{#if op?.type === 'gather' && op.destX === selected.x && op.destY === selected.y}
								<button onclick={() => recall(op.id)}>Recall</button>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}

			{#if canBuild}
				<h3>Build here</h3>
				<ul class="build-picker">
					{#each buildOptions as bt (bt.id)}
						<li class:blocked-type={bt.blocked}>
							<label>
								<input type="radio" bind:group={chosen} value={bt.id} disabled={bt.blocked} />
								{bt.displayName}
								<span class="price">{priceOf(bt.id)}</span>
								<!-- What the price *buys*, for the one type where that is the whole point: a
								     Longhouse is worth its planks because it holds ten people, and reading
								     that after paying would be reading it too late. -->
								{#if bt.housingCapacity > 0}
									<span class="price">houses {bt.housingCapacity}</span>
								{/if}
								{#if bt.blocked}<span class="requires">Requires a {bt.needName}</span>{/if}
							</label>
						</li>
					{/each}
				</ul>
				<!-- A native number input: the browser already ships the stepper, the keyboard
					     handling and the mobile numeric pad. `max` is how many bodies you actually
					     have — more than that is a number with nobody behind it. -->
				<label class="crew-size">
					Crew
					<input type="number" min="1" max={world.characters.length} bind:value={crewSize} />
					<span class="price">more hands, less craft</span>
				</label>
				<!-- Who may work it. Nothing ticked is the ordinary case and means anyone; the whole
					     profession catalog is offered because the payload deliberately ships no skill
					     bundles, so the client cannot know which trades build well — the estimate is
					     what tells you that, and it re-quotes as you tick. -->
				<details class="only">
					<summary>
						Only certain trades
						{#if allowedProfessionIds.length}
							<span class="price">({allowedProfessionIds.length} picked)</span>
						{/if}
					</summary>
					<ul class="build-picker">
						{#each world.professions as p (p.id)}
							<li>
								<label>
									<input
										type="checkbox"
										value={p.id}
										bind:group={allowedProfessionIds}
									/>{p.displayName}
								</label>
							</li>
						{/each}
					</ul>
				</details>
				<!-- The numbers, before you commit. They move as the crew moves — the whole point
					     of the epic, and the thing Lands of Lords only tells you after you've spent
					     the bodies. The raw quality rides in the title; the sentence gets the band. -->
				{#if quote}
					<p class="estimate">
						<b title="quality {quote.quality.toFixed(2)}">
							≈ {duration(quote.seconds)} · {qualityBand(quote.quality)}
						</b>
						<span class="price">
							sending {quote.crew.map((c) => c.name ?? 'a settler').join(', ')}
						</span>
					</p>
				{:else if estimate}
					<!-- Nobody free, or nobody the filter admits. Worth placing anyway: the order
						     holds the tile and the cost, and starts itself when someone frees. -->
					<p class="estimate">
						<b>Nobody is free</b>
						<span class="price">this will wait, and start itself when someone is</span>
					</p>
				{:else if estimateRefusal}
					<p class="estimate price">{REASON_TEXT[estimateRefusal] ?? estimateRefusal}</p>
				{/if}
				<button onclick={buildHere} disabled={!chosenOk}>Build</button>
			{:else if outsideReachToBuild}
				<!-- No Build button offered at all — a doomed order is a worse UX than no order, and
				     the line drawn on the map (MapCanvas's arc) is what should have told you this
				     already. Same wording the server's own OUTSIDE_REACH refusal gives. -->
				<p class="price">
					Outside your reach — your settlement reaches {world.reach?.radius ?? 0} tiles.
				</p>
			{/if}

			{#if selYields !== null}
				{#if selWithinReach}
					<p><button onclick={gatherHere}>Send someone to gather</button></p>
				{:else}
					<!-- Gathering is gated the same as building now — a sphere of influence, not a
					     building permit — so this refuses just as predictably. -->
					<p class="price">
						Outside your reach — your settlement reaches {world.reach?.radius ?? 0} tiles.
					</p>
				{/if}
			{/if}

			{#if selIsSchool}
				<h3>Train a specialist</h3>
				<ul class="build-picker">
					{#each world.professions as p (p.id)}
						<li>
							<label>
								<input type="radio" bind:group={chosenProfession} value={p.id} />
								{p.displayName}
							</label>
						</li>
					{/each}
				</ul>
				<button onclick={trainHere} disabled={chosenProfession === null}>Train a settler</button>
			{/if}
		{/if}

		{#if message}<p class="error">{message}</p>{/if}
	</aside>
{:else}
	<p class="loading">Loading…</p>
{/if}

<style>
	/* Nothing on this page is in page flow. The header is fixed to the top, the map fills every
	   pixel under it and pans by scrolling itself, and the inspector floats over the map's right
	   edge. There is no centred column any more: a 48×48 world is the layout. */
	.topbar {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		height: var(--header-h);
		box-sizing: border-box;
		display: flex;
		align-items: center;
		gap: 1rem;
		padding: 0 0.75rem;
		background: var(--header-bg);
		border-bottom: 1px solid var(--border);
		/* Above the panel, which is above the map's overlays. */
		z-index: 20;
	}
	.topbar h1 {
		margin: 0;
		font-size: 1.35rem;
		flex: none;
	}
	/* The resource strip. Scrolls itself rather than wrapping or squeezing the title out — the
	   header is one line tall and has to stay that way. */
	.stock {
		flex: 1;
		display: flex;
		gap: 0.9rem;
		margin: 0;
		padding: 0;
		list-style: none;
		overflow-x: auto;
		font-variant-numeric: tabular-nums;
	}
	.stock li {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		white-space: nowrap;
	}
	.res {
		width: 1.45rem;
		height: 1.45rem;
		flex: none;
	}
	/* Where the stock is heading. Green up, red down, and absent when it isn't moving. */
	.rate {
		font-size: 0.82em;
		color: var(--gain);
	}
	.rate.loss {
		color: var(--loss);
	}
	/* The icon carries the resource for everyone who can see it; this is the same information for
	   everyone who can't. Clipped rather than hidden, because display:none isn't read out. */
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
	.topbar-end {
		display: flex;
		gap: 0.5rem;
		flex: none;
	}
	.topbar-end button {
		background: var(--panel-bg);
		color: var(--text);
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 0.35rem 0.7rem;
		cursor: pointer;
		font: inherit;
	}
	.topbar-end button:hover {
		filter: brightness(0.97);
	}
	.notices {
		position: fixed;
		top: calc(var(--header-h) + 0.5rem);
		left: 0.75rem;
		z-index: 15;
		max-width: 34rem;
	}
	.notice {
		background: #fef9c3;
		color: #2b2420;
		border-left: 4px solid #ca8a04;
		padding: 0.5rem 0.75rem;
		margin: 0 0 0.5rem;
	}
	.map-pane {
		position: fixed;
		inset: var(--header-h) 0 0 0;
		/* Scrolls, but shows no bars: two grey gutters framing a map you drag is furniture, and the
		   window is the viewport now. Hidden rather than `overflow: hidden`, because that would kill
		   the wheel and the keyboard's scroll-into-view along with the bars — this keeps every way of
		   moving the map except the one nobody wanted to look at. */
		overflow: auto;
		scrollbar-width: none;
		/* A drag across tiles must not start selecting them. */
		user-select: none;
		cursor: grab;
		/* Permits native single-finger scrolling (unchanged from before) but withholds the browser's
		   own pinch-to-zoom gesture, which would otherwise zoom the *page* — a visual transform that
		   never touches `cell` — at the same time the hand-rolled pointer-event pinch above tries to.
		   Two zooms racing each other is worse than either alone. */
		touch-action: pan-x pan-y;
	}
	.map-pane::-webkit-scrollbar {
		display: none;
	}
	.map-pane.panning {
		cursor: grabbing;
	}
	.grid {
		position: relative;
		/* Width and height come from the inline style (cell × GRID_SIZE) now, not from grid-template
		   sizing children — nothing inside is a grid item any more. The terrain layer moved to
		   MapCanvas's own fixed-position canvas; everything left here (buildings, roads, sites, dots,
		   pawns, the selection ring) is absolutely positioned by transform, and none of it is what a
		   click should hit — MapCanvas is. Every element below already carries its own
		   pointer-events: none; this catches the padding and the box itself so a click over open
		   ground reaches the canvas instead of stopping here. */
		pointer-events: none;
		/* So the eastern edge of the map can be scrolled out from under the inspector. Right only:
		   an absolutely positioned overlay is placed against the padding box, so left or top padding
		   would slide every building off its tile. */
		padding-right: 21rem;
	}
	/* Overlays are absolutely positioned and moved with transform: animating left/top would
	   relayout every one of them every frame. */
	.over {
		position: absolute;
		top: 0;
		left: 0;
		width: var(--cell);
		height: var(--cell);
		pointer-events: none;
		z-index: 2;
	}
	/* A body on the map. Filled dark with a light rim so it reads on any terrain colour. */
	.dot {
		fill: #2b2420;
		stroke: #f5f2ea;
		stroke-width: 1.5;
	}
	/* outline, not border: a border would sit inside the box and shrink the 32px art. */
	.site {
		opacity: 0.45;
		outline: 2px dashed #4a3520;
		outline-offset: -2px;
	}
	/* Queued: fainter still, and a dotted outline rather than a dashed one — nobody is on it yet. */
	.site.waiting {
		opacity: 0.22;
		outline-style: dotted;
	}
	/* Someone else's building (VISION #4's reversal made every realm's visible, not just yours) —
	   desaturated and dimmed rather than recoloured, so the same treatment reads at whatever size
	   the art is drawn: full detail up close, a flat coloured square further out, an icon-shaped
	   silhouette either way. Filter, not opacity alone, is what keeps it legibly *muted* rather than
	   merely faint — a faint building is easy to misread as your own site fading in. */
	.foreign {
		filter: grayscale(0.85) brightness(0.85);
		opacity: 0.75;
	}
	/* The selected tile's ring, now a div rather than an outline on a button — the canvas underneath
	   has no element of its own to put one on. Same trick as .site (outline, not border, so it sits
	   over the art without shrinking it) and the same z-index .tile.selected used to carry, below
	   .over's 2 so a building on the selected tile still paints over its own ring. */
	.ring {
		position: absolute;
		top: 0;
		left: 0;
		outline: 2px solid #1d4ed8;
		outline-offset: -2px;
		z-index: 1;
		pointer-events: none;
	}
	/* The far tier's marks: one per realm, not the selection. A filled dot rather than an outline —
	   at a cell size this small an outline would be a hairline nobody could see. Blue is yours, the
	   same accent colour the reach circle and the selection ring already use for "this is yours";
	   .foreign is everyone else's, muted grey so your own realm still stands out at a glance. */
	.pin {
		position: absolute;
		top: 0;
		left: 0;
		width: 10px;
		height: 10px;
		border-radius: 50%;
		background: #1d4ed8;
		box-shadow: 0 0 0 2px #f5f2ea;
		z-index: 2;
		pointer-events: none;
	}
	.pin.foreign {
		background: #8a8a8a;
	}
	/* Pinned to the window's right edge rather than laid out beside the map.

	   It used to be a flex sibling that wrapped underneath as soon as the window got narrow, which
	   put the verbs for the tile you had just clicked below the fold — the panel disappeared exactly
	   when the screen was too small to spare it. Fixed instead: always in the same place, always
	   reachable, whatever the map is doing underneath.

	   Overlapping the map is the intent now rather than a concession: the map owns the window, and
	   the map is the thing that can give way. The grid's right padding means even the last column
	   can still be scrolled clear of it. */
	.panel {
		position: fixed;
		top: var(--header-h);
		right: 0;
		/* Never wider than the window it is pinned to, however small that gets. border-box so that
		   bound counts the padding and the border — otherwise it is the *content* that is capped and
		   the panel still runs past the edge it was meant to fit inside. */
		box-sizing: border-box;
		width: min(20rem, calc(100vw - 2rem));
		/* A tall panel scrolls itself instead of running off the bottom of the window. */
		max-height: calc(100vh - var(--header-h) - 1.5rem);
		overflow-y: auto;
		/* Above the map's own overlays, which sit at 2. */
		z-index: 10;
		background: var(--panel-bg);
		border: 1px solid var(--border);
		/* Flush with the edge, so only the left corners are rounded and the right border is gone —
		   it reads as attached to the window rather than floating loose next to it. */
		border-right: none;
		border-top: none;
		border-radius: 0 0 0 8px;
		padding: 0.75rem 1rem;
		/* Lifts it off whatever it is covering, so the overlap reads as intended. */
		box-shadow: 0 2px 12px rgb(0 0 0 / 0.12);
	}
	/* Stuck to the top of the panel's own scroll, so a hundred citizens never scroll the way out of
	   the roster you are reading. The negative margins are what let its background reach the
	   panel's edges despite the panel's padding. */
	.tabs {
		position: sticky;
		top: 0;
		z-index: 1;
		display: flex;
		gap: 0.25rem;
		margin: -0.75rem -1rem 0.5rem;
		padding: 0.5rem 1rem 0;
		background: var(--panel-bg);
	}
	.tabs button {
		flex: 1;
		font: inherit;
		color: var(--muted);
		background: transparent;
		border: none;
		border-bottom: 2px solid var(--border);
		padding: 0.3rem 0.15rem;
		cursor: pointer;
	}
	.tabs button.on {
		color: var(--text);
		font-weight: 600;
		border-bottom-color: var(--text);
	}
	.count {
		color: var(--muted);
		font-weight: 400;
		font-size: 0.85em;
	}
	/* The two rosters. Each row is a button, because each row goes somewhere. */
	.rows {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.rows button {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		text-align: left;
		font: inherit;
		color: inherit;
		background: transparent;
		border: none;
		border-bottom: 1px solid var(--border);
		padding: 0.35rem 0.1rem;
		cursor: pointer;
	}
	.rows button:hover {
		background: rgb(127 127 127 / 0.12);
	}
	.rowart {
		width: 1.7rem;
		height: 1.7rem;
		flex: none;
	}
	.rowmain {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-width: 0;
	}
	.rowmain .price {
		font-size: 0.82em;
	}
	.stats {
		font-size: 0.78em;
		color: var(--muted);
		font-variant-numeric: tabular-nums;
	}
	.panel h2 {
		margin: 0 0 0.25rem;
	}
	.panel h3 {
		margin: 1rem 0 0.25rem;
	}
	.hint {
		color: var(--muted);
		margin: 0.25rem 0 0.5rem;
	}
	.crew {
		color: var(--muted);
	}
	.crew-size {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		margin: 0.5rem 0;
	}
	.crew-size input {
		width: 4rem;
		font: inherit;
	}
	.estimate {
		margin: 0.25rem 0 0.6rem;
		font-variant-numeric: tabular-nums;
	}
	.estimate span {
		display: block;
	}
	/* Collapsed by default — an unrestricted order is the common one, and seven checkboxes should
	   not be the first thing in the way of the Build button. */
	.only {
		margin: 0.4rem 0;
	}
	.only summary {
		cursor: pointer;
		color: var(--muted);
	}
	.present,
	.build-picker {
		list-style: none;
		padding: 0;
		margin: 0;
	}
	.build-picker label {
		display: flex;
		align-items: center;
		gap: 0.35rem;
	}
	/* A type whose prerequisite isn't owned yet — dimmed and unselectable, with the reason inline. */
	.build-picker li.blocked-type label {
		color: var(--muted);
		cursor: not-allowed;
	}
	.requires {
		color: var(--muted);
		font-style: italic;
	}
	.price {
		color: var(--muted);
	}
	.error {
		color: var(--loss);
	}
	.loading {
		padding: 5rem 1rem;
		text-align: center;
		color: var(--muted);
	}
</style>
