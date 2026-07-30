<!--
	The whole world, at a glance, in a fixed corner of the map pane. Draws the same overview bitmap
	MapCanvas's far tier already builds (overview.ts owns it now, not either component) — the point of
	this file is the viewport rectangle and the click-to-travel, not a second picture of the terrain.

	Sizes itself off `.map-pane`, the same way MapCanvas finds its own scroll box, rather than taking
	scroll/size as props: both components read the one ancestor rather than +page.svelte threading a
	third copy of the pane's own state down to each of them.
-->
<script lang="ts">
	import { GRID_SIZE, minimapToWorld, worldToMinimap, type WorldPayload } from './world';
	import { overviewFor } from './overview';

	type Props = {
		world: WorldPayload;
		cell: number;
		/** Centres the main map here — `centreOn` in +page.svelte, which already clamps at the edges. */
		onnavigate: (x: number, y: number) => void;
	};
	let { world, cell, onnavigate }: Props = $props();

	// A fixed square rather than something that scales with the window: it is a reference object
	// ("here is the whole world"), not a second viewport competing with the main one for space.
	const SIZE = 200;

	let canvasEl: HTMLCanvasElement | undefined = $state();
	let ctx: CanvasRenderingContext2D | null = null;
	let pane: HTMLElement | null = null;
	// Mirrors the main view's own scroll box. Read on the pane's scroll/resize events rather than on
	// every animation frame — nothing here needs to move faster than the main view's own redraw does.
	let scrollLeft = $state(0);
	let scrollTop = $state(0);
	let paneW = $state(0);
	let paneH = $state(0);

	function sync() {
		if (!pane) return;
		scrollLeft = pane.scrollLeft;
		scrollTop = pane.scrollTop;
		paneW = pane.clientWidth;
		paneH = pane.clientHeight;
		draw();
	}

	function draw() {
		if (!ctx) return;
		ctx.clearRect(0, 0, SIZE, SIZE);
		// Nearest-neighbour: the source is one flat colour per tile already, and smoothing a 1448px
		// bitmap down to 200px would just blur terrain that is already as coarse as it gets.
		ctx.imageSmoothingEnabled = false;
		ctx.drawImage(overviewFor(world), 0, 0, GRID_SIZE, GRID_SIZE, 0, 0, SIZE, SIZE);

		// Settlements, in the same two colours +page.svelte's own far-tier pins use for "yours" versus
		// "everyone else's" (see its `.pin`/`.pin.foreign` rule) — one convention for "this is mine",
		// not a second one invented here.
		for (const s of world.settlements) {
			ctx.fillStyle = s.playerId === world.playerId ? '#1d4ed8' : '#8a8a8a';
			ctx.beginPath();
			ctx.arc(worldToMinimap(s.x, SIZE), worldToMinimap(s.y, SIZE), 2.5, 0, Math.PI * 2);
			ctx.fill();
		}

		// The viewport rectangle — the whole reason this component exists. At a normal working zoom
		// it is a few pixels across on a 200px square, which is the fact nothing else on the page says
		// out loud: the main view is showing a sliver of this.
		if (cell > 0) {
			const rx = worldToMinimap(scrollLeft / cell, SIZE);
			const ry = worldToMinimap(scrollTop / cell, SIZE);
			const rw = worldToMinimap(paneW / cell, SIZE);
			const rh = worldToMinimap(paneH / cell, SIZE);
			ctx.strokeStyle = '#1d4ed8';
			ctx.lineWidth = 1.5;
			ctx.strokeRect(rx, ry, rw, rh);
		}
	}

	function resize() {
		if (!canvasEl) return;
		const dpr = window.devicePixelRatio || 1;
		canvasEl.width = SIZE * dpr;
		canvasEl.height = SIZE * dpr;
		ctx = canvasEl.getContext('2d');
		ctx?.scale(dpr, dpr);
		draw();
	}

	$effect(() => {
		if (!canvasEl) return;
		pane = canvasEl.closest('.map-pane');
		if (!pane) return;
		resize();
		sync();
		const ro = new ResizeObserver(() => {
			resize();
			sync();
		});
		ro.observe(pane);
		const onScroll = () => sync();
		pane.addEventListener('scroll', onScroll);
		return () => {
			ro.disconnect();
			pane?.removeEventListener('scroll', onScroll);
		};
	});

	// Redraws on a payload swap or a zoom/pan step the pane's own scroll listener above doesn't
	// already cover — cell changes the rectangle's size without necessarily firing a scroll event.
	$effect(() => {
		world;
		cell;
		draw();
	});

	// Click, or click-and-drag, to travel: every pointer position while the button is down is a place
	// to go, not just the first one. Pointer capture keeps the drag tracking even once the cursor
	// leaves this 200px square mid-drag.
	let dragging = false;
	function navigate(e: PointerEvent) {
		if (!canvasEl) return;
		const rect = canvasEl.getBoundingClientRect();
		const x = minimapToWorld(e.clientX - rect.left, SIZE);
		const y = minimapToWorld(e.clientY - rect.top, SIZE);
		onnavigate(x, y);
	}
	// Stopped from bubbling at every stage: this sits inside `.map-pane`, which owns its own
	// pointerdown/move/up for panning the main view, and a click meant for the 200px square must not
	// also start a drag of the map underneath it.
	function down(e: PointerEvent) {
		e.stopPropagation();
		dragging = true;
		canvasEl?.setPointerCapture(e.pointerId);
		navigate(e);
	}
	function move(e: PointerEvent) {
		e.stopPropagation();
		if (!dragging) return;
		navigate(e);
	}
	function up(e: PointerEvent) {
		e.stopPropagation();
		dragging = false;
	}
</script>

<canvas
	bind:this={canvasEl}
	class="minimap"
	onpointerdown={down}
	onpointermove={move}
	onpointerup={up}
	onpointercancel={up}
	aria-hidden="true"
></canvas>

<style>
	.minimap {
		/* Fixed to the window, not the pane's own scroll — it is a corner instrument, not part of
		   the terrain it is showing a picture of. */
		position: fixed;
		left: 12px;
		bottom: 12px;
		width: 200px;
		height: 200px;
		border: 1px solid var(--border);
		border-radius: 4px;
		box-shadow: 0 2px 12px rgb(0 0 0 / 0.25);
		cursor: pointer;
		/* Above the terrain canvas and the DOM overlays (.over sits at 2), below the inspector panel
		   (10) — it must read as sitting on the map, not fighting the panel for the same layer. */
		z-index: 5;
		/* Own gesture, not the pane's native scroll/pinch — see the stopPropagation calls above for
		   why the pane must not also react to the same pointer. */
		touch-action: none;
	}
</style>
