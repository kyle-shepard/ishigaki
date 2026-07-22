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
const house = world.body.buildingTypes[0].id;

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

console.log(failures ? `\n${failures} failed` : '\nall rules enforced server-side');
process.exit(failures ? 1 : 0);
