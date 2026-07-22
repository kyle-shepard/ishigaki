<script lang="ts">
	import { onMount } from 'svelte';
	// SvelteKit polls its own version manifest (interval set in vite.config.ts) and flips this
	// when the deployed build changes. Rolling our own version field on the world payload
	// would have been the same feature, written twice.
	import { updated } from '$app/state';
	import Sprites from '$lib/features/world/Sprites.svelte';
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
		NO_IDLE_CHARACTER: 'Everyone is busy.',
		INSUFFICIENT_RESOURCES: "You don't have the materials for that.",
		TILE_YIELDS_NOTHING: "There's nothing to take from that ground.",
		MISSING_REQUIRED_BUILDING: 'That needs a building on the tile before anyone can work it.',
		UNKNOWN_OPERATION: 'Nobody is working there.'
	};

	// What a click on a tile means. Two verbs, one map.
	let mode = $state<'build' | 'gather'>('build');
	// Which building. Null until the first world arrives, then the first type in the catalog.
	let chosen = $state<number | null>(null);

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
		// Only until the player has picked for themselves — re-defaulting on every refresh
		// would snatch their choice back twice a minute.
		if (chosen === null) chosen = payload.buildingTypes[0]?.id ?? null;
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

			// One refetch when a build comes due — the server resolves it on read. Gathers are
			// excluded because they never come due; they are collected by the idle heartbeat
			// above, which is also what keeps the resource bar creeping upward.
			const due = world?.operations.filter(
				(o) => o.type === 'build' && Date.parse(o.completeAt!) <= nowMs && !settled.has(o.id)
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

	function clickTile(x: number, y: number) {
		if (mode === 'gather') {
			act('/api/assignments', { method: 'POST', body: JSON.stringify({ x, y }) });
			return;
		}
		if (chosen === null) return;
		act('/api/orders', { method: 'POST', body: JSON.stringify({ x, y, buildingTypeId: chosen }) });
	}

	const recall = (id: number) => act(`/api/assignments/${id}`, { method: 'DELETE' });

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
	const buildingTypeById = $derived(new Map(world?.buildingTypes.map((t) => [t.id, t]) ?? []));
	// The art carries what's on a tile for everyone who can see it. The label is the same
	// information for everyone who can't — so it names the building too, not just the ground.
	function tileLabel(i: number, x: number, y: number) {
		const t = terrainAt(i);
		if (!t) return `Tile ${x}, ${y}`;
		// Floored, so a tile reading "1 of 25" always has a whole unit in it and one reading
		// "0 of 25" really is stripped.
		const left = world!.tileQuantity[i];
		const full = world!.tileCapacity[i];
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
	const gathering = $derived(world?.operations.filter((o) => o.type === 'gather') ?? []);
	// A building with no cost rows is free, and says so rather than showing an empty bracket.
	function priceOf(id: number) {
		const parts = (world?.buildingCosts ?? [])
			.filter((c) => c.buildingTypeId === id)
			.map((c) => `${c.quantity} ${resourceName.get(c.resourceId)}`);
		return parts.length ? parts.join(' + ') : 'free';
	}
	const resourceAt = (x: number, y: number) => {
		const id = terrainById.get(world!.terrain[y * GRID_SIZE + x])?.yieldsResourceId;
		return id ? resourceName.get(id) : 'nothing';
	};
	// An unknown key resolves to no symbol and draws nothing — a tile missing its art, not a
	// broken page.
	const typeIcon = (id: number) => buildingTypeById.get(id)?.icon ?? '';
	// A character with an in-progress operation is walking or building; its stored tile is
	// where it left from, so the live position comes from the operation instead.
	function at(c: { id: number; x: number; y: number }) {
		const op = world?.operations.find((o) => o.characterId === c.id);
		return op ? positionAt(op, nowMs) : c;
	}
</script>

<h1>石垣 Ishigaki</h1>

<p class="modes">
	<label><input type="radio" bind:group={mode} value="build" /> Build</label>
	<label><input type="radio" bind:group={mode} value="gather" /> Send someone to gather</label>
</p>

{#if world && mode === 'build'}
	<p class="modes">
		{#each world.buildingTypes as t (t.id)}
			<label>
				<input type="radio" bind:group={chosen} value={t.id} />
				{t.displayName}
				<span class="price">{priceOf(t.id)}</span>
			</label>
		{/each}
	</p>
{/if}

<p>
	{mode === 'build'
		? 'Click an empty tile to order it there.'
		: 'Click ground that yields something to put someone to work on it.'}
</p>

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
	<Sprites />
	<!-- Floored, not rounded: showing 5 Wood when you hold 4.9 and then refusing a 5-Wood
	     build would read as the server lying. -->
	<p class="stock">
		{#each world.stock as s (s.resourceId)}
			<span><b>{resourceName.get(s.resourceId)}</b> {Math.floor(s.quantity)}</span>
		{/each}
	</p>
	<div class="grid" style="--cell: {CELL}px; --size: {GRID_SIZE}">
		{#each tiles as t, i (t.x + ',' + t.y)}
			<button
				class="tile"
				class:blocked={terrainAt(i)?.buildable === false}
				style="background: {terrainAt(i)?.color}"
				onclick={() => clickTile(t.x, t.y)}
				aria-label={tileLabel(i, t.x, t.y)}
			>
				<!-- Mirrored on every other tile so a run of forest doesn't read as wallpaper.
				     Parity of x+y rather than of the index, or the flips line up into stripes. -->
				<svg
					class="art"
					viewBox="0 0 32 32"
					style:transform={(t.x + t.y) % 2 ? 'scaleX(-1)' : null}
				>
					<use href="#i-{terrainAt(i)?.icon}" />
				</svg>
			</button>
		{/each}
		{#each world.buildings as b (b.id)}
			<svg
				class="over"
				viewBox="0 0 32 32"
				style="transform: translate({b.x * CELL}px, {b.y * CELL}px)"
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
				viewBox="0 0 32 32"
				style="transform: translate({o.destX * CELL}px, {o.destY * CELL}px)"
			>
				<use href="#i-{typeIcon(o.buildingTypeId!)}" />
			</svg>
		{/each}
		{#each world.characters as c (c.id)}
			<svg
				class="over"
				viewBox="0 0 32 32"
				style="transform: translate({at(c).x * CELL}px, {at(c).y * CELL}px)"
			>
				<use href="#i-pawn" />
			</svg>
		{/each}
	</div>
{:else}
	<p>Loading…</p>
{/if}

{#if gathering.length}
	<ul class="crew">
		{#each gathering as o (o.id)}
			<li>
				Gathering {resourceAt(o.destX, o.destY)} at {o.destX}, {o.destY}
				<button onclick={() => recall(o.id)}>Recall</button>
			</li>
		{/each}
	</ul>
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
		/* The containing block for .art — without it the art sizes against .grid and one tile's
		   mountain covers the map. */
		position: relative;
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
	/* Terrain art fills its tile and never eats the click — the whole cell stays the button. */
	.art {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		pointer-events: none;
	}
	/* Overlays are absolutely positioned and moved with transform: animating left/top would
	   relayout all 256 cells every frame. */
	.over {
		position: absolute;
		top: 0;
		left: 0;
		width: var(--cell);
		height: var(--cell);
		pointer-events: none;
	}
	/* outline, not border: a border would sit inside the box and shrink the 32px art. */
	.site {
		opacity: 0.45;
		outline: 2px dashed #4a3520;
		outline-offset: -2px;
	}
	.stock {
		display: flex;
		gap: 1rem;
		font-variant-numeric: tabular-nums;
	}
	.modes {
		display: flex;
		flex-wrap: wrap;
		gap: 1rem;
	}
	.price {
		color: #6b7280;
	}
	.crew {
		padding-left: 1.2rem;
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
