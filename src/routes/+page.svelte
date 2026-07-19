<script lang="ts">
	import { onMount } from 'svelte';
	import { GRID_SIZE, type WorldPayload } from '$lib/features/world/world';

	const CELL = 32;

	let world = $state<WorldPayload | null>(null);

	onMount(async () => {
		world = await (await fetch('/api/world')).json();
	});

	const tiles = Array.from({ length: GRID_SIZE * GRID_SIZE }, (_, i) => i);
	const typeName = (id: number) =>
		world?.buildingTypes.find((t) => t.id === id)?.displayName ?? '?';
</script>

<h1>石垣 Ishigaki</h1>

{#if world}
	<div class="grid" style="--cell: {CELL}px; --size: {GRID_SIZE}">
		{#each tiles as i (i)}
			<div class="tile"></div>
		{/each}
		{#each world.buildings as b (b.id)}
			<div class="building" style="transform: translate({b.x * CELL}px, {b.y * CELL}px)">
				{typeName(b.buildingTypeId).slice(0, 1)}
			</div>
		{/each}
		{#each world.characters as c (c.id)}
			<div class="dot" style="transform: translate({c.x * CELL}px, {c.y * CELL}px)"></div>
		{/each}
	</div>
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
</style>
