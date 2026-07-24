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

const order = (x: number, y: number, buildingTypeId: number) =>
	api('/api/orders', { method: 'POST', body: JSON.stringify({ x, y, buildingTypeId }) });

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
const woodHeld = (w: {
	stock: { resourceId: number; quantity: number }[];
	resources: { id: number; displayName: string }[];
}) => {
	const wood = w.resources.find((r) => r.displayName === 'Wood')!.id;
	return w.stock.find((s) => s.resourceId === wood)!.quantity;
};

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
const occupied = await order(7, 8, free);
check('(7,8) holds the hamlet', [occupied.status, occupied.body.reason], [400, 'TILE_OCCUPIED']);

// Terrain has to cost time, not just look different. Both legs are 7 tiles from the
// character's start tile, so distance is held constant and only the ground differs. The
// durations come off the public payload — asserting through psql what the wire already
// exposes would be testing round the back.
const legs: Record<string, number> = {};
for (const [x, y, label] of [
	[14, 9, 'dry'],
	[7, 2, 'wet']
] as const) {
	// A fresh sandbox per leg: the character must depart from (7,9) both times.
	cookie = '';
	await api('/api/world');
	const r = await order(x, y, free);
	const op = r.body.operations?.[0];
	if (!op) throw new Error(`order (${x},${y}) was refused: ${JSON.stringify(r.body)}`);
	// The travel leg is per-worker now — each member of a crew leaves from their own tile. One
	// worker on this order, so its arrival *is* the leg.
	legs[label] = (Date.parse(op.workers[0].arrivesAt) - Date.parse(op.startedAt)) / 1000;
}
// A ratio, not the literals — the spread survives future cost tuning, the numbers wouldn't.
check(
	`7 tiles of lake (${legs.wet}s) costs 3x+ the same distance of meadow (${legs.dry}s)`,
	legs.wet > legs.dry * 3,
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
const at = (x: number, y: number) => y * map.body.gridSize + x;
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

console.log(failures ? `\n${failures} failed` : '\nall rules enforced server-side');
process.exit(failures ? 1 : 0);
