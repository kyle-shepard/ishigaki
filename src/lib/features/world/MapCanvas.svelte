<!--
	The terrain layer, and only terrain — buildings, roads, sites, dots and pawns stay DOM/SVG in
	+page.svelte, because they are dozens of nodes and every bit of code that draws, positions and
	labels them already works. Terrain was the part that had to stop being 2,304 (soon 16,384)
	buttons; one <canvas>, redrawn on scroll and zoom, is the whole fix.

	Owns: the canvas element, the rasterised art atlas, and hit testing (a click here becomes an
	`onselect(x, y)` call). Does not own: `cell`, which +page.svelte holds because every overlay's
	own position depends on it too, or the scroll offset, which the pane +page.svelte binds already
	carries and this component reads by finding that ancestor rather than by taking it as a fourth
	prop.
-->
<script lang="ts">
	import {
		GRID_SIZE,
		snappedEdge,
		TIER_CLOSE_MIN,
		TIER_DETAIL_MIN,
		TIER_MIDDLE_MIN,
		tileAt,
		type WorldPayload
	} from './world';

	type Props = {
		world: WorldPayload;
		// Accepted for interface symmetry with the selection ring +page.svelte draws as its own
		// absolutely-positioned div over this canvas — nothing drawn *here* depends on which tile is
		// selected, so this prop is never read below.
		selected: { x: number; y: number } | null;
		cell: number;
		onselect: (x: number, y: number) => void;
	};
	let { world, cell, onselect }: Props = $props();

	let canvasEl: HTMLCanvasElement | undefined = $state();
	let ctx: CanvasRenderingContext2D | null = null;
	// Found once the canvas exists rather than threaded through as a prop: everything read off it
	// (scrollLeft/scrollTop, client size, a place to hang a scroll listener) is read, never written.
	let pane: HTMLElement | null = null;

	const terrainById = $derived(new Map(world.terrainTypes.map((t) => [t.id, t])));
	const terrainAt = (i: number) => terrainById.get(world.terrain[i]);

	// Which terrain is *ground* rather than a landmark, by the icon name already on the wire. Meadow
	// and Forest are the two that tile across most of the map — about 70% of it between them — so
	// they are the two whose art becomes texture rather than detail once the cell gets small, and the
	// two that give it up first (see TIER_DETAIL_MIN). Everything absent from this set is something a
	// player navigates by, and keeps its mark all the way down to the far tier.
	//
	// Hills is deliberately *not* here. It is only ~4% of the map and it is the gradient that makes
	// elevation read as a slope rather than a wall, which is worth a few pixels; flip it if a band of
	// mounds turns out to be as noisy as the trees were.
	//
	// ponytail: a set in the renderer rather than a column on terrain_type, because it is a fact about
	// drawing and nothing on the server has an opinion about it. If it ever needs to be data — a
	// reskin choosing differently, say — it becomes a seeded boolean filtered the way
	// `player_buildable` already is.
	const GROUND_COVER = new Set(['meadow', 'forest']);

	// ---- The atlas ----------------------------------------------------------------------------
	// Three fixed rasterisations of each terrain symbol, quantised rather than keyed on the live
	// cell size: zoom is continuous, so a cache keyed on it would grow without bound as a player
	// zooms back and forth. Seven terrain icons × three sizes is at most 21 small canvases, built
	// lazily and never evicted.
	const ATLAS_SIZES = [8, 16, 32] as const;
	function atlasSizeFor(c: number): (typeof ATLAS_SIZES)[number] {
		if (c >= TIER_CLOSE_MIN) return 32;
		if (c >= 16) return 16;
		return 8;
	}
	const atlas = new Map<string, HTMLCanvasElement>();
	const rasterising = new Set<string>();

	// Rasterises one <symbol> from Sprites.svelte at a fixed pixel size. A symbol's own markup
	// references shared primitives by id (#p-tree, #p-rock), which only resolve inside a document —
	// a standalone SVG string needs those definitions riding along, or the art comes back blank.
	// Sprites.svelte has already rendered them into the live page by the time this ever mounts (it
	// sits above the map in +page.svelte), so this reads them out of the DOM rather than keeping a
	// second copy of the art anywhere.
	async function rasterise(icon: string, size: number): Promise<HTMLCanvasElement> {
		const out = document.createElement('canvas');
		out.width = size;
		out.height = size;
		const symbol = document.getElementById(`i-${icon}`);
		// An unknown icon draws nothing — the same fallback the old <use href> gave a missing key.
		if (!symbol) return out;
		const primitives = Array.from(document.querySelectorAll('defs [id^="p-"]'))
			.map((el) => el.outerHTML)
			.join('');
		const svg =
			`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
			`viewBox="0 0 32 32"><defs>${primitives}</defs>${symbol.innerHTML}</svg>`;
		const img = new Image();
		const loaded = new Promise<void>((resolve, reject) => {
			img.onload = () => resolve();
			img.onerror = () => reject(new Error(`atlas rasterise failed for #i-${icon}`));
		});
		img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
		await loaded;
		out.getContext('2d')!.drawImage(img, 0, 0, size, size);
		return out;
	}

	// Built lazily on first use. Returns null while a rasterisation is still in flight, and the
	// caller's fillRect underneath is left standing for that one frame — cheaper than blocking the
	// draw loop on an image load, and invisible past the first paint of a given icon/size pair.
	function atlasTile(icon: string, size: number): HTMLCanvasElement | null {
		const key = `${icon}:${size}`;
		const hit = atlas.get(key);
		if (hit) return hit;
		if (!rasterising.has(key)) {
			rasterising.add(key);
			rasterise(icon, size)
				.then((canvas) => {
					atlas.set(key, canvas);
					draw();
				})
				.catch(() => {
					/* Missing art stays flat colour; nothing else on the map depends on this settling. */
				})
				.finally(() => rasterising.delete(key));
		}
		return null;
	}

	// ---- The overview bitmap -------------------------------------------------------------------
	// One pixel per tile, flat colour only — the same picture the per-cell loop below paints once
	// `drawArt` is false (cell < TIER_MIDDLE_MIN, no art, no sprites). That's not a coincidence: it's
	// the threshold this reuses rather than inventing a new one — below TIER_MIDDLE_MIN the per-cell
	// loop and this bitmap are pixel-for-pixel the same picture, so swapping to one `drawImage` costs
	// no fidelity and buys back the whole far tier. At or above it, sprites draw detail this 1px/tile
	// bitmap can't hold, so the per-cell loop keeps running there.
	//
	// Built once per content version (world.worldVersion — terrain only moves on a reseed) rather
	// than once per payload: a payload is replaced on every heartbeat, but the terrain under it is
	// almost always the same array. 1448×1448 = 2,096,704 px × 4 bytes (RGBA) ≈ 8.4 MB — comfortably
	// under Safari's 16,777,216-pixel ceiling for a single canvas (2D or WebGL backing store), which
	// is the real limit worth naming: a much bigger future world (GRID_SIZE² over that count) cannot
	// keep doing this as one canvas.
	//
	// ponytail: a one-level pyramid, built synchronously on the main thread the first time the far
	// tier is reached. The real upgrade is #21 architecture C — a pre-rendered image pyramid served
	// from blob storage — which is also what lifts the 16.7M-pixel ceiling off the bitmap itself.
	let overview: { version: string; canvas: OffscreenCanvas | HTMLCanvasElement } | null = null;

	function buildOverview(w: WorldPayload): OffscreenCanvas | HTMLCanvasElement {
		const rgb = new Map<number, [number, number, number]>(
			w.terrainTypes.map((t) => [
				t.id,
				[
					parseInt(t.color.slice(1, 3), 16),
					parseInt(t.color.slice(3, 5), 16),
					parseInt(t.color.slice(5, 7), 16)
				]
			])
		);
		const data = new Uint8ClampedArray(GRID_SIZE * GRID_SIZE * 4);
		for (let i = 0; i < w.terrain.length; i++) {
			const [r, g, b] = rgb.get(w.terrain[i]) ?? [0, 0, 0];
			const o = i * 4;
			data[o] = r;
			data[o + 1] = g;
			data[o + 2] = b;
			data[o + 3] = 255;
		}
		// OffscreenCanvas where it exists (never attached to the DOM, and this never needs to be);
		// a plain <canvas> is exactly as good as a blit source for the browsers that lack it.
		const canvas =
			typeof OffscreenCanvas !== 'undefined'
				? new OffscreenCanvas(GRID_SIZE, GRID_SIZE)
				: document.createElement('canvas');
		canvas.width = GRID_SIZE;
		canvas.height = GRID_SIZE;
		const octx = canvas.getContext('2d') as
			CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
		octx.putImageData(new ImageData(data, GRID_SIZE, GRID_SIZE), 0, 0);
		return canvas;
	}

	// ---- Drawing --------------------------------------------------------------------------------
	let rafPending = false;
	// Coalesces the flurry of native 'scroll' events a drag or a momentum scroll fires into one
	// redraw a frame — not the character-position rAF tick (that one moves DOM overlays and never
	// touches this canvas), just this canvas keeping up with its own scroll listener.
	function scheduleDraw() {
		if (rafPending) return;
		rafPending = true;
		requestAnimationFrame(() => {
			rafPending = false;
			draw();
		});
	}

	function draw() {
		if (!ctx || !pane) return;
		const w = pane.clientWidth;
		const h = pane.clientHeight;
		ctx.clearRect(0, 0, w, h);
		const scrollLeft = pane.scrollLeft;
		const scrollTop = pane.scrollTop;
		const firstX = Math.max(0, Math.floor(tileAt(scrollLeft, 0, cell)));
		const firstY = Math.max(0, Math.floor(tileAt(scrollTop, 0, cell)));
		const lastX = Math.min(GRID_SIZE - 1, Math.floor(tileAt(scrollLeft, w, cell)));
		const lastY = Math.min(GRID_SIZE - 1, Math.floor(tileAt(scrollTop, h, cell)));
		// The far tier's whole point: past this, the art costs more than it says. TIER_MIDDLE_MIN is
		// the same number +page.svelte derives its own tier from, so "far is flat colour" is one
		// shared threshold rather than a fact repeated in two files that could disagree.
		const drawArt = cell >= TIER_MIDDLE_MIN;
		// Reset every frame — the overview branch below turns this off for its flat-colour blit, and
		// it must not leak into a later frame that draws sprites and wants the default scaling back.
		ctx.imageSmoothingEnabled = drawArt;

		if (!drawArt) {
			// The far tier, at any zoom the fitted floor reaches: one blit instead of up to 2,096,704
			// fillRects. See the overview bitmap's own header comment for why this is the same picture
			// the per-cell loop below would have painted.
			if (!overview || overview.version !== world.worldVersion) {
				overview = { version: world.worldVersion, canvas: buildOverview(world) };
			}
			const dx0 = snappedEdge(firstX, cell, scrollLeft);
			const dy0 = snappedEdge(firstY, cell, scrollTop);
			const dx1 = snappedEdge(lastX + 1, cell, scrollLeft);
			const dy1 = snappedEdge(lastY + 1, cell, scrollTop);
			// Nearest-neighbour, not smoothed (set above): the source is already one flat colour per
			// tile, and blurring the upscale would just soften the tile boundaries this fix keeps crisp.
			ctx.drawImage(
				overview.canvas,
				firstX,
				firstY,
				lastX - firstX + 1,
				lastY - firstY + 1,
				dx0,
				dy0,
				dx1 - dx0,
				dy1 - dy0
			);
		} else {
			// Ground cover goes flat before landmarks do — see TIER_DETAIL_MIN. Pulled out of the loop
			// because it is the same answer for all 16,384 tiles.
			const detailed = cell >= TIER_DETAIL_MIN;
			const size = atlasSizeFor(cell);
			for (let y = firstY; y <= lastY; y++) {
				for (let x = firstX; x <= lastX; x++) {
					const t = terrainAt(y * GRID_SIZE + x);
					if (!t) continue;
					// Snapped from each tile's *next* edge, not `px + cell` — see snappedEdge's own doc.
					// A neighbour computes its own left edge from the same `x`/`x + 1` coordinate, so the
					// two can never land on different sides of a half-pixel and leave the seam Fault 2 was.
					const x0 = snappedEdge(x, cell, scrollLeft);
					const y0 = snappedEdge(y, cell, scrollTop);
					const x1 = snappedEdge(x + 1, cell, scrollLeft);
					const y1 = snappedEdge(y + 1, cell, scrollTop);
					ctx.fillStyle = t.color;
					ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
					if (!t.icon) continue;
					// The ground you walk on gives up its art first; the things you navigate by keep theirs.
					if (!detailed && GROUND_COVER.has(t.icon)) continue;
					const img = atlasTile(t.icon, size);
					if (!img) continue;
					// Mirrored on every other tile by parity of x+y, the same rule the DOM version drew
					// with — so a run of forest still doesn't read as wallpaper now that canvas paints it.
					// Same snapped rect as the fillRect above, so the art can't drift off its own tile.
					if ((x + y) % 2) {
						ctx.save();
						ctx.translate(x1, y0);
						ctx.scale(-1, 1);
						ctx.drawImage(img, 0, 0, x1 - x0, y1 - y0);
						ctx.restore();
					} else {
						ctx.drawImage(img, x0, y0, x1 - x0, y1 - y0);
					}
				}
			}
		}
		// The reach circle — the sphere of influence a Marketplace projects, at the same threshold
		// `drawArt` already turns art off at: below it (the far tier) individual tiles stop being the
		// point, and a circle a few pixels wide would tell you nothing an arc at this scale can. Same
		// `withinReach` arithmetic the server gate enforces, so the line drawn and the line enforced
		// are the same circle rather than two implementations that could quietly disagree.
		if (drawArt && world.reach) {
			const cx = (world.reach.x + 0.5) * cell - scrollLeft;
			const cy = (world.reach.y + 0.5) * cell - scrollTop;
			ctx.beginPath();
			ctx.arc(cx, cy, world.reach.radius * cell, 0, Math.PI * 2);
			ctx.strokeStyle = '#1d4ed8';
			ctx.lineWidth = 2;
			ctx.stroke();
		}
	}

	// Canvas sized to the pane's own client box × devicePixelRatio, or it is blurry on every retina
	// display — CSS stretches the backing store to the pane's CSS size, and ctx.scale(dpr, dpr) is
	// what makes drawing commands still speak in CSS pixels rather than physical ones.
	function resize() {
		if (!canvasEl || !pane) return;
		const dpr = window.devicePixelRatio || 1;
		canvasEl.width = pane.clientWidth * dpr;
		canvasEl.height = pane.clientHeight * dpr;
		ctx = canvasEl.getContext('2d');
		ctx?.scale(dpr, dpr);
		draw();
	}

	// The one click target the whole map now has. Converts the click's pane-relative pixel to a
	// tile with the same `tileAt` the zoom maths uses, so "where you clicked" and "where the map
	// thinks you clicked" can never read two different coordinate systems.
	function handleClick(e: MouseEvent) {
		if (!canvasEl || !pane) return;
		const rect = canvasEl.getBoundingClientRect();
		const x = Math.floor(tileAt(pane.scrollLeft, e.clientX - rect.left, cell));
		const y = Math.floor(tileAt(pane.scrollTop, e.clientY - rect.top, cell));
		if (x < 0 || y < 0 || x >= GRID_SIZE || y >= GRID_SIZE) return;
		onselect(x, y);
	}

	// Finds its scrolling ancestor once the canvas exists, sizes itself to it, and redraws on that
	// ancestor's own resize and scroll — the only two things that ever move what this canvas has to
	// show, short of the payload itself changing (the effect below).
	$effect(() => {
		if (!canvasEl) return;
		pane = canvasEl.closest('.map-pane');
		if (!pane) return;
		resize();
		const ro = new ResizeObserver(resize);
		ro.observe(pane);
		const onScroll = () => scheduleDraw();
		pane.addEventListener('scroll', onScroll);
		return () => {
			ro.disconnect();
			pane?.removeEventListener('scroll', onScroll);
		};
	});

	// Redraws on a payload swap (a fresh realm changes every terrain id) or a zoom step. Deliberately
	// not on the rAF tick that interpolates character positions — those are DOM overlays this canvas
	// never touches, and redrawing 2,304+ cells sixty times a second for a dot that isn't even on it
	// would be the whole regression this component exists to avoid.
	$effect(() => {
		world;
		cell;
		draw();
	});
</script>

<canvas bind:this={canvasEl} onclick={handleClick} aria-hidden="true"></canvas>

<style>
	canvas {
		/* Pinned to the same viewport rect as .map-pane itself (see its own `inset` rule), so it
		   never scrolls with the content — only what's drawn onto it changes, on the pane's own
		   scroll event. This is what keeps the canvas at a fixed, small size regardless of how big
		   the world is: the map-client epic's actual complaint was 2,304+ DOM nodes, not 2,304+
		   cells of drawing, and a full-world canvas would have started paying the second cost too. */
		position: fixed;
		inset: var(--header-h) 0 0 0;
		display: block;
		cursor: pointer;
	}
</style>
