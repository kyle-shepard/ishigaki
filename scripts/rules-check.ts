// Run: npm run check:rules   (needs `npm run dev` running, and a seeded database)
//
// "The server is the enforcer" is this epic's load-bearing property, and it's the one class
// of behaviour that regresses invisibly: a client-side-only guard looks identical in the
// browser. These cases were already script-shaped — a literal request and a literal expected
// reason — so they're a fetch loop rather than six steps a human remembers.
//
// Drives HTTP against a running server, so it needs none of the DB harness `npm test` lacks.
// Deliberately not wired into `npm test`, which must stay runnable with no server.
const BASE = process.env.RULES_CHECK_URL ?? 'http://localhost:5173';

// The map used to carry a hand-authored core (LAYOUT in worldgen.ts) that put the lake, the
// stone outcrop and the rest at coordinates this file could just write down. It's gone — the
// whole map is generated now — so every terrain feature below is *found* in the payload
// instead: `findMany` (and `find`, its one-tile case) walk the world's own `terrain` array for
// the first tile, or tiles, of a named type. A coordinate written down here would have named
// whatever the generator drew on the day this was written, and silently started testing the
// wrong thing the next time WORLD_SEED changed — which is exactly what happened to the forty-odd
// hardcoded coordinates this file used to carry.
import { START } from '../src/lib/features/world/worldgen.ts';
import { START_REACH_RADIUS, withinReach } from '../src/lib/features/world/world.ts';

// Every request carries the same cookie, so all cases play in one player's sandbox — the
// occupancy checks are player-scoped and would read a different world otherwise.
let cookie = '';

async function api(path: string, init?: RequestInit) {
	const res = await fetch(`${BASE}${path}`, {
		...init,
		headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }
	});
	const set = res.headers.getSetCookie?.()[0];
	if (set) cookie = set.split(';')[0];
	return { status: res.status, body: await res.json() };
}

// GET /api/world returns only the *live* half now (issue #21 architecture A): the terrain grid and
// the catalogs moved to /api/world/static/<worldVersion>, immutably cached, so a heartbeat stops
// dragging 28,583 rows out of Neon on every read. Every case below still wants to reason about one
// whole world — heldOf needs `resources` (static) beside `stock` (live), `find` needs `terrain` and
// `terrainTypes` — so this merges the two halves back together the same way +page.svelte does, and
// every `readWorld()` call site reads exactly as it did when /api/world returned everything.
//
// Statics are cached by version rather than fetched per read, which is the point of the split; the
// version is re-checked on every live read, so a reseed mid-run refetches instead of silently
// merging a new world's quantities onto the old world's terrain.
let staticsVersion: string | null = null;
let statics: Record<string, unknown> = {};
async function readWorld() {
	const live = await api('/api/world');
	const version = (live.body as { worldVersion?: string }).worldVersion;
	if (version && version !== staticsVersion) {
		const res = await api(`/api/world/static/${version}`);
		if (res.status !== 200)
			throw new Error(`world statics for ${version} returned ${res.status} — is the seed current?`);
		statics = res.body;
		staticsVersion = version;
	}
	return { status: live.status, body: { ...statics, ...live.body } };
}

