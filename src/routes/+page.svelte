<script lang="ts">
	import { onMount } from 'svelte';
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
		TILE_OCCUPIED: 'Something is already on that tile.',
		NO_IDLE_CHARACTER: 'Everyone is busy.'
	};

	let world = $state<WorldPayload | null>(null);
	let message = $state('');
	// Server time, advanced by rAF. Positions are *derived* from it rather than written by
	// the loop, so the very first paint is already correct — no frame has to fire first.
	let nowMs = $state(0);

	// The browser clock is never trusted directly — only its offset from the server's.
	let clockOffset = 0;

	function apply(payload: WorldPayload) {
		clockOffset = Date.now() - Date.parse(payload.now);
		world = payload;
		nowMs = Date.parse(payload.now);
	}

	let refreshing = false;
	async function refresh() {
		if (refreshing) return;
		refreshing = true;
		try {
			apply(await (await fetch('/api/world')).json());
		} finally {
			refreshing = false;
		}
	}

	// Operations we've already refetched for. Without this, an operation that came back still
	// in-progress would re-request every frame — a fetch storm at 60fps.
	const settled = new Set<number>();

	onMount(() => {
		let frame: number;

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

		return () => cancelAnimationFrame(frame);
	});

	async function order(x: number, y: number) {
		const buildingTypeId = world?.buildingTypes[0]?.id;
		if (buildingTypeId === undefined) return;

		const res = await fetch('/api/orders', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ x, y, buildingTypeId })
		});
		const body = await res.json();

		if (res.ok) {
			apply(body);
			message = '';
		} else {
			message = REASON_TEXT[body.reason as OrderReason] ?? body.reason;
		}
	}

	const tiles = Array.from({ length: GRID_SIZE * GRID_SIZE }, (_, i) => ({
		x: i % GRID_SIZE,
		y: Math.floor(i / GRID_SIZE)
	}));
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

{#if world}
	<div class="grid" style="--cell: {CELL}px; --size: {GRID_SIZE}">
		{#each tiles as t (t.x + ',' + t.y)}
			<button class="tile" onclick={() => order(t.x, t.y)} aria-label="Tile {t.x}, {t.y}"></button>
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
	{#if message}<p class="error">{message}</p>{/if}
{:else}
	<p>Loading…</p>
{/if}

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
		border: 1px solid #ddd;
		box-sizing: border-box;
		background: none;
		padding: 0;
		cursor: pointer;
	}
	.tile:hover {
		background: #eef;
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
</style>
