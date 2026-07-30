// The whole-world bitmap MapCanvas's far tier and the minimap both draw from — one shared module
// rather than two copies, because a minimap that mounted after MapCanvas and rebuilt this itself
// would be exactly the second implementation this project keeps having to notice and undo.
//
// **Downsampled, not one pixel per tile.** It used to be exactly one pixel per tile, which was 8.4 MB
// of RGBA at 1448×1448 and already carried a note that a much bigger world could not keep doing it:
// a single canvas is capped at 16,777,216 pixels in Safari (2D or WebGL backing store), and the
// continent is 47,775,744 tiles. So the overview is a fixed OVERVIEW_SIZE square regardless of how
// big the world gets, and the world only decides how many tiles each pixel stands for. The cap is
// now a thing this cannot reach rather than a thing to keep an eye on.
//
// It is built from the *generator* rather than from a terrain array on the wire — there isn't one
// any more (see world.ts's `WorldStatic`). That also means this no longer needs a payload at all
// beyond the terrain colours, and it is keyed on `worldVersion` exactly as before, because terrain
// still only moves on a reseed.
import { GRID_SIZE, type WorldPayload } from './world';
import { terrainCharDirect } from './worldgen';

// One side of the overview bitmap, in pixels. 1024² is 1.05M pixels — 4.2 MB of RGBA, an eighth of
// what the old per-tile canvas cost at a world 23× smaller, and comfortably inside every browser's
// single-canvas limit. At the continent one pixel is a 6.75-tile block, which is the right grain for
// a picture whose whole job is "where is the coast, where are the ranges, where is everyone".
const OVERVIEW_SIZE = 1024;

let cached: { version: string; canvas: OffscreenCanvas | HTMLCanvasElement } | null = null;

function build(w: WorldPayload): OffscreenCanvas | HTMLCanvasElement {
	const rgb = new Map<string, [number, number, number]>(
		w.terrainTypes.map((t) => [
			t.char,
			[
				parseInt(t.color.slice(1, 3), 16),
				parseInt(t.color.slice(3, 5), 16),
				parseInt(t.color.slice(5, 7), 16)
			]
		])
	);
	const data = new Uint8ClampedArray(OVERVIEW_SIZE * OVERVIEW_SIZE * 4);
	const stride = GRID_SIZE / OVERVIEW_SIZE;
	for (let py = 0; py < OVERVIEW_SIZE; py++)
		for (let px = 0; px < OVERVIEW_SIZE; px++) {
			// Point-sampled, and `terrainCharDirect` rather than the chunk-cached reader: at this
			// stride each sample lands in a different chunk, so going through the cache would build
			// 4,096 tiles to read one of them and evict whatever the map view is using to do it.
			const x = Math.min(GRID_SIZE - 1, Math.floor(px * stride));
			const y = Math.min(GRID_SIZE - 1, Math.floor(py * stride));
			const [r, g, b] = rgb.get(terrainCharDirect(x, y)) ?? [0, 0, 0];
			const o = (py * OVERVIEW_SIZE + px) * 4;
			data[o] = r;
			data[o + 1] = g;
			data[o + 2] = b;
			data[o + 3] = 255;
		}
	// OffscreenCanvas where it exists (never attached to the DOM, and this never needs to be); a
	// plain <canvas> is exactly as good as a blit source for the browsers that lack it.
	const canvas =
		typeof OffscreenCanvas !== 'undefined'
			? new OffscreenCanvas(OVERVIEW_SIZE, OVERVIEW_SIZE)
			: document.createElement('canvas');
	canvas.width = OVERVIEW_SIZE;
	canvas.height = OVERVIEW_SIZE;
	const octx = canvas.getContext('2d') as
		| CanvasRenderingContext2D
		| OffscreenCanvasRenderingContext2D;
	octx.putImageData(new ImageData(data, OVERVIEW_SIZE, OVERVIEW_SIZE), 0, 0);
	return canvas;
}

/**
 * The shared overview bitmap for `world`'s current content version — built once and handed back to
 * every later caller (MapCanvas's far tier, the minimap) until `worldVersion` moves.
 *
 * **Its pixels are not tiles.** Callers used to pass source rectangles in tile coordinates, which
 * worked only because the bitmap happened to be exactly GRID_SIZE across. It isn't any more, so
 * `overviewScale` below is the conversion, and both consumers go through it.
 */
export function overviewFor(world: WorldPayload): OffscreenCanvas | HTMLCanvasElement {
	if (!cached || cached.version !== world.worldVersion) {
		cached = { version: world.worldVersion, canvas: build(world) };
	}
	return cached.canvas;
}

/**
 * Overview pixels per world tile — what a caller multiplies a tile coordinate by to get a source
 * coordinate in the bitmap `overviewFor` returns. Below 1 (each pixel covers several tiles), which
 * is exactly the fact that used to be 1 and is no longer.
 */
export const overviewScale = OVERVIEW_SIZE / GRID_SIZE;