// Orders and assignments take world coordinates straight through now — there's no authored
// frame to convert out of.
const order = (x: number, y: number, buildingTypeId: number, crewSize?: number) =>
	api('/api/orders', {
		method: 'POST',
		body: JSON.stringify({ x, y, buildingTypeId, crewSize })
	});

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failures++;
	console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `  — got ${JSON.stringify(actual)}`}`);
}

// The first call creates the sandbox, so the cookie exists before any order is placed.
const world = await readWorld();
if (world.status !== 200) throw new Error(`GET /api/world returned ${world.status}`);
const typeId = (name: string) => {
	const t = world.body.buildingTypes.find((b: { displayName: string }) => b.displayName === name);
	if (!t) throw new Error(`no '${name}' building type — seed the database`);
	return t.id;
};
const house = typeId('House');
type Held = {
	stock: { resourceId: number; quantity: number }[];
	resources: { id: number; displayName: string }[];
};
// How much of one named resource a payload says you hold. Named rather than whole-stock, because
// `resolveWorld` runs inside every writer and drains Food as it goes — a before/after comparison of
// the *whole* of stock would be flaky rather than strict.
//
// Rounded to a tenth, and that is the same problem one step further on. Production is continuous:
// gatherers credit their tile inside every writer, so a refund read a few seconds after the value
// it is compared against comes back a few ten-thousandths high — 100.00034775 where 100 was meant.
// That drift is the economy working, not the refund being wrong, and it grew visible only when the
// world got big enough for a round trip to take seconds instead of milliseconds. Every price and
// every refund in this game is a whole number, so a tenth is far coarser than any real error
// (which is at least 1) and far finer than a minute of gathering — strict about the thing being
// asserted, deaf to the clock.
const heldOf = (w: Held, name: string) => {
	const id = w.resources.find((r) => r.displayName === name)!.id;
	const held = w.stock.find((s) => s.resourceId === id)?.quantity ?? 0;
	return Math.round(held * 10) / 10;
};
const woodHeld = (w: Held) => heldOf(w, 'Wood');

// A realm now starts with nothing, so a costed building can't be used to assert anything
// about *terrain* — every such order would be refused for want of Wood, and the check would
// pass or fail for the wrong reason. The uncosted type is the one that isolates ground rules
// from cost rules. Picked by having no cost rows rather than by name, so putting a price on
// the Barn one day fails here loudly instead of quietly testing the wrong thing.
const costed = new Set(
	world.body.buildingCosts.map((c: { buildingTypeId: number }) => c.buildingTypeId)
);
const free = world.body.buildingTypes.find((t: { id: number }) => !costed.has(t.id))?.id;
if (free === undefined)
	throw new Error('every building type costs something — no free type to test terrain with');

const assign = (x: number, y: number) =>
	api('/api/assignments', { method: 'POST', body: JSON.stringify({ x, y }) });

// Tiles of a named terrain type from the payload's own `terrain` array — the `n` **closest to the
// hamlet**, not the first `n` row-major. Pure given the initial `world` fetch above: terrain never
// changes between players, only what's built on it does, so every call below asking for the same
// name gets the same ground.
//
// Nearest, and it is load-bearing rather than tidy. Row-major order means "the first Forest" is
// somewhere along the map's top edge, and the hamlet is wherever `findStart` put it — on a 128×128
// world those are ~100 tiles apart, so every case that actually *builds* on found ground paid for a
// worker to walk the entire map first. That is real game time this script then has to sleep
// through: one build measured 426 seconds, and with ten of them the run went from minutes to over
// an hour. Distance is not what any of these cases is testing, so it is bought back to nearly zero
// here. Chebyshev, matching the 8-directional step `route` actually walks.
//
// Ground the realm already stands on is skipped, or "nearest" would hand back the hamlet's own
// tile — every realm opens with buildings on Meadow, so the closest Meadow to the hamlet *is* the
// hamlet — and a case meaning to assert "plain ground accepts a building" would be refused for
// occupancy instead. Read off the opening payload, which every fresh sandbox below starts from
// identically: START is the same for every player (VISION #4 interim override).
const startBuildings = new Set(
	world.body.buildings.map((b: { x: number; y: number }) => b.y * world.body.gridSize + b.x)
);
function findMany(name: string, n: number): { x: number; y: number }[] {
	const t = world.body.terrainTypes.find((tt: { displayName: string }) => tt.displayName === name);
	if (!t) throw new Error(`no '${name}' terrain type — seed the database`);
	const out: { x: number; y: number }[] = [];
	for (let i = 0; i < world.body.terrain.length; i++) {
		if (world.body.terrain[i] !== t.id || startBuildings.has(i)) continue;
		out.push({ x: i % world.body.gridSize, y: Math.floor(i / world.body.gridSize) });
	}
	if (out.length < n)
		throw new Error(`only ${out.length} ${name} tile(s) on the map, need ${n} — reroll the seed`);
	const from = (p: { x: number; y: number }) =>
		Math.max(Math.abs(p.x - START.hamletX), Math.abs(p.y - START.hamletY));
	return out.sort((a, b) => from(a) - from(b)).slice(0, n);
}
const find = (name: string) => findMany(name, 1)[0];

// Found once, reused everywhere below that needs "a tile of this kind" — every one of these is a
// fresh-sandbox check (a new player, cookie reset), so the same physical tile being asked about
// twice is never the same *build* twice.
const meadow = find('Meadow');
const forest = find('Forest');
const mountain = find('Mountain');
const ironVein = find('Iron vein');
const stoneOutcrop = find('Stone outcrop');
const clayPit = find('Clay pit');

// Terrain rules. `free` is the uncosted type (Barn), so these isolate the ground rule from cost.
// Unbuildable ground and every *deposit* refuse a plain building: a deposit offers only its own
// extractor (a Quarry on an outcrop), and Clay/Iron have no extractor yet — so nothing at all.
for (const [name, tile] of [
	['Water', find('Water')],
	['Mountain', mountain],
	['Iron vein', ironVein],
	['Stone outcrop', stoneOutcrop],
	['Clay pit', clayPit]
] as [string, { x: number; y: number }][]) {
	const r = await order(tile.x, tile.y, free);
	check(
		`(${tile.x},${tile.y}) ${name.toLowerCase()} refuses a plain building`,
		[r.status, r.body.reason],
		[400, 'TILE_NOT_BUILDABLE']
	);
}
// Plain buildable ground takes the uncosted type. One order at a time — a fresh sandbox per case
// keeps NO_IDLE_CHARACTER out of what is meant to be a terrain assertion.
for (const [name, tile] of [
	['Meadow', meadow],
	['Forest', forest]
] as [string, { x: number; y: number }][]) {
	cookie = '';
	await readWorld();
	const r = await order(tile.x, tile.y, free);
	check(`(${tile.x},${tile.y}) ${name.toLowerCase()} is accepted`, r.status, 200);
}

// The deposit rule cuts both ways, and terrain is judged before cost — so even a costed type shows
// the ground rule cleanly. An extractor belongs only on its deposit; a plain building never does.
const quarry = typeId('Quarry');
cookie = '';
await readWorld();
check(
	'a Quarry is refused on a meadow — an extractor may not squat on plain ground',
	[(await order(meadow.x, meadow.y, quarry)).body.reason],
	['TILE_NOT_BUILDABLE']
);
cookie = '';
await readWorld();
check(
	'a House is refused on an iron vein — a plain building may not squat on a deposit',
	[(await order(ironVein.x, ironVein.y, house)).body.reason],
	['TILE_NOT_BUILDABLE']
);
cookie = '';
await readWorld();
check(
	'a Quarry is accepted on a Stone outcrop — the deposit offers exactly its extractor',
	(await order(stoneOutcrop.x, stoneOutcrop.y, quarry)).status,
	200
);

// Unregressed: the rules that existed before terrain did.
cookie = '';
await readWorld();
const oob = await order(world.body.gridSize, 0, free);
check(
	`(${world.body.gridSize},0) is off the map`,
	[oob.status, oob.body.reason],
	[400, 'OUT_OF_BOUNDS']
);
const occupied = await order(START.hamletX, START.hamletY, free);
check(
	`(${START.hamletX},${START.hamletY}) holds the hamlet`,
	[occupied.status, occupied.body.reason],
	[400, 'TILE_OCCUPIED']
);

// ---- Reach ---------------------------------------------------------------------------------------
//
// The sphere of influence: a build (and, new this phase, a gather) just outside is refused
// OUTSIDE_REACH; the same one exactly on the boundary — which `withinReach`'s `<=` counts as
// inside — is accepted. Coordinates come from the payload's own `reach`, never written down, the
// same discipline `findMany` already holds terrain to.
//
// Only the four cardinal offsets are tried: at the radii this map actually uses (6 and 7) they are
// the only integer points on the circle at all — 6² and 7² have no other decomposition into two
// squares — so there is nothing to gain from trying more, and the first one that is buildable,
// unoccupied ground wins the same way `findMany` picks its first match.
function reachEdge(dist: number): { x: number; y: number } {
	const { x: cx, y: cy } = world.body.reach;
	for (const [dx, dy] of [
		[dist, 0],
		[0, dist],
		[-dist, 0],
		[0, -dist]
	]) {
		const x = cx + dx;
		const y = cy + dy;
		if (x < 0 || y < 0 || x >= world.body.gridSize || y >= world.body.gridSize) continue;
		const i = y * world.body.gridSize + x;
		if (startBuildings.has(i)) continue;
		const t = world.body.terrainTypes.find((tt: { id: number }) => tt.id === world.body.terrain[i]);
		if (t?.buildableTypeIds.includes(free)) return { x, y };
	}
	throw new Error(`no buildable, unoccupied tile exactly ${dist} tiles from the reach centre`);
}
const insideEdge = reachEdge(world.body.reach.radius);
const outsideEdge = reachEdge(world.body.reach.radius + 1);

cookie = '';
await readWorld();
const buildOutside = await order(outsideEdge.x, outsideEdge.y, free);
check(
	`(${outsideEdge.x},${outsideEdge.y}) one tile past the reach refuses a build`,
	[buildOutside.status, buildOutside.body.reason],
	[400, 'OUTSIDE_REACH']
);
cookie = '';
await readWorld();
check(
	`(${insideEdge.x},${insideEdge.y}) exactly on the reach's edge accepts the same build`,
	(await order(insideEdge.x, insideEdge.y, free)).status,
	200
);

