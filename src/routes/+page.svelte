<script lang="ts">
	import { onMount } from 'svelte';
	// SvelteKit polls its own version manifest (interval set in vite.config.ts) and flips this
	// when the deployed build changes. Rolling our own version field on the world payload
	// would have been the same feature, written twice.
	import { updated } from '$app/state';
	import {
		GRID_SIZE,
		positionAt,
		type OrderReason,
		type WorldPayload
	} from '$lib/features/world/world';

	const CELL = 32;

	const REASON_TEXT: Record<OrderReason, string> = {
		OUT_OF_BOUNDS: 'That tile is off the map.',
		UNKNOWN_BUILDING_TYPE: "You can't build that.",
		TILE_NOT_BUILDABLE: "You can't build on that ground.",
		TILE_OCCUPIED: 'Something is already on that tile.',
		NO_IDLE_CHARACTER: 'Everyone is busy.'
	};

	let world = $state<WorldPayload | null>(null);
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
		if (payload.worldReset) worldReset = true;
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
			apply(await res.json());
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
		let frame: number;

		// Runs on a timer, not on rAF: a backgrounded tab suspends animation frames entirely,
		// and neither reconnecting nor keeping up with the world is a rendering concern.
		//
		// Two jobs, one timer. Reconnect attempts stay fast; otherwise this is a slow heartbeat
		// so that a live content edit (VISION #10 — retune a movement cost, edit a display name,
		// no deploy) actually reaches an open tab. Without it an idle player never re-reads at
		// all: refreshes only fired on mount and when an operation came due, so "live on next
		// read" had no next read.
		const retry = setInterval(() => {
			if (message === TROUBLE || Date.now() - lastReadMs > IDLE_REFRESH_MS) refresh();
		}, 3000);

		const tick = () => {
			nowMs = Date.now() - clockOffset;

			// One refetch when an operation comes due — the server resolves it on read. No
			// polling loop: nothing else changes the world in a single-player tracer.
			const due = world?.operations.filter(
				(o) => Date.parse(o.completeAt) <= nowMs && !settled.has(o.id)
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
			cancelAnimationFrame(frame);
		};
	});

	async function order(x: number, y: number) {
		const buildingTypeId = world?.buildingTypes[0]?.id;
		if (buildingTypeId === undefined) return;

		try {
			const res = await fetch('/api/orders', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ x, y, buildingTypeId })
			});

			if (res.ok) {
				apply(await res.json());
				message = '';
				return;
			}
			// A 400 is a game rule and always carries a reason. Any other status is a failure,
			// not a rule, and must not be dressed up as one.
			if (res.status !== 400) throw new Error(`order failed: ${res.status}`);

			const { reason } = await res.json();
			message = REASON_TEXT[reason as OrderReason] ?? reason;
		} catch (e) {
			console.error(e);
			message = TROUBLE;
		}
	}

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

	const tiles = Array.from({ length: GRID_SIZE * GRID_SIZE }, (_, i) => ({
		x: i % GRID_SIZE,
		y: Math.floor(i / GRID_SIZE)
	}));
	// `terrain` is row-major over the same index this array was built from, so tiles[i] and
	// terrain[i] line up with no second indexing concept.
	const terrainById = $derived(new Map(world?.terrainTypes.map((t) => [t.id, t]) ?? []));
	const resourceName = $derived(new Map(world?.resources.map((r) => [r.id, r.displayName]) ?? []));
	const terrainAt = (i: number) => terrainById.get(world!.terrain[i]);
	// 256 identical buttons to a screen reader today — terrain is the first thing that tells
	// them apart.
	function tileLabel(i: number, x: number, y: number) {
		const t = terrainAt(i);
		if (!t) return `Tile ${x}, ${y}`;
		const yield_ = t.yieldsResourceId ? ` — yields ${resourceName.get(t.yieldsResourceId)}` : '';
		return `Tile ${x}, ${y} — ${t.displayName}${yield_}`;
	}
	const typeName = (id: number) =>
		world?.buildingTypes.find((t) => t.id === id)?.displayName ?? '?';
	// A character with an in-progress operation is walking or building; its stored tile is
	// where it left from, so the live position comes from the operation instead.
	function at(c: { id: number; x: number; y: number }) {
		const op = world?.operations.find((o) => o.characterId === c.id);
		return op ? positionAt(op, nowMs) : c;
	}
</script>

<h1>石垣 Ishigaki</h1>
<p>Click any empty tile to order a House.</p>

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

{#if world}
	<div class="grid" style="--cell: {CELL}px; --size: {GRID_SIZE}">
		{#each tiles as t, i (t.x + ',' + t.y)}
			<button
				class="tile"
				class:blocked={terrainAt(i)?.buildable === false}
				style="background: {terrainAt(i)?.color}"
				onclick={() => order(t.x, t.y)}
				aria-label={tileLabel(i, t.x, t.y)}
			></button>
		{/each}
		{#each world.buildings as b (b.id)}
			<div class="building" style="transform: translate({b.x * CELL}px, {b.y * CELL}px)">
				{typeName(b.buildingTypeId).slice(0, 1)}
			</div>
		{/each}
		<!-- Under construction is drawn from the operation: a building row only exists once
		     built, so presence in `buildings` means finished. -->
		{#each world.operations as o (o.id)}
			<div class="site" style="transform: translate({o.destX * CELL}px, {o.destY * CELL}px)">
				{typeName(o.buildingTypeId).slice(0, 1)}
			</div>
		{/each}
		{#each world.characters as c (c.id)}
			<div class="dot" style="transform: translate({at(c).x * CELL}px, {at(c).y * CELL}px)"></div>
		{/each}
	</div>
{:else}
	<p>Loading…</p>
{/if}

{#if message}<p class="error">{message}</p>{/if}

<p><button onclick={newGame}>New game</button></p>

<style>
	.grid {
		position: relative;
		display: grid;
		grid-template-columns: repeat(var(--size), var(--cell));
		width: max-content;
	}
	.tile {
		width: var(--cell);
		height: var(--cell);
		border: 1px solid rgba(0, 0, 0, 0.15);
		box-sizing: border-box;
		padding: 0;
		cursor: pointer;
	}
	/* Brightness, not a background: a hover colour would erase the terrain underneath. */
	.tile:hover {
		filter: brightness(1.12);
	}
	/* Hints, doesn't enforce — the button stays enabled on purpose. Letting the click reach
	   the server and showing the server's own refusal is what proves the rule lives there. */
	.tile.blocked {
		cursor: not-allowed;
	}
	/* Overlays are absolutely positioned and moved with transform: animating left/top would
	   relayout all 256 cells every frame. */
	.building,
	.site,
	.dot {
		position: absolute;
		top: 0;
		left: 0;
		width: var(--cell);
		height: var(--cell);
		display: grid;
		place-items: center;
		pointer-events: none;
	}
	.building {
		background: #8b5a2b;
		color: white;
		font: bold 16px sans-serif;
	}
	.site {
		border: 2px dashed #8b5a2b;
		color: #8b5a2b;
		font: bold 16px sans-serif;
		opacity: 0.6;
	}
	.dot::after {
		content: '';
		width: 60%;
		height: 60%;
		border-radius: 50%;
		background: #1d4ed8;
	}
	.error {
		color: #b91c1c;
	}
	.notice {
		background: #fef9c3;
		border-left: 4px solid #ca8a04;
		padding: 0.5rem 0.75rem;
		max-width: 34rem;
	}
</style>
