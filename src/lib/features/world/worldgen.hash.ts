// The two hashes that describe a generated world, kept out of worldgen.ts so that module stays
// importable by the browser.
//
// worldgen.ts is client code now — the map computes its own terrain rather than being shipped it —
// and `node:crypto` has no business in a client module graph. Splitting these two functions out is
// what makes that guarantee structural rather than a bet on the bundler tree-shaking an unused
// import away.
import { createHash } from 'node:crypto';
import { coarseFingerprint, terrainCharDirect } from './worldgen.ts';

/**
 * A content fingerprint for this generator: the same seed, the same grid size and the same source
 * text of this file hash to the same sixteen hex characters, forever — never a function of when
 * anything ran. `scripts/seed.ts` is the only caller; it reads this file's own text once (the
 * generator's *code* is the content — a threshold tweak has to roll the version) and hands it in
 * here rather than this module reading itself off disk, so the function stays pure over its three
 * inputs and `npm test` can pin it without touching the filesystem.
 *
 * Sixteen hex characters of sha256, not the whole digest — this lands in a game_config column and
 * a URL segment, where a collision would need someone to engineer one, not stumble into it.
 */
export function contentVersion(seed: number, gridSize: number, generatorSource: string): string {
	return createHash('sha256')
		.update(`${seed}:${gridSize}:${generatorSource}`)
		.digest('hex')
		.slice(0, 16);
}

/**
 * How far apart the sampled tiles are in `terrainDataHash` below. 313 is prime and coprime with
 * COARSE and with any plausible GRID_SIZE, so the walk never lands on the same offset within a
 * coarse cell twice in a row and cannot alias with the river tracing's own period.
 */
const HASH_STRIDE = 313;

/**
 * A hash of the generated terrain's *data* — the chars themselves — rather than of the source text
 * that produced it (`contentVersion`'s job). The two answer different questions: `contentVersion`
 * keys the CDN/in-process caches ("has anything about the generator changed"), while this is the
 * load-bearing safety check world.server.ts's `loadStaticWorld` runs before it will serve a
 * generated world in place of a database read — "is the world I would generate right now provably
 * the one `tile_stock`, `building` and `settlement` rows already refer to".
 *
 * **Sampled, not exhaustive, and that is a real weakening.** It used to hash every tile, which was
 * a genuine proof of equality; at 47.8M tiles that is a minute of generation on a path that runs
 * per lambda cold start, which is a cost nobody would pay and so a check that would end up deleted
 * rather than weakened. Every `HASH_STRIDE`-th tile in row-major order is ~152,000 samples spread
 * across the whole map, plus the coarse grid's own drainage tree and accumulation folded in whole —
 * so any change to the hydrology is caught exactly, and a change to the fine classification is
 * caught unless it moves fewer than one tile in 313 and misses every sample. A threshold edit moves
 * millions; that is the failure this exists to catch, and it still catches it.
 */
export function terrainDataHash(gridSize: number): string {
	const hash = createHash('sha256');
	// The coarse grid entire, not sampled: it is small, and it is where every non-local decision the
	// generator makes actually lives — see `coarseFingerprint`.
	hash.update(coarseFingerprint());
	const total = gridSize * gridSize;
	let chunk = '';
	for (let i = 0; i < total; i += HASH_STRIDE) {
		// `terrainCharDirect`, never the chunk-cached reader. Consecutive samples are HASH_STRIDE
		// apart, so every one of them lands in a different 64x64 chunk — going through the cache
		// builds 4,096 tiles to read one, which turns 152,000 samples into 622 million
		// classifications. Measured as a `/api/world` request that had not returned after 26
		// seconds, on a path that runs on every lambda cold start.
		chunk += terrainCharDirect(i % gridSize, (i / gridSize) | 0);
		// Folded in periodically rather than concatenated into one ~152,000-char string.
		if (chunk.length >= 4096) {
			hash.update(chunk);
			chunk = '';
		}
	}
	hash.update(chunk);
	return hash.digest('hex').slice(0, 16);
}