cookie = '';
await readWorld();
const gatherOutside = await assign(outsideEdge.x, outsideEdge.y);
check(
	`(${outsideEdge.x},${outsideEdge.y}) one tile past the reach refuses a gather too — it's a` +
		' sphere of influence, not a building permit',
	[gatherOutside.status, gatherOutside.body.reason],
	[400, 'OUTSIDE_REACH']
);
cookie = '';
await readWorld();
check(
	`(${insideEdge.x},${insideEdge.y}) exactly on the reach's edge accepts the same gather`,
	(await assign(insideEdge.x, insideEdge.y)).status,
	200
);

// The ratchet, end to end. The SQL side of it is only ever `GREATEST(reach_radius, target)` — no
// unit test pins that keyword itself (world.test.ts pins `reachFor`, the target arithmetic behind
// it); this is the one place it actually runs. A fresh realm's starting population (3) sits exactly
// on the first milestone, so the opening value is asserted directly against it, then read again
// after a build and a real wait — as much population movement as a bounded script can afford (real
// growth takes on the order of 30 real minutes at the seeded rate) — to prove what ran was the
// ratchet and not a plain assignment that would have (correctly, here) produced the same number.
cookie = '';
const ratchetStart = await readWorld();
check(
	'a fresh realm opens at exactly the first reach milestone',
	ratchetStart.body.reach.radius,
	START_REACH_RADIUS
);
await order(meadow.x, meadow.y, house);
await new Promise((r) => setTimeout(r, 2000));
const ratchetEnd = await readWorld();
check(
	'the reach radius never fell across those reads',
	ratchetEnd.body.reach.radius >= ratchetStart.body.reach.radius,
	true
);

// Travel is routed by the server, and it walks rather than teleports. The *water-detour* half of
// this claim — that a route around a river comes back dry, and costs more steps than the straight
// line it avoided — moved to worldgen.test.ts when the reach began gating movement work. `route`
// is pure, so it belongs in a unit test anyway; and it could not stay here regardless, because
// proving it needs a destination on the far side of water and a fresh realm's circle is six tiles
// of meadow, forest, hills and outcrop with no water in it at all. Ordering out there is refused
// OUTSIDE_REACH now, for exactly the right reason, and reaching real water would mean waiting out
// several population milestones inside a script that already runs for twenty minutes.
//
// What stays is the half only a running server can show: an order comes back with a walked path,
// ending on the tile that was asked for.
cookie = '';
const travelWorld = await readWorld();
const gridSize = travelWorld.body.gridSize;
const reach = travelWorld.body.reach;
const occupiedTiles = new Set(
	travelWorld.body.buildings.map((b: { x: number; y: number }) => b.y * gridSize + b.x)
);
const buildableTypesByTerrain = new Map<number, number[]>(
	travelWorld.body.terrainTypes.map(
		(t: { id: number; buildableTypeIds: number[] }) =>
			[t.id, t.buildableTypeIds] as [number, number[]]
	)
);
// The furthest buildable tile still inside the circle, so the walk is as long as the reach allows.
let dest: { x: number; y: number } | null = null;
let farthest = -1;
for (let i = 0; i < travelWorld.body.terrain.length; i++) {
	if (occupiedTiles.has(i)) continue;
	if (!buildableTypesByTerrain.get(travelWorld.body.terrain[i])?.includes(free)) continue;
	const x = i % gridSize;
	const y = Math.floor(i / gridSize);
	if (!withinReach(x, y, reach)) continue;
	const d = Math.hypot(x - reach.x, y - reach.y);
	if (d > farthest) {
		farthest = d;
		dest = { x, y };
	}
}
if (!dest) throw new Error('no buildable tile inside the opening reach');
const routed = await order(dest.x, dest.y, free);
const routedOp = routed.body.operations?.[0];
if (!routedOp)
	throw new Error(`order to (${dest.x},${dest.y}) was refused: ${JSON.stringify(routed.body)}`);
const path: number[] = routedOp.workers[0].path;
check(
	`the order to (${dest.x},${dest.y}) came back with a walked route, not a teleport`,
	[path.length > 1, path[path.length - 1] === dest.y * gridSize + dest.x],
	[true, true]
);

// The runway and the refund path. A fresh realm no longer starts empty — it arrives stocked
// (VISION #10) so it can build before it has to gather. Stock is asserted off the payload's own
// numbers, same rule as the travel legs.
cookie = '';
const fresh = await readWorld();
const woodStart = woodHeld(fresh.body);
check('a new realm arrives with a Wood runway', woodStart > 0, true);

// Cancel a build: the operation vanishes and the FULL cost returns — never prorated, never
// double-credited. This is the epic's refund path, and its arithmetic is the thing to pin.
const built = await order(meadow.x, meadow.y, house);
const site = built.body.operations?.find((o: { type: string }) => o.type === 'build');
check(
	'ordering a House deducts its cost up front',
	[built.status, woodHeld(built.body)],
	[200, woodStart - 6]
);

const cancelled = await api(`/api/orders/${site.id}`, { method: 'DELETE' });
check(
	'cancelling refunds in full — stock returns to exactly the pre-order value',
	[cancelled.status, woodHeld(cancelled.body)],
	[200, woodStart]
);
// Delete-first, refund-on-RETURNING: a second cancel finds nothing to delete and credits nothing,
// so a double-clicked Cancel cannot dupe the refund.
const twice = await api(`/api/orders/${site.id}`, { method: 'DELETE' });
check(
	'cancelling twice is refused, not a second refund',
	[twice.status, twice.body.reason],
	[400, 'UNKNOWN_OPERATION']
);
check(
	'stock holds exactly one refund after the double cancel',
	woodHeld((await readWorld()).body),
	woodStart
);
// The cancelled op left nothing behind: the tile is buildable again and a worker is free to take it.
check(
	'the cancelled tile is buildable again',
	(await order(meadow.x, meadow.y, house)).status,
	200
);

// The realm-wide build prerequisite: a Stone wall needs a Quarry standing *anywhere* first. With
// none owned it is refused before terrain or cost matter — a distinct reason from the tile-local
// MISSING_REQUIRED_BUILDING that gates gathering.
cookie = '';
await readWorld();
const stoneWall = typeId('Stone wall');
check(
	'a Stone wall with no Quarry owned is refused as a missing prerequisite',
	[(await order(meadow.x, meadow.y, stoneWall)).body.reason],
	['MISSING_PREREQUISITE']
);

