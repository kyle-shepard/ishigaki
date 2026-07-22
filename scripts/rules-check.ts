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

// Terrain rules. The lake and mountain coordinates are the seed layout's; the accepted three
// cover plain ground, forest, and a deposit — deposits are buildable by design.
for (const [x, y, label] of [
	[7, 5, 'lake'],
	[0, 0, 'mountain']
] as const) {
	const r = await order(x, y, free);
	check(`(${x},${y}) ${label} is refused`, [r.status, r.body.reason], [400, 'TILE_NOT_BUILDABLE']);
}
for (const [x, y, label] of [
	[14, 9, 'meadow'],
	[11, 1, 'forest'],
	[12, 5, 'clay pit']
] as const) {
	// One character, one order at a time — a fresh sandbox per case keeps NO_IDLE_CHARACTER
	// out of what is meant to be a terrain assertion.
	cookie = '';
	await api('/api/world');
	const r = await order(x, y, free);
	check(`(${x},${y}) ${label} is accepted`, r.status, 200);
}

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
	legs[label] = (Date.parse(op.travelDoneAt) - Date.parse(op.startedAt)) / 1000;
}
// A ratio, not the literals — the spread survives future cost tuning, the numbers wouldn't.
check(
	`7 tiles of lake (${legs.wet}s) costs 3x+ the same distance of meadow (${legs.dry}s)`,
	legs.wet > legs.dry * 3,
	true
);

// Cost. A realm starts with nothing, so the very first House is the refusal case — no setup
// needed, and it is also the state a real new player is in. Asserted off the world payload's
// own stock rather than through psql, same rule as the travel legs.
//
// The matching *success* case is deliberately absent: at the seeded rate, affording a House
// is a couple of hours of gathering, and a check that waited that long would never be run.
// Watching a build actually get paid for is the rate-cranked manual pass — set units_per_hour
// high with one UPDATE, no deploy, and the economy runs in seconds. That the cost is a row is
// what makes it testable at all.
cookie = '';
const fresh = await api('/api/world');
const woodId = fresh.body.resources.find(
	(r: { displayName: string }) => r.displayName === 'Wood'
).id;
const houseCost = fresh.body.buildingCosts.find(
	(c: { buildingTypeId: number; resourceId: number }) =>
		c.buildingTypeId === house && c.resourceId === woodId
).quantity;

check('a new realm starts with nothing', woodHeld(fresh.body), 0);
const refused = await order(9, 9, house);
check(
	`a House costing ${houseCost} Wood is refused on 0`,
	[refused.status, refused.body.reason],
	[400, 'INSUFFICIENT_RESOURCES']
);
check('a refused order spends nothing', woodHeld((await api('/api/world')).body), 0);

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
