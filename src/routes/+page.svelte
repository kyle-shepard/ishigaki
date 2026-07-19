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

	onMount(() => {
		let frame: number;

		const tick = () => {
			nowMs = Date.now() - clockOffset;
			frame = requestAnimationFrame(tick);
		};

		(async () => {
			apply(await (await fetch('/api/world')).json());
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