// Gathering. The refusals matter more than the acceptance: a tile that yields nothing must be
// turned away at the writer, or a worker stands there forever earning nothing with no feedback.
// The clay pit is the sharp case — it *does* name a resource, it just has no rate yet, so a
// null-check alone would wave it through.
for (const [label, tile] of [
	['mountain — yields nothing', mountain],
	['clay pit — yields a resource with no rate', clayPit]
] as [string, { x: number; y: number }][]) {
	const r = await assign(tile.x, tile.y);
	check(
		`(${tile.x},${tile.y}) ${label} is refused`,
		[r.status, r.body.reason],
		[400, 'TILE_YIELDS_NOTHING']
	);
}

const gathering = await assign(forest.x, forest.y);
const gather = gathering.body.operations?.find((o: { type: string }) => o.type === 'gather');
check(
	`(${forest.x},${forest.y}) forest accepts a worker, on an operation that never completes by itself`,
	[gathering.status, gather?.type, gather?.completeAt, gather?.buildingTypeId],
	[200, 'gather', null, null]
);

const recalled = await api(`/api/assignments/${gather.id}`, { method: 'DELETE' });
check(
	'recalling ends the assignment',
	[
		recalled.status,
		recalled.body.operations.filter((o: { type: string }) => o.type === 'gather').length
	],
	[200, 0]
);
const again = await api(`/api/assignments/${gather.id}`, { method: 'DELETE' });
check(
	'recalling twice is refused, not silently repeated',
	[again.status, again.body.reason],
	[400, 'UNKNOWN_OPERATION']
);

// Deposits. Which tiles carry a countdown at all is the assertion worth pinning: a finite
// deposit must report both numbers, and an infinite one must report neither, or the client
// would render "0 of null" on a quarry. Watching a forest actually thin is the rate-cranked
// manual pass — at 3 Wood an hour it takes eight hours, which is the mechanic working.
cookie = '';
const map = await readWorld();
const at = (x: number, y: number) => y * map.body.gridSize + x;
const terrainCapacity = (name: string) =>
	map.body.terrainTypes.find((t: { displayName: string }) => t.displayName === name).capacity;
check(
	'an untouched forest tile reports full',
	[map.body.tileQuantity[at(forest.x, forest.y)], terrainCapacity('Forest')],
	[terrainCapacity('Forest'), terrainCapacity('Forest')]
);
check(
	'a stone outcrop never runs down, so it counts nothing',
	[map.body.tileQuantity[at(stoneOutcrop.x, stoneOutcrop.y)], terrainCapacity('Stone outcrop')],
	[null, null]
);
check(
	'ground that yields nothing counts nothing',
	[map.body.tileQuantity[at(mountain.x, mountain.y)], terrainCapacity('Mountain')],
	[null, null]
);

// The quarry gate. Wood and forage need a person; stone needs the structure first, and the
// structure has to be on the tile being worked — not merely somewhere in the realm.
cookie = '';
await readWorld();
const bare = await assign(stoneOutcrop.x, stoneOutcrop.y);
check(
	`(${stoneOutcrop.x},${stoneOutcrop.y}) a stone outcrop with no quarry on it is refused`,
	[bare.status, bare.body.reason],
	[400, 'MISSING_REQUIRED_BUILDING']
);
check(
	`(${forest.x},${forest.y}) forest still needs no building at all`,
	(await assign(forest.x, forest.y)).status,
	200
);

// Crews. A build takes more than one body now, and more bodies must actually finish it sooner.
// Asserted off the payload's own clock rather than by waiting a build out — a fresh sandbox for
// each size, same tile, so the only thing that differs is the headcount. (A realm starts with
// three, which is why 3 is the crowd here.)
const crewed: Record<number, { workers: number; seconds: number }> = {};
for (const size of [1, 3]) {
	cookie = '';
	await readWorld();
	const r = await order(meadow.x, meadow.y, free, size);
	const op = r.body.operations?.[0];
	if (!op) throw new Error(`crew-of-${size} order was refused: ${JSON.stringify(r.body)}`);
	crewed[size] = {
		workers: op.workers.length,
		seconds: (Date.parse(op.completeAt) - Date.parse(op.startedAt)) / 1000
	};
}
check('a crew of 3 puts three bodies on one operation', crewed[3].workers, 3);
check('a crew of 1 is still exactly one body', crewed[1].workers, 1);
check(
	`three raise it faster than one (${crewed[3].seconds}s vs ${crewed[1].seconds}s)`,
	crewed[3].seconds < crewed[1].seconds,
	true
);
// crewSize is a maximum, not a demand: asking for more bodies than the realm holds takes
// everyone rather than refusing. Without this, a hopeful number would be a dead end.
cookie = '';
const small = await readWorld();
const everyone = await order(meadow.x, meadow.y, free, 99);
check(
	'asking for more hands than you have sends everyone, rather than refusing',
	everyone.body.operations?.[0]?.workers.length,
	small.body.characters.length
);

// Preview = outcome. This is a stated failure condition of the epic — "the numbers shown before
// you commit aren't the ones you get" — and it can only be closed by asserting the quote against
// the thing actually written. Both go through `planBuild`, so this is what proves that.
const estimateOf = (x: number, y: number, buildingTypeId: number, crewSize: number) =>
	api('/api/orders/estimate', {
		method: 'POST',
		body: JSON.stringify({ x, y, buildingTypeId, crewSize })
	});

for (const size of [1, 3]) {
	cookie = '';
	await readWorld();
	const quote = await estimateOf(meadow.x, meadow.y, free, size);
	const placed = await order(meadow.x, meadow.y, free, size);
	const op = placed.body.operations?.[0];
	if (!op) throw new Error(`estimate-then-order (crew ${size}) was refused`);
	const actual = (Date.parse(op.completeAt) - Date.parse(op.startedAt)) / 1000;
	check(
		`a crew-of-${size} estimate (${quote.body.seconds}s) is what the order actually does (${actual}s)`,
		Math.abs(quote.body.seconds - actual) <= 1,
		true
	);
	check(`the estimate names the crew of ${size} it would send`, quote.body.crew.length, size);
}

// A refusal previews as the same refusal, rather than as a number nobody can act on.
cookie = '';
await readWorld();
check(
	'estimating an unbuildable tile refuses with the reason the order would give',
	[
		(await estimateOf(mountain.x, mountain.y, free, 1)).status,
		(await estimateOf(mountain.x, mountain.y, free, 1)).body.reason
	],
	[400, 'TILE_NOT_BUILDABLE']
);
// And it spends nothing: quoting is not ordering.
const beforeQuote = woodHeld((await readWorld()).body);
await estimateOf(meadow.x, meadow.y, house, 3);
check(
	'an estimate costs nothing — quoting is not ordering',
	woodHeld((await readWorld()).body),
	beforeQuote
);

