// Run: npm run atlas — writes PNGs of the generated world to .atlas/ (gitignored).
//
// `npm run map` prints the world as coloured text, which is the right tool while tuning a threshold
// and the wrong one for answering "does this look like a place". This draws the same generator at
// the same colours the game paints tiles with, so what lands in an image viewer is what the map
// will look like.
//
// ponytail: PNG is encoded here, in about forty lines, rather than by adding an image dependency
// for a script that runs by hand. Deflate comes from node:zlib; the rest is four chunks and a CRC.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { COARSE, starts, terrainCharDirect, terrainWindow } from '../src/lib/features/world/worldgen.ts';
import { GRID_SIZE } from '../src/lib/features/world/world.ts';

// The palette seed.ts gives terrain_type.color — the same colours MapCanvas fills a tile with, so
// this is the game's own map rather than a second opinion about it.
const COLOR: Record<string, [number, number, number]> = {
	'.': [0xa3, 0xc7, 0x6d], // Meadow
	f: [0x5c, 0x94, 0x48], // Forest
	c: [0xd0, 0x8b, 0x4f], // Clay pit
	s: [0xb0, 0xb3, 0xb8], // Stone outcrop
	i: [0x7a, 0x3b, 0x2e], // Iron vein
	h: [0x93, 0xa1, 0x5e], // Hills
	m: [0x6b, 0x62, 0x59], // Mountain
	w: [0x2f, 0x6f, 0xb5] // Water
};

const CRC = Int32Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c;
});
const crc32 = (buf: Buffer) => {
	let c = 0xffffffff;
	for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
};
function chunk(type: string, data: Buffer): Buffer {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body));
	return Buffer.concat([len, body, crc]);
}
/** `rgb` is width*height*3, row-major. */
function png(width: number, height: number, rgb: Uint8Array): Buffer {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 2; // colour type: truecolour
	// Each scanline is prefixed with its filter byte; 0 is "none", which deflate handles fine here.
	const raw = Buffer.alloc(height * (1 + width * 3));
	for (let y = 0; y < height; y++) {
		const o = y * (1 + width * 3);
		raw[o] = 0;
		Buffer.from(rgb.buffer, rgb.byteOffset + y * width * 3, width * 3).copy(raw, o + 1);
	}
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdr),
		chunk('IDAT', deflateSync(raw, { level: 9 })),
		chunk('IEND', Buffer.alloc(0))
	]);
}

const put = (rgb: Uint8Array, w: number, x: number, y: number, c: [number, number, number]) => {
	const o = (y * w + x) * 3;
	rgb[o] = c[0];
	rgb[o + 1] = c[1];
	rgb[o + 2] = c[2];
};

mkdirSync('.atlas', { recursive: true });
const found = starts();

// ---- The whole continent -----------------------------------------------------------------------
// Downsampled by scanning each block rather than point-sampling it, because a river is one tile
// wide: at a stride of 4 a point sample hits a given channel one time in four and the drainage
// network simply disappears from the overview. Water wins its block outright and every other
// terrain takes the majority — the same "landmarks keep their shape, ground cover becomes colour"
// rule MapCanvas's middle zoom tier already follows.
const STRIDE = 4;
const size = Math.floor(GRID_SIZE / STRIDE);
const world = new Uint8Array(size * size * 3);
let t = Date.now();
for (let py = 0; py < size; py++) {
	for (let px = 0; px < size; px++) {
		const tally = new Map<string, number>();
		let wet = false;
		for (let j = 0; j < STRIDE && !wet; j++)
			for (let i = 0; i < STRIDE; i++) {
				const c = terrainCharDirect(px * STRIDE + i, py * STRIDE + j);
				if (c === 'w') {
					wet = true;
					break;
				}
				tally.set(c, (tally.get(c) ?? 0) + 1);
			}
		const best = wet
			? 'w'
			: [...tally.entries()].reduce((a, b) => (b[1] > a[1] ? b : a))[0];
		put(world, size, px, py, COLOR[best]);
	}
}
// Every claimed opening, as a small dark ring — 100 of them is the thing worth seeing at this zoom.
for (const s of found) {
	const cx = Math.round(s.hamletX / STRIDE);
	const cy = Math.round(s.hamletY / STRIDE);
	for (let a = 0; a < 64; a++) {
		const x = cx + Math.round(5 * Math.cos((a / 64) * 2 * Math.PI));
		const y = cy + Math.round(5 * Math.sin((a / 64) * 2 * Math.PI));
		if (x >= 0 && y >= 0 && x < size && y < size) put(world, size, x, y, [0x1a, 0x14, 0x10]);
	}
}
writeFileSync('.atlas/world.png', png(size, size, world));
console.log(`.atlas/world.png — ${size}x${size}, whole continent at ${STRIDE}:1, ${Date.now() - t} ms`);

// ---- One domain, 1:1 ---------------------------------------------------------------------------
// Centred on the opening closest to the map's centre, at one pixel per tile, so a river is a river
// and the reach a realm actually grows into is legible against the ground around it.
const DETAIL = 900;
const home = found[0];
const ox = Math.max(0, Math.min(GRID_SIZE - DETAIL, home.hamletX - DETAIL / 2));
const oy = Math.max(0, Math.min(GRID_SIZE - DETAIL, home.hamletY - DETAIL / 2));
t = Date.now();
const rows = terrainWindow(ox, oy, DETAIL);
const detail = new Uint8Array(DETAIL * DETAIL * 3);
for (let y = 0; y < DETAIL; y++)
	for (let x = 0; x < DETAIL; x++) put(detail, DETAIL, x, y, COLOR[rows[y][x]] ?? [0, 0, 0]);
// The mature reach — the ~5.5 km circle a realm grown to the top of the ladder claims. Drawn so the
// wilderness between openings has something to be measured against.
for (const s of found) {
	const cx = s.marketX - ox;
	const cy = s.marketY - oy;
	for (let a = 0; a < 4096; a++) {
		const x = cx + Math.round(138 * Math.cos((a / 4096) * 2 * Math.PI));
		const y = cy + Math.round(138 * Math.sin((a / 4096) * 2 * Math.PI));
		if (x >= 0 && y >= 0 && x < DETAIL && y < DETAIL) put(detail, DETAIL, x, y, [0xff, 0xf4, 0xd6]);
	}
	for (let dy = -2; dy <= 2; dy++)
		for (let dx = -2; dx <= 2; dx++) {
			const x = s.hamletX - ox + dx;
			const y = s.hamletY - oy + dy;
			if (x >= 0 && y >= 0 && x < DETAIL && y < DETAIL) put(detail, DETAIL, x, y, [0x1a, 0x14, 0x10]);
		}
}
writeFileSync('.atlas/domain.png', png(DETAIL, DETAIL, detail));
console.log(
	`.atlas/domain.png — ${DETAIL}x${DETAIL} at 1:1, centred on the opening at ` +
		`(${home.hamletX}, ${home.hamletY}), ${Date.now() - t} ms`
);
console.log(
	`world ${GRID_SIZE}x${GRID_SIZE} = ${GRID_SIZE * GRID_SIZE} tiles · coarse ${Math.ceil(GRID_SIZE / COARSE)}^2 · ${found.length} openings`
);
