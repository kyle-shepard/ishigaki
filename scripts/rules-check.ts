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

// Terrain rules. The lake and mountain coordinates are the seed layout's; the accepted three
// cover plain ground, forest, and a deposit — deposits are buildable by design.
for (const [x, y, label] of [
	[7, 5, 'lake'],
	[0, 0, 'mountain']
] as const) {
	const r = await order(x, y, house);
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
	const r = await order(x, y, house);
	check(`(${x},${y}) ${label} is accepted`, r.status, 200);
}

// Unregressed: the rules that existed before terrain did.
cookie = '';
await api('/api/world');
const oob = await order(99, 0, house);
check('(99,0) is off the map', [oob.status, oob.body.reason], [400, 'OUT_OF_BOUNDS']);
const occupied = await order(7, 8, house);
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
	const r = await order(x, y, house);
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

// A build costs, and an order you can't pay for is refused without spending anything. Asserted
// off the world payload's own stock rather than through psql — same rule as the travel legs,
// and the cost is read from the payload too, so retuning the row doesn't break the check.
cookie = '';
const fresh = await api('/api/world');
const before = woodHeld(fresh.body);
const woodId = fresh.body.resources.find(
	(r: { displayName: string }) => r.displayName === 'Wood'
).id;
const houseCost = fresh.body.buildingCosts.find(
	(c: { buildingTypeId: number; resourceId: number }) =>
		c.buildingTypeId === house && c.resourceId === woodId
).quantity;

// On the character's own tile, so the trip is zero-length and only the build itself has to
// elapse below.
const bought = await order(7, 9, house);
check('a House costs Wood', [bought.status, woodHeld(bought.body)], [200, before - houseCost]);

// The idle check runs before the cost check, so seeing INSUFFICIENT_RESOURCES needs a realm
// that is both broke *and* free — which means waiting out the build above rather than firing a
// second order at a busy character. The wait is the build time; there is no shortcut that
// doesn't test a different rule.
const deadline = Date.now() + 60_000;
while (Date.now() < deadline) {
	const w = await api('/api/world');
	if (w.body.operations.length === 0) break;
	await new Promise((r) => setTimeout(r, 1000));
}
const refused = await order(9, 9, house);
check(
	`a House costing ${houseCost} Wood is refused on ${before - houseCost}`,
	[refused.status, refused.body.reason],
	[400, 'INSUFFICIENT_RESOURCES']
);
check(
	'a refused order spends nothing',
	woodHeld((await api('/api/world')).body),
	before - houseCost
);

console.log(failures ? `\n${failures} failed` : '\nall rules enforced server-side');
process.exit(failures ? 1 : 0);