// The whole chain, asserted in one go: what the preview promised is what the *building* carries.
// Deliberately the slow case — it waits out a real build — because without it "preview = outcome"
// is only ever proved as far as the operation, and the durable output this epic exists to capture
// would have no check at all.
cookie = '';
await readWorld();
const promised = await estimateOf(meadow.x, meadow.y, free, 3);
const raised = await order(meadow.x, meadow.y, free, 3);
const rising = raised.body.operations?.[0];
if (!rising) throw new Error('the build-for-quality order was refused');
const dueAt = Date.parse(rising.completeAt);
let finished: { quality: number } | undefined;
// Bounded: a 3-settler Barn is ~100s of build plus travel. Polling is what makes the building
// appear at all — the server resolves on read, so nobody looking means nobody building.
while (Date.now() < dueAt + 15_000) {
	await new Promise((r) => setTimeout(r, 3000));
	const w = await readWorld();
	finished = w.body.buildings.find(
		(b: { x: number; y: number }) => b.x === meadow.x && b.y === meadow.y
	);
	if (finished) break;
}
check(
	`the finished building carries the quality the preview promised (${promised.body.quality})`,
	finished ? Math.abs(finished.quality - promised.body.quality) < 1e-6 : 'never finished',
	true
);
// The starting hamlet predates the column, so it is the honest null case: no band, no crash. Read
// straight off START — this looks up a tile the *game* chose, not one the map author drew, and a
// hand-written coordinate here is what crashed this check the day the hamlet moved.
const hamlet = (await readWorld()).body.buildings.find(
	(b: { x: number; y: number }) => b.x === START.hamletX && b.y === START.hamletY
);
if (!hamlet) throw new Error(`no starting hamlet at ${START.hamletX}, ${START.hamletY}`);
check(
	'a building raised before quality was recorded reports null, not a number',
	hamlet.quality,
	null
);

// Restrict-by-specialty. The filter is the entry point to the whole worker-selection UX, and its
// two ends are what matter: naming a trade the realm has none of turns the order away, and naming
// one it has narrows the crew to exactly those bodies.
const restricted = (x: number, y: number, ids: number[] | null, crewSize = 3) =>
	api('/api/orders', {
		method: 'POST',
		body: JSON.stringify({ x, y, buildingTypeId: free, crewSize, allowedProfessionIds: ids })
	});
const professionId = (name: string) => {
	const p = world.body.professions.find((q: { displayName: string }) => q.displayName === name);
	if (!p) throw new Error(`no '${name}' profession — seed the database`);
	return p.id;
};

cookie = '';
await readWorld();
// A fresh realm is three settlers, so it has no Mason at all. This *queues* rather than refusing —
// an unsatisfiable filter and a realm where everyone is busy are the same situation, and both
// resolve themselves the moment a qualifying worker exists.
const noMason = await restricted(meadow.x, meadow.y, [professionId('Mason')]);
const waiting = noMason.body.operations?.find((o: { type: string }) => o.type === 'build');
check(
	'an order restricted to a trade nobody has waits instead of bouncing',
	[noMason.status, waiting?.startedAt, waiting?.completeAt, waiting?.workers.length],
	[200, null, null, 0]
);
// An id no profession carries must fail loudly at order time — Postgres cannot foreign-key an
// array element, so this refusal *is* the referential integrity for that column. Silently it
// would match nobody and read as "everyone is busy".
const bogus = await restricted(meadow.x, meadow.y, [999999]);
check(
	'a filter naming a profession that does not exist is refused as unknown, not as "everyone is busy"',
	[bogus.status, bogus.body.reason],
	[400, 'UNKNOWN_PROFESSION']
);
// Unchecking everything is not "nobody may build this".
cookie = '';
await readWorld();
check(
	'an empty filter means anyone, not nobody',
	(await restricted(meadow.x, meadow.y, [])).status,
	200
);

// The queue. Placing a build with everyone busy no longer bounces: it holds the tile and the cost
// it has already paid, and starts itself when a worker frees. Reserving at queue time is the whole
// point — deducting at start would reintroduce the silent-failure-while-away this model avoids.
// Forest tiles a realm may actually work, nearest first. `findMany` sorts by Chebyshev distance
// from the hamlet, while the reach is a Euclidean circle around the Marketplace one tile north — so
// "nearest" and "in reach" are not the same list, and the gap is not a rounding error: a tile five
// steps away diagonally sits 7.07 from the centre, outside a radius-6 circle. Anything below that
// means to *occupy* workers wants this list rather than that one, because a refused assignment
// quietly leaves somebody idle and the next case sees a build start when it expected one to queue.
const reachable = (name: string, n: number) => {
	// 200 nearest as the pool, which on any sane start comfortably covers the circle; the filter is
	// what actually decides. Throws rather than returning short, because coming up empty here means
	// the start guarantee in worldgen.ts has slipped and every case below would fail confusingly.
	const inReach = findMany(name, 200)
		.filter((t) => withinReach(t.x, t.y, world.body.reach))
		.slice(0, n);
	if (inReach.length < n)
		throw new Error(
			`only ${inReach.length} ${name} tile(s) inside the opening reach, need ${n} — the start guarantee in worldgen.ts has slipped`
		);
	return inReach;
};

const occupyEveryone = async () => {
	for (const { x, y } of reachable('Forest', 3)) await assign(x, y);
};

cookie = '';
const busyRealm = await readWorld();
const woodBefore = woodHeld(busyRealm.body);
await occupyEveryone();
const heldUp = await order(meadow.x, meadow.y, house);
const parked = heldUp.body.operations?.find((o: { type: string }) => o.type === 'build');
check(
	'with everyone busy the build queues rather than refusing',
	[heldUp.status, parked?.startedAt, parked?.completeAt, parked?.workers.length],
	[200, null, null, 0]
);
check(
	'a queued build reserves its cost up front, so it cannot fail later while you are away',
	woodHeld(heldUp.body),
	woodBefore - 6
);
check(
	'a queued build holds its tile — a second order cannot stack on it',
	(await order(meadow.x, meadow.y, house)).body.reason,
	'TILE_OCCUPIED'
);
// Free one gatherer, and the waiting build takes them on the very next read.
const gathering2 = (await readWorld()).body.operations.filter(
	(o: { type: string }) => o.type === 'gather'
);
await api(`/api/assignments/${gathering2[0].id}`, { method: 'DELETE' });
const startedItself = (await readWorld()).body.operations.find(
	(o: { id: number }) => o.id === parked.id
);
check(
	'freeing a worker starts the waiting build by itself',
	[
		startedItself?.startedAt !== null,
		startedItself?.completeAt !== null,
		startedItself?.workers.length
	],
	[true, true, 1]
);

