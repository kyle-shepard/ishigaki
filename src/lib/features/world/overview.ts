// The whole-world bitmap MapCanvas's far tier and the minimap both draw from — one shared module
// rather than two copies, because a minimap that mounted after MapCanvas and rebuilt this itself
// would be exactly the second implementation this project keeps having to notice and undo.
//
// One pixel per tile, flat colour only — the same picture MapCanvas's per-cell loop paints once art
// stops drawing (see its own TIER_MIDDLE_MIN comment). Built once per content version
// (world.worldVersion — terrain only moves on a reseed) rather than once per payload or once per
// component, and cached at module scope so every consumer on the page shares the one bitmap.
//
// 1448×1448 = 2,096,704 px × 4 bytes (RGBA) ≈ 8.4 MB — comfortably under Safari's 16,777,216-pixel
// ceiling for a single canvas (2D or WebGL backing store), which is the real limit worth naming: a
// much bigger future world (GRID_SIZE² over that count) cannot keep doing this as one canvas.
//
// ponytail: a one-level pyramid, built synchronously on the main thread the first time anything on
// the page needs it. The real upgrade is #21 architecture C — a pre-rendered image pyramid served
// from blob storage — which is also what lifts the 16.7M-pixel ceiling off the bitmap itself.
import { GRID_SIZE, type WorldPayload } from './world';

let cached: { version: string; canvas: OffscreenCanvas | HTMLCanvasElement } | null = null;

function build(w: WorldPayload): OffscreenCanvas | HTMLCanvasElement {
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
	// OffscreenCanvas where it exists (never attached to the DOM, and this never needs to be); a
	// plain <canvas> is exactly as good as a blit source for the browsers that lack it.
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

/**
 * The shared overview bitmap for `world`'s current content version — built once and handed back to
 * every later caller (MapCanvas's far tier, the minimap) until `worldVersion` moves.
 */
export function overviewFor(world: WorldPayload): OffscreenCanvas | HTMLCanvasElement {
	if (!cached || cached.version !== world.worldVersion) {
		cached = { version: world.worldVersion, canvas: build(world) };
	}
	return cached.canvas;
}
