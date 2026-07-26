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

// Every coordinate below is written against the map's **hand-authored core** — the lake, the stone
// outcrop, the hamlet's own tile — because that is where those features are authored and that frame
// is stable (scripts/seed.ts, LAYOUT in worldgen.ts). The core sits in the middle of a generated
// 48×48 world, so it has to be shifted into the coordinates the API speaks. Imported rather than
// written out: when the map grew, forty hardcoded coordinates here quietly started naming generated
// ground, and half these checks passed against tiles that were no longer what they claimed.
import { LAYOUT_OFFSET, START } from '../src/lib/features/world/worldgen.ts';
const core = (x: number, y: number) => [x + LAYOUT_OFFSET, y + LAYOUT_OFFSET] as const;
// And back again, for the few checks that name a tile the *game* chose rather than one the map
// author did — the hamlet's own tile is derived from the terrain now, not written down.
const fromWorld = (x: number, y: number) => [x - LAYOUT_OFFSET, y - LAYOUT_OFFSET] as const;

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

// x, y are core coordinates (see `core` above); the wire gets world ones.
const order = (cx: number, cy: number, buildingTypeId: number, crewSize?: number) => {
	const [x, y] = core(cx, cy);
	return api('/api/orders', {
		method: 'POST',
		body: JSON.stringify({ x, y, buildingTypeId, crewSize })
	});
};

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failures++;
	console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `  — got ${JSON.stringify(actual)}`}`);
}

// The first call creates the sandbox, so the cookie exists before any order is placed.
const world = await api('/api/world');
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
const heldOf = (w: Held, name: string) => {
	const id = w.resources.find((r) => r.displayName === name)!.id;
	return w.stock.find((s) => s.resourceId === id)?.quantity ?? 0;
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

const assign = (cx: number, cy: number) => {
	const [x, y] = core(cx, cy);
	return api('/api/assignments', { method: 'POST', body: JSON.stringify({ x, y }) });
};

// Terrain rules. `free` is the uncosted type (Barn), so these isolate the ground rule from cost.
// Unbuildable ground and every *deposit* refuse a plain building: a deposit offers only its own
// extractor (a Quarry on an outcrop), and Clay/Iron have no extractor yet — so nothing at all.
for (const [x, y, label] of [
	[7, 5, 'lake'],
	[0, 0, 'mountain'],
	[2, 1, 'iron vein'],
	[14, 3, 'stone outcrop'],
	[12, 5, 'clay pit']
] as const) {
	const r = await order(x, y, free);
	check(
		`(${x},${y}) ${label} refuses a plain building`,
		[r.status, r.body.reason],
		[400, 'TILE_NOT_BUILDABLE']
	);
}
// Plain buildable ground takes the uncosted type. One order at a time — a fresh sandbox per case
// keeps NO_IDLE_CHARACTER out of what is meant to be a terrain assertion.
for (const [x, y, label] of [
	[14, 9, 'meadow'],
	[11, 1, 'forest']
] as const) {
	cookie = '';
	await api('/api/world');
	const r = await order(x, y, free);
	check(`(${x},${y}) ${label} is accepted`, r.status, 200);
}

// The deposit rule cuts both ways, and terrain is judged before cost — so even a costed type shows
// the ground rule cleanly. An extractor belongs only on its deposit; a plain building never does.
const quarry = typeId('Quarry');
cookie = '';
await api('/api/world');
check(
	'a Quarry is refused on a meadow — an extractor may not squat on plain ground',
	[(await order(14, 9, quarry)).body.reason],
	['TILE_NOT_BUILDABLE']
);
cookie = '';
await api('/api/world');
check(
	'a House is refused on an iron vein — a plain building may not squat on a deposit',
	[(await order(2, 1, house)).body.reason],
	['TILE_NOT_BUILDABLE']
);
cookie = '';
await api('/api/world');
check(
	'a Quarry is accepted on a Stone outcrop — the deposit offers exactly its extractor',
	(await order(14, 3, quarry)).status,
	200
);

// Unregressed: the rules that existed before terrain did.
cookie = '';
await api('/api/world');
const oob = await order(99, 0, free);
check('(99,0) is off the map', [oob.status, oob.body.reason], [400, 'OUT_OF_BOUNDS']);
const occupied = await order(...fromWorld(START.hamletX, START.hamletY), free);
check(
	`(${START.hamletX},${START.hamletY}) holds the hamlet`,
	[occupied.status, occupied.body.reason],
	[400, 'TILE_OCCUPIED']
);

// Terrain has to change the route, not just cost time. Both legs are the same distance from the
// settlers' start row — 4 across and 9 up, mirrored either side of it — so distance is held
// constant and only the ground differs: the authored lake lies between the start and the western
// one, and the eastern one is open ground. Both the durations and the routes come off the public
// payload — asserting through psql what the wire already exposes would be testing round the back.
const legs: Record<string, { seconds: number; wet: number; steps: number }> = {};
for (const [x, y, label] of [
	[13, 2, 'dry'],
	[5, 2, 'wet']
] as const) {
	// A fresh sandbox per leg: the same body has to depart from the same tile both times.
	cookie = '';
	const fresh = await api('/api/world');
	const r = await order(x, y, free);
	const op = r.body.operations?.[0];
	if (!op) throw new Error(`order (${x},${y}) was refused: ${JSON.stringify(r.body)}`);
	// The route as walked, off the payload — the same array the client draws the body along.
	const w = op.workers[0];
	const g = fresh.body.gridSize;
	const water = fresh.body.terrainTypes.find(
		(t: { displayName: string }) => t.displayName === 'Water'
	).id;
	legs[label] = {
		seconds: (Date.parse(w.arrivesAt) - Date.parse(op.startedAt)) / 1000,
		wet: w.path.filter((i: number) => fresh.body.terrain[i] === water).length,
		steps: w.path.length
	};
}
// Nobody swims. This is what routing bought, and it is the assertion that would have been
// impossible to write before: the destination beyond the lake is reached without a single tile of
// water under anyone's feet. It used to be measured the other way round — a body ploughing straight
// through five tiles of lake, three times slower for it.
check('the route to the far shore crosses no water at all', legs.wet.wet, 0);
check('the dry leg crosses no water either, and never did', legs.dry.wet, 0);
// The detour is still a real cost: going round takes more steps and more time than the same
// distance over open ground. A ratio would be wrong here — walking around a lake is not three
// times anything, it is just longer.
check(
	`going round the lake (${legs.wet.seconds}s, ${legs.wet.steps} steps) costs more than open ground (${legs.dry.seconds}s, ${legs.dry.steps} steps)`,
	legs.wet.seconds > legs.dry.seconds && legs.wet.steps > legs.dry.steps,
	true
);

// The runway and the refund path. A fresh realm no longer starts empty — it arrives stocked
// (VISION #10) so it can build before it has to gather. Stock is asserted off the payload's own
// numbers, same rule as the travel legs.
cookie = '';
const fresh = await api('/api/world');
const woodStart = woodHeld(fresh.body);
check('a new realm arrives with a Wood runway', woodStart > 0, true);

// Cancel a build: the operation vanishes and the FULL cost returns — never prorated, never
// double-credited. This is the epic's refund path, and its arithmetic is the thing to pin.
const built = await order(9, 9, house);
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
	woodHeld((await api('/api/world')).body),
	woodStart
);
// The cancelled op left nothing behind: the tile is buildable again and a worker is free to take it.
check('the cancelled tile is buildable again', (await order(9, 9, house)).status, 200);

// The realm-wide build prerequisite: a Stone wall needs a Quarry standing *anywhere* first. With
// none owned it is refused before terrain or cost matter — a distinct reason from the tile-local
// MISSING_REQUIRED_BUILDING that gates gathering.
cookie = '';
await api('/api/world');
const stoneWall = typeId('Stone wall');
check(
	'a Stone wall with no Quarry owned is refused as a missing prerequisite',
	[(await order(9, 9, stoneWall)).body.reason],
	['MISSING_PREREQUISITE']
);

// Gathering. The refusals matter more than the acceptance: a tile that yields nothing must be
// turned away at the writer, or a worker stands there forever earning nothing with no feedback.
// The clay pit is the sharp case — it *does* name a resource, it just has no rate yet, so a
// null-check alone would wave it through.
for (const [x, y, label] of [
	[0, 0, 'mountain — yields nothing'],
	[12, 5, 'clay pit — yields a resource with no rate']
] as const) {
	const r = await assign(x, y);
	check(`(${x},${y}) ${label} is refused`, [r.status, r.body.reason], [400, 'TILE_YIELDS_NOTHING']);
}

const gathering = await assign(11, 1);
const gather = gathering.body.operations?.find((o: { type: string }) => o.type === 'gather');
check(
	'(11,1) forest accepts a worker, on an operation that never completes by itself',
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
const map = await api('/api/world');
const at = (cx: number, cy: number) => {
	const [x, y] = core(cx, cy);
	return y * map.body.gridSize + x;
};
check(
	'an untouched forest tile reports full',
	[map.body.tileQuantity[at(11, 1)], map.body.tileCapacity[at(11, 1)]],
	[25, 25]
);
check(
	'a stone outcrop never runs down, so it counts nothing',
	[map.body.tileQuantity[at(14, 3)], map.body.tileCapacity[at(14, 3)]],
	[null, null]
);
check(
	'ground that yields nothing counts nothing',
	[map.body.tileQuantity[at(0, 0)], map.body.tileCapacity[at(0, 0)]],
	[null, null]
);

// The quarry gate. Wood and forage need a person; stone needs the structure first, and the
// structure has to be on the tile being worked — not merely somewhere in the realm.
cookie = '';
await api('/api/world');
const bare = await assign(15, 11);
check(
	'(15,11) a stone outcrop with no quarry on it is refused',
	[bare.status, bare.body.reason],
	[400, 'MISSING_REQUIRED_BUILDING']
);
check('(11,1) forest still needs no building at all', (await assign(11, 1)).status, 200);

// Crews. A build takes more than one body now, and more bodies must actually finish it sooner.
// Asserted off the payload's own clock rather than by waiting a build out — a fresh sandbox for
// each size, same tile, so the only thing that differs is the headcount. (A realm starts with
// three, which is why 3 is the crowd here.)
const crewed: Record<number, { workers: number; seconds: number }> = {};
for (const size of [1, 3]) {
	cookie = '';
	await api('/api/world');
	const r = await order(14, 9, free, size);
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
const small = await api('/api/world');
const everyone = await order(14, 9, free, 99);
check(
	'asking for more hands than you have sends everyone, rather than refusing',
	everyone.body.operations?.[0]?.workers.length,
	small.body.characters.length
);

// Preview = outcome. This is a stated failure condition of the epic — "the numbers shown before
// you commit aren't the ones you get" — and it can only be closed by asserting the quote against
// the thing actually written. Both go through `planBuild`, so this is what proves that.
const estimateOf = (cx: number, cy: number, buildingTypeId: number, crewSize: number) => {
	const [x, y] = core(cx, cy);
	return api('/api/orders/estimate', {
		method: 'POST',
		body: JSON.stringify({ x, y, buildingTypeId, crewSize })
	});
};

for (const size of [1, 3]) {
	cookie = '';
	await api('/api/world');
	const quote = await estimateOf(14, 9, free, size);
	const placed = await order(14, 9, free, size);
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
await api('/api/world');
check(
	'estimating an unbuildable tile refuses with the reason the order would give',
	[(await estimateOf(0, 0, free, 1)).status, (await estimateOf(0, 0, free, 1)).body.reason],
	[400, 'TILE_NOT_BUILDABLE']
);
// And it spends nothing: quoting is not ordering.
const beforeQuote = woodHeld((await api('/api/world')).body);
await estimateOf(9, 9, house, 3);
check(
	'an estimate costs nothing — quoting is not ordering',
	woodHeld((await api('/api/world')).body),
	beforeQuote
);

// The whole chain, asserted in one go: what the preview promised is what the *building* carries.
// Deliberately the slow case — it waits out a real build — because without it "preview = outcome"
// is only ever proved as far as the operation, and the durable output this epic exists to capture
// would have no check at all.
cookie = '';
await api('/api/world');
const promised = await estimateOf(14, 9, free, 3);
const raised = await order(14, 9, free, 3);
const rising = raised.body.operations?.[0];
if (!rising) throw new Error('the build-for-quality order was refused');
const dueAt = Date.parse(rising.completeAt);
let finished: { quality: number } | undefined;
// Bounded: a 3-settler Barn is ~100s of build plus travel. Polling is what makes the building
// appear at all — the server resolves on read, so nobody looking means nobody building.
while (Date.now() < dueAt + 15_000) {
	await new Promise((r) => setTimeout(r, 3000));
	const w = await api('/api/world');
	const [bx, by] = core(14, 9);
	finished = w.body.buildings.find((b: { x: number; y: number }) => b.x === bx && b.y === by);
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
const hamlet = (await api('/api/world')).body.buildings.find(
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
const restricted = (cx: number, cy: number, ids: number[] | null, crewSize = 3) => {
	const [x, y] = core(cx, cy);
	return api('/api/orders', {
		method: 'POST',
		body: JSON.stringify({ x, y, buildingTypeId: free, crewSize, allowedProfessionIds: ids })
	});
};
const professionId = (name: string) => {
	const p = world.body.professions.find((q: { displayName: string }) => q.displayName === name);
	if (!p) throw new Error(`no '${name}' profession — seed the database`);
	return p.id;
};

cookie = '';
await api('/api/world');
// A fresh realm is three settlers, so it has no Mason at all. This *queues* rather than refusing —
// an unsatisfiable filter and a realm where everyone is busy are the same situation, and both
// resolve themselves the moment a qualifying worker exists.
const noMason = await restricted(14, 9, [professionId('Mason')]);
const waiting = noMason.body.operations?.find((o: { type: string }) => o.type === 'build');
check(
	'an order restricted to a trade nobody has waits instead of bouncing',
	[noMason.status, waiting?.startedAt, waiting?.completeAt, waiting?.workers.length],
	[200, null, null, 0]
);
// An id no profession carries must fail loudly at order time — Postgres cannot foreign-key an
// array element, so this refusal *is* the referential integrity for that column. Silently it
// would match nobody and read as "everyone is busy".
const bogus = await restricted(14, 9, [999999]);
check(
	'a filter naming a profession that does not exist is refused as unknown, not as "everyone is busy"',
	[bogus.status, bogus.body.reason],
	[400, 'UNKNOWN_PROFESSION']
);
// Unchecking everything is not "nobody may build this".
cookie = '';
await api('/api/world');
check('an empty filter means anyone, not nobody', (await restricted(14, 9, [])).status, 200);

// The queue. Placing a build with everyone busy no longer bounces: it holds the tile and the cost
// it has already paid, and starts itself when a worker frees. Reserving at queue time is the whole
// point — deducting at start would reintroduce the silent-failure-while-away this model avoids.
const occupyEveryone = async () => {
	for (const [gx, gy] of [
		[11, 1],
		[12, 1],
		[11, 2]
	] as const)
		await assign(gx, gy);
};

cookie = '';
const busyRealm = await api('/api/world');
const woodBefore = woodHeld(busyRealm.body);
await occupyEveryone();
const heldUp = await order(9, 9, house);
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
	(await order(9, 9, house)).body.reason,
	'TILE_OCCUPIED'
);
// Free one gatherer, and the waiting build takes them on the very next read.
const gathering2 = (await api('/api/world')).body.operations.filter(
	(o: { type: string }) => o.type === 'gather'
);
await api(`/api/assignments/${gathering2[0].id}`, { method: 'DELETE' });
const startedItself = (await api('/api/world')).body.operations.find(
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
const q2 = await api('/api/world');
const woodQ2 = woodHeld(q2.body);
await occupyEveryone();
const toCancel = (await order(9, 9, house)).body.operations?.find(
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
const mill = fromWorld(START.characterX, START.characterY + 1);
const yard = fromWorld(START.characterX + 2, START.characterY + 1);

const craft = (cx: number, cy: number, crewSize?: number, allowedProfessionIds?: number[]) => {
	const [x, y] = core(cx, cy);
	return api('/api/craft', {
		method: 'POST',
		body: JSON.stringify({ x, y, crewSize, allowedProfessionIds })
	});
};
/** Sleeps until an operation is genuinely due, then reads **once**. Nothing looks in between. */
async function waitOut(op: { completeAt: string }, slackMs = 2000) {
	const wait = Date.parse(op.completeAt) - Date.now() + slackMs;
	if (wait > 0) await new Promise((r) => setTimeout(r, wait));
	return (await api('/api/world')).body;
}
const stands = (
	w: { buildings: { x: number; y: number }[] },
	[cx, cy]: readonly [number, number]
) => {
	const [x, y] = core(cx, cy);
	return w.buildings.some((b) => b.x === x && b.y === y);
};
type WireOp = {
	id: number;
	type: string;
	startedAt: string;
	completeAt: string;
	workers: { characterId: number }[];
};
const craftOp = (w: { operations: WireOp[] }) => w.operations.find((o) => o.type === 'craft');

cookie = '';
const shopStart = await api('/api/world');
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
const atHamlet = fromWorld(START.hamletX, START.hamletY);
check(
	'crafting at a House is refused too — a workshop is a type that carries a recipe',
	(await craft(...atHamlet)).body.reason,
	'NOT_A_WORKSHOP'
);

// A gather is recalled, not cancelled. The cancel path widened to crafts, not to everything: left
// as "anything unfinished", this would delete a working gather, refund nothing, and free the body
// with none of recallWorker's semantics.
const working = (await assign(11, 1)).body.operations.find(
	(o: { type: string }) => o.type === 'gather'
);
check(
	'a gather id is still refused by the build/craft cancel path',
	(await api(`/api/orders/${working.id}`, { method: 'DELETE' })).body.reason,
	'UNKNOWN_OPERATION'
);
check(
	'and the gather is still running, not quietly deleted',
	(await api('/api/world')).body.operations.some((o: { id: number }) => o.id === working.id),
	true
);
await api(`/api/assignments/${working.id}`, { method: 'DELETE' });

// The order itself: inputs leave stock at the click, and the batch is one operation with a clock.
const woodBeforeBatch = woodHeld((await api('/api/world')).body);
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
	woodHeld((await api('/api/world')).body),
	woodBeforeBatch
);

// The payoff, and the offline promise with it: order it, walk away, and the planks are there when
// you come back — credited once, on the first read that happens after it was due.
const planksBefore = heldOf((await api('/api/world')).body, 'Planks');
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
	heldOf((await api('/api/world')).body, 'Planks'),
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
const [bx, by] = core(...yard);
const training = await api('/api/training', {
	method: 'POST',
	body: JSON.stringify({ x: bx, y: by, professionId: carpenter })
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
	const idle = (await api('/api/world')).body.characters.length;
	for (const [gx, gy] of [
		[11, 1],
		[12, 1],
		[11, 2],
		[12, 2],
		[13, 1],
		[13, 2]
	] as const) {
		const w = (await api('/api/world')).body;
		if (w.operations.filter((o: { type: string }) => o.type === 'gather').length >= idle) break;
		await assign(gx, gy);
	}
};
await busyEveryone();
const woodBeforeQueue = woodHeld((await api('/api/world')).body);
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
const spare = fromWorld(START.characterX - 2, START.characterY + 1);
const waitingBuild = (await order(...spare, sawmill, 1)).body.operations?.find(
	(o: { type: string; startedAt: string | null }) => o.type === 'build' && o.startedAt === null
);
if (!waitingBatch || !waitingBuild)
	throw new Error('the misprice trap could not queue both orders');
// Two settlers back, by recalling the gathers they are on — a specialist is skipped, so the
// Carpenter keeps working and cannot be the one that starts either order.
const busyNow = (await api('/api/world')).body;
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
const restarted = (await api('/api/world')).body;
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
for (const g of (await api('/api/world')).body.operations.filter(
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
}) => {
	const out: [number, number][] = [];
	for (let i = 0; i < w.terrain.length; i++) {
		const t = w.terrainTypes.find((tt) => tt.id === w.terrain[i]);
		if (!t?.buildableTypeIds.includes(house)) continue;
		const x = i % w.gridSize;
		const y = Math.floor(i / w.gridSize);
		if (w.buildings.some((b) => b.x === x && b.y === y)) continue;
		if (w.operations.some((o) => o.type === 'build' && o.destX === x && o.destY === y)) continue;
		out.push([x, y]);
	}
	return out;
};
let broke = (await api('/api/world')).body;
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
check(
	'and the refusal moved no Wood at all',
	woodHeld((await api('/api/world')).body),
	woodWhenBroke
);

console.log(failures ? `\n${failures} failed` : '\nall rules enforced server-side');
process.exit(failures ? 1 : 0);