// Cancelling a queued build is the same delete-and-refund path, and just as un-duplicable.
cookie = '';
const q2 = await readWorld();
const woodQ2 = woodHeld(q2.body);
await occupyEveryone();
const toCancel = (await order(meadow.x, meadow.y, house)).body.operations?.find(
	(o: { type: string }) => o.type === 'build'
);
const refunded = await api(`/api/orders/${toCancel.id}`, { method: 'DELETE' });
check(
	'cancelling a queued build refunds it in full',
	[refunded.status, woodHeld(refunded.body)],
	[200, woodQ2]
);
check(
	'cancelling a queued build twice is refused, not a second refund',
	(await api(`/api/orders/${toCancel.id}`, { method: 'DELETE' })).body.reason,
	'UNKNOWN_OPERATION'
);

// ---- Production: a Sawmill turns 20 Wood into 10 Planks ---------------------------------------
//
// One sandbox for the whole group, because everything here needs a Sawmill *standing* and raising
// one is the slow part. The waits are real elapsed time rather than polling: "a batch left alone
// past its completion lands on the next read" is only proved by not reading until then.
const sawmill = typeId('Sawmill');
const schoolType = typeId('School');
const carpenter = professionId('Carpenter');
// The clear grass the hamlet is guaranteed (see START_MARGIN in worldgen.ts): one tile below the
// settlers' own row, so the crew yardly walks, and one further along for the empty-tile case.
const mill = [START.characterX, START.characterY + 1] as const;
const yard = [START.characterX + 2, START.characterY + 1] as const;

const craft = (x: number, y: number, crewSize?: number, allowedProfessionIds?: number[]) =>
	api('/api/craft', {
		method: 'POST',
		body: JSON.stringify({ x, y, crewSize, allowedProfessionIds })
	});
/** Sleeps until an operation is genuinely due, then reads. Nothing looks in between.
 *
 * The sleep is timed off this machine's clock, but whether an operation has landed is decided by
 * the server's — and those are not the same clock. The database is remote, a read costs seconds of
 * round trip, and the two disagree by a second or two besides, so a fixed local sleep plus a couple
 * of seconds' slack can easily arrive while the server still thinks the work has a moment left.
 * That reads as "the building never went up" when what happened is that we looked too early: the
 * failure landed on the Sawmill in the crafting ladder, and every later case that needed the mill
 * failed behind it. So the local sleep gets us close, and then the payload's own `now` — the same
 * clock `resolveWorld` compares against — is what says the moment has passed. */
async function waitOut(op: { completeAt: string }, slackMs = 2000) {
	const due = Date.parse(op.completeAt);
	const wait = due - Date.now() + slackMs;
	if (wait > 0) await new Promise((r) => setTimeout(r, wait));
	for (let i = 0; i < 10; i++) {
		const w = (await readWorld()).body;
		if (Date.parse(w.now) >= due) return w;
		await new Promise((r) => setTimeout(r, 1000));
	}
	throw new Error(`waited well past ${op.completeAt} but the server's clock never reached it`);
}
const stands = (w: { buildings: { x: number; y: number }[] }, [x, y]: readonly [number, number]) =>
	w.buildings.some((b) => b.x === x && b.y === y);
type WireOp = {
	id: number;
	type: string;
	startedAt: string;
	completeAt: string;
	workers: { characterId: number }[];
};
const craftOp = (w: { operations: WireOp[] }) => w.operations.find((o) => o.type === 'craft');

cookie = '';
const shopStart = await readWorld();
const woodAtStart = woodHeld(shopStart.body);
const raising = await order(...mill, sawmill, 3);
const millSite = raising.body.operations?.find((o: { type: string }) => o.type === 'build');
if (!millSite) throw new Error(`the Sawmill order was refused: ${JSON.stringify(raising.body)}`);
let realm = await waitOut(millSite);
check('a Sawmill can be raised, and stands', stands(realm, mill), true);

// Nothing on the tile, and something on the tile that makes nothing, are the same refusal — a
// building that is not yours must not be distinguishable from one that is not there.
check(
	'crafting on empty ground is refused — nothing there makes anything',
	[(await craft(...yard)).status, (await craft(...yard)).body.reason],
	[400, 'NOT_A_WORKSHOP']
);
const atHamlet = [START.hamletX, START.hamletY] as const;
check(
	'crafting at a House is refused too — a workshop is a type that carries a recipe',
	(await craft(...atHamlet)).body.reason,
	'NOT_A_WORKSHOP'
);

// A gather is recalled, not cancelled. The cancel path widened to crafts, not to everything: left
// as "anything unfinished", this would delete a working gather, refund nothing, and free the body
// with none of recallWorker's semantics.
const working = (await assign(forest.x, forest.y)).body.operations.find(
	(o: { type: string }) => o.type === 'gather'
);
check(
	'a gather id is still refused by the build/craft cancel path',
	(await api(`/api/orders/${working.id}`, { method: 'DELETE' })).body.reason,
	'UNKNOWN_OPERATION'
);
check(
	'and the gather is still running, not quietly deleted',
	(await readWorld()).body.operations.some((o: { id: number }) => o.id === working.id),
	true
);
await api(`/api/assignments/${working.id}`, { method: 'DELETE' });

// The order itself: inputs leave stock at the click, and the batch is one operation with a clock.
const woodBeforeBatch = woodHeld((await readWorld()).body);
const settlerBatch = await craft(...mill, 1);
const solo = craftOp(settlerBatch.body);
if (!solo) throw new Error(`the settler batch was refused: ${JSON.stringify(settlerBatch.body)}`);
check(
	'ordering a batch takes its inputs up front and writes one craft op with a completion time',
	[
		settlerBatch.status,
		woodHeld(settlerBatch.body),
		solo?.type,
		solo?.completeAt !== null,
		solo?.workers.length
	],
	[200, woodBeforeBatch - 20, 'craft', true, 1]
);
// Without this a Sawmill is not a bottleneck at all — you would build one and run six through it.
check(
	'a second batch at a working Sawmill is refused',
	[(await craft(...mill)).status, (await craft(...mill)).body.reason],
	[400, 'WORKSHOP_BUSY']
);
// How long one settler takes, kept for the skill comparison below — measured off the payload's own
// clock rather than by waiting it out.
const settlerSeconds = (Date.parse(solo.completeAt) - Date.parse(solo.startedAt)) / 1000;

const unwound = await api(`/api/orders/${solo.id}`, { method: 'DELETE' });
check(
	'cancelling a batch refunds its inputs in full',
	[unwound.status, woodHeld(unwound.body)],
	[200, woodBeforeBatch]
);
check(
	'cancelling a batch twice is refused, not a second refund',
	(await api(`/api/orders/${solo.id}`, { method: 'DELETE' })).body.reason,
	'UNKNOWN_OPERATION'
);
check(
	'and stock holds exactly one refund after the double cancel',
	woodHeld((await readWorld()).body),
	woodBeforeBatch
);

// The payoff, and the offline promise with it: order it, walk away, and the planks are there when
// you come back — credited once, on the first read that happens after it was due.
const planksBefore = heldOf((await readWorld()).body, 'Planks');
const batch = craftOp((await craft(...mill, 3)).body);
if (!batch) throw new Error('the plank batch was refused');
realm = await waitOut(batch);
check(
	'a batch left alone past its completion lands on the very next read, exactly one output',
	heldOf(realm, 'Planks'),
	planksBefore + 10
);
check(
	'and a second read does not credit it again',
	heldOf((await readWorld()).body, 'Planks'),
	planksBefore + 10
);
check(
	'the finished batch is gone from the wire, and left no building behind',
	[
		craftOp(realm) === undefined,
		realm.buildings.filter((b: { buildingTypeId: number }) => b.buildingTypeId === sawmill).length
	],
	[true, 1]
);
// Planks are made, never taken. This is the epic's whole claim in one assertion: a good that no
// tile anywhere on the map yields, so a recipe is the only way it can enter the world.
check(
	'no terrain anywhere yields Planks',
	realm.terrainTypes.some(
		(t: { yieldsResourceId: number | null }) =>
			t.yieldsResourceId ===
			realm.resources.find((r: { displayName: string }) => r.displayName === 'Planks').id
	),
	false
);

// Who does the work changes the result — with no rule anywhere saying so, only `resource.skill_id`
// naming Carpentry on Planks and feeding the same `rankIdleWorkers` a gather and a build use.
const schooling = await order(...yard, schoolType, 3);
const schoolSite = schooling.body.operations?.find((o: { type: string }) => o.type === 'build');
if (!schoolSite) throw new Error(`the School order was refused: ${JSON.stringify(schooling.body)}`);
await waitOut(schoolSite);
const training = await api('/api/training', {
	method: 'POST',
	body: JSON.stringify({ x: yard[0], y: yard[1], professionId: carpenter })
});
const lesson = training.body.operations?.find((o: { type: string }) => o.type === 'train');
if (!lesson) throw new Error(`training was refused: ${JSON.stringify(training.body)}`);
realm = await waitOut(lesson);
check(
	'a Carpenter can be trained',
	realm.characters.some((c: { professionId: number | null }) => c.professionId === carpenter),
	true
);
const trained = await craft(...mill, 1, [carpenter]);
const byCarpenter = craftOp(trained.body);
if (!byCarpenter)
	throw new Error(`the Carpenter batch was refused: ${JSON.stringify(trained.body)}`);
const carpenterSeconds =
	(Date.parse(byCarpenter.completeAt) - Date.parse(byCarpenter.startedAt)) / 1000;
check(
	`a Carpenter finishes a batch sooner than a settler (${carpenterSeconds}s vs ${settlerSeconds}s)`,
	carpenterSeconds < settlerSeconds,
	true
);
await api(`/api/orders/${byCarpenter.id}`, { method: 'DELETE' });

// ---- The queue: order it and walk away ---------------------------------------------------------
//
// A batch placed with nobody free waits rather than bouncing, holding the inputs it has already
// paid — and starts itself on the next read after somebody frees, with no one looking.
const busyEveryone = async () => {
	const idle = (await readWorld()).body.characters.length;
	for (const { x, y } of reachable('Forest', 6)) {
		const w = (await readWorld()).body;
		if (w.operations.filter((o: { type: string }) => o.type === 'gather').length >= idle) break;
		await assign(x, y);
	}
};
await busyEveryone();
const woodBeforeQueue = woodHeld((await readWorld()).body);
const heldBatch = await craft(...mill, 1);
const held = craftOp(heldBatch.body);
check(
	'with everyone busy a batch waits rather than refusing, and reserves its inputs up front',
	[
		heldBatch.status,
		held?.startedAt,
		held?.completeAt,
		held?.workers.length,
		woodHeld(heldBatch.body)
	],
	[200, null, null, 0, woodBeforeQueue - 20]
);
const droppedQueue = await api(`/api/orders/${held!.id}`, { method: 'DELETE' });
check(
	'cancelling a waiting batch refunds it in full',
	[droppedQueue.status, woodHeld(droppedQueue.body)],
	[200, woodBeforeQueue]
);
check(
	'cancelling a waiting batch twice is refused, not a second refund',
	(await api(`/api/orders/${held!.id}`, { method: 'DELETE' })).body.reason,
	'UNKNOWN_OPERATION'
);

// **The misprice trap.** A queued batch must be timed from `craft_seconds` (30), not from the
// Sawmill's `build_seconds` (40) — the two differ in the seed precisely so a wrong dereference is
// measurable. Queue one of each, free two *settlers* (the Carpenter stays out gathering, so both
// are worked at the same untrained pace), and the batch has to come out the quicker of the two.
const waitingBatch = craftOp((await craft(...mill, 1)).body);
const spare = [START.characterX - 2, START.characterY + 1] as const;
const waitingBuild = (await order(...spare, sawmill, 1)).body.operations?.find(
	(o: { type: string; startedAt: string | null }) => o.type === 'build' && o.startedAt === null
);
if (!waitingBatch || !waitingBuild)
	throw new Error('the misprice trap could not queue both orders');
// Two settlers back, by recalling the gathers they are on — a specialist is skipped, so the
// Carpenter keeps working and cannot be the one that starts either order.
const busyNow = (await readWorld()).body;
const settlerIds = new Set(
	busyNow.characters
		.filter((c: { professionId: number | null }) => c.professionId === null)
		.map((c: { id: number }) => c.id)
);
const settlerGathers = busyNow.operations.filter(
	(o: { type: string; workers: { characterId: number }[] }) =>
		o.type === 'gather' && o.workers.some((wk) => settlerIds.has(wk.characterId))
);
for (const g of settlerGathers.slice(0, 2))
	await api(`/api/assignments/${g.id}`, { method: 'DELETE' });
const restarted = (await readWorld()).body;
const startedBatch = restarted.operations.find((o: { id: number }) => o.id === waitingBatch.id);
const startedBuild = restarted.operations.find((o: { id: number }) => o.id === waitingBuild.id);
check(
	'freeing a worker starts the waiting batch by itself, on the very next read',
	[
		startedBatch?.startedAt !== null,
		startedBatch?.completeAt !== null,
		startedBatch?.workers.length
	],
	[true, true, 1]
);
const took = (o: { startedAt: string; completeAt: string }) =>
	(Date.parse(o.completeAt) - Date.parse(o.startedAt)) / 1000;
// The comparison below is only honest if both were worked at the same pace. A Carpenter picked up
// by the batch would make it quicker for the right reason and hide a wrong one, so this pins that
// the two freed bodies really were untrained.
const workedBySettler = (o: { workers: { characterId: number }[] } | undefined) =>
	!!o && o.workers.length > 0 && o.workers.every((wk) => settlerIds.has(wk.characterId));
check(
	'both auto-started orders were taken by untrained settlers, so the pace is held constant',
	[workedBySettler(startedBatch), workedBySettler(startedBuild)],
	[true, true]
);
check(
	`an auto-started batch is timed from craft_seconds, not the Sawmill's build_seconds ` +
		`(${startedBuild ? took(startedBuild) : '?'}s to build one, ${startedBatch ? took(startedBatch) : '?'}s to run one)`,
	startedBatch && startedBuild ? took(startedBatch) < took(startedBuild) : 'one never started',
	true
);
// Frees the workshop again for the affordability check below.
await api(`/api/orders/${waitingBatch.id}`, { method: 'DELETE' });
await api(`/api/orders/${waitingBuild.id}`, { method: 'DELETE' });
// And quiets the realm. Half the tiles the queue group occupied are forest, so woodcutters are
// still earning — and "the refusal moved no Wood" measured against a rising number is a race, not
// an assertion. Same reasoning as `heldOf` naming one resource rather than comparing all of stock.
for (const g of (await readWorld()).body.operations.filter(
	(o: { type: string }) => o.type === 'gather'
))
	await api(`/api/assignments/${g.id}`, { method: 'DELETE' });

// Cannot afford it beats everyone is busy: the first is a standing fact about the realm, the second
// is a minute old. Draining by ordering Houses is what makes this reachable — every order takes its
// cost at once, whether it starts or queues.
const spendable = (w: {
	gridSize: number;
	terrain: number[];
	terrainTypes: { id: number; buildableTypeIds: number[] }[];
	buildings: { x: number; y: number }[];
	operations: { type: string; destX: number; destY: number }[];
	reach: { x: number; y: number; radius: number };
}) => {
	const out: [number, number][] = [];
	for (let i = 0; i < w.terrain.length; i++) {
		const t = w.terrainTypes.find((tt) => tt.id === w.terrain[i]);
		if (!t?.buildableTypeIds.includes(house)) continue;
		const x = i % w.gridSize;
		const y = Math.floor(i / w.gridSize);
		if (w.buildings.some((b) => b.x === x && b.y === y)) continue;
		if (w.operations.some((o) => o.type === 'build' && o.destX === x && o.destY === y)) continue;
		// Inside the circle, or the order is refused OUTSIDE_REACH and spends nothing. Draining Wood is
		// the whole point of this loop, so a refused order does not just fail to help — it never lowers
		// the number the loop is waiting on, and the walk runs the full map at a few seconds a request.
		if (!withinReach(x, y, w.reach)) continue;
		out.push([x, y]);
	}
	return out;
};
let broke = (await readWorld()).body;
for (const [x, y] of spendable(broke)) {
	if (woodHeld(broke) < 20) break;
	const spent = await api('/api/orders', {
		method: 'POST',
		body: JSON.stringify({ x, y, buildingTypeId: house })
	});
	if (spent.status === 200) broke = spent.body;
}
const woodWhenBroke = woodHeld(broke);
const refused = await craft(...mill, 1);
check(
	'a batch you cannot afford is refused for the inputs, not for the workers',
	[woodWhenBroke < 20, refused.status, refused.body.reason],
	[true, 400, 'INSUFFICIENT_RESOURCES']
);
check('and the refusal moved no Wood at all', woodHeld((await readWorld()).body), woodWhenBroke);

// ---- The chain pays off: Wood → Planks → Furniture → a Longhouse -------------------------------
//
// The slowest group here by a distance, because it runs the ladder for real rather than asserting
// the rows it is made of: a Sawmill raised, three plank batches, a Joinery those planks paid for,
// and a furniture batch at it. Nothing here is a proxy.
const joinery = typeId('Joinery');
const longhouse = typeId('Longhouse');

const capacityOf = (name: string) =>
	world.body.buildingTypes.find((t: { displayName: string }) => t.displayName === name)
		.housingCapacity;
check(
	`a Longhouse houses more than a House (${capacityOf('Longhouse')} against ${capacityOf('House')})`,
	capacityOf('Longhouse') > capacityOf('House'),
	true
);
check(
	'no terrain anywhere yields Furniture — it exists only at the end of a chain',
	world.body.terrainTypes.some(
		(t: { yieldsResourceId: number | null }) =>
			t.yieldsResourceId ===
			world.body.resources.find((r: { displayName: string }) => r.displayName === 'Furniture').id
	),
	false
);

cookie = '';
const ladder = await readWorld();
check(
	'a fresh realm is rich in Wood and still cannot buy a Longhouse',
	[woodHeld(ladder.body) >= 100, (await order(...spare, longhouse, 3)).body.reason],
	[true, 'INSUFFICIENT_RESOURCES']
);
check(
	'nor a Joinery — the middle good is load-bearing, not decorative',
	(await order(...yard, joinery, 3)).body.reason,
	'INSUFFICIENT_RESOURCES'
);

/** Places an order (or a batch) and sleeps out its clock, returning the world it landed in. */
async function runOut(label: string, placed: { status: number; body: any }) {
	const op = placed.body.operations?.find(
		(o: { completeAt: string | null }) => o.completeAt !== null
	);
	if (!op) throw new Error(`${label} was refused: ${JSON.stringify(placed.body)}`);
	return waitOut(op);
}

await runOut('the ladder Sawmill', await order(...mill, sawmill, 3));
let rung = await runOut('the first plank batch', await craft(...mill, 3));
check('the Sawmill turns Wood into Planks nobody could gather', heldOf(rung, 'Planks'), 10);

const joinerySite = await order(...yard, joinery, 3);
check(
	'with Planks in hand the Joinery is accepted — bought with a good that had to be made',
	[joinerySite.status, heldOf(joinerySite.body, 'Planks')],
	[200, 0]
);
await runOut('the Joinery', joinerySite);
// Two more batches, because the Joinery's own price ate the first one. A workshop runs one batch at
// a time, so these are genuinely sequential.
await runOut('the second plank batch', await craft(...mill, 3));
rung = await runOut('the third plank batch', await craft(...mill, 3));
check('three batches and a Joinery later, the planks are stacked up', heldOf(rung, 'Planks'), 20);

const crafted = await runOut('the furniture batch', await craft(...yard, 3));
check(
	'the Joinery turns Planks into Furniture — the middle good spent on the far one',
	[heldOf(crafted, 'Furniture'), heldOf(crafted, 'Planks')],
	[4, 8]
);
// What is left between here and a Longhouse is Wood and time, which is the payoff being *earned*
// rather than handed over. The price itself is what this pins: it is not payable in raw wood.
check(
	'and a Longhouse is still priced beyond one afternoon — the payoff is worked for',
	(await order(...spare, longhouse, 3)).body.reason,
	'INSUFFICIENT_RESOURCES'
);

console.log(failures ? `\n${failures} failed` : '\nall rules enforced server-side');
process.exit(failures ? 1 : 0);
