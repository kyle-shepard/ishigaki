// Client-safe: shared constants, wire types, and the position math. No db imports.

// 128×128 — the first clean cut (see WORLD_SEED in worldgen.ts). Past hand-authoring, so the
// whole grid comes from worldgen.ts's generator now; nothing here still names an authored core.
export const GRID_SIZE = 128;

// START used to live here. It is derived from the terrain now — see `findStart` in worldgen.ts —
// because a written-down coordinate cannot notice that the ground under it has become a lake.

// Zoom is continuous, but what the client draws is not — three named tiers, and these two numbers
// are the whole boundary between them. One pair of constants rather than a fact restated in both
// +page.svelte's tier derivation and MapCanvas's own "is this far enough out to skip the art" check,
// so the two can't quietly drift apart.
export const TIER_MIDDLE_MIN = 8; // below this: flat colour only, no art, no overlays
export const TIER_CLOSE_MIN = 24; // at or above this: full art, and buildings/pawns/roads draw

// The opening reach radius — one number, two jobs. It is the first rung of the seeded
// reach_milestone table, and it is the circle `findStart` (worldgen.ts) must guarantee holds a
// Forest and a Stone outcrop before it will settle on a hamlet: the sphere of influence gates
// gathering as well as building, so "reachable" now means "in reach" from the very first tile.
// Authored once here, in the `eligibleTypeIds` shape this codebase already prefers, so the search
// and the seeded table it is searching for can never quietly disagree about where the ladder starts.
export const START_REACH_RADIUS = 6;

/**
 * The world coordinate (in cell units, fractional) under a pane-relative pixel — read the pane's
 * own scrollLeft/scrollTop as `scroll` and a pixel offset from the pane's edge as `px`, on the same
 * axis. The one piece of arithmetic MapCanvas's hit testing and the zoom-about-cursor maths below
 * both need, so it exists once rather than as two copies that could disagree about a half-pixel.
 */
export function tileAt(scroll: number, px: number, cell: number): number {
	return (scroll + px) / cell;
}

/**
 * The scroll offset that keeps the same world point under the same pixel after `cell` becomes
 * `nextCell` — "zoom about the cursor" is just `tileAt` read backwards at the new scale. Wheel,
 * pinch and the +/- buttons all call this once per step; the invariant it guarantees — the point
 * under the pointer never drifts — is what world.test.ts pins.
 */
export function zoomAbout(scroll: number, px: number, cell: number, nextCell: number): number {
	return tileAt(scroll, px, cell) * nextCell - px;
}

export type OrderReason =
	| 'OUT_OF_BOUNDS'
	| 'UNKNOWN_BUILDING_TYPE'
	| 'TILE_NOT_BUILDABLE'
	// Outside the realm's reach — the sphere of influence a Marketplace projects. Gates both a
	// build order and a gather assignment (it's a sphere of influence, not a building permit); it
	// does *not* gate crafting or training, because both happen at a building and a building is
	// necessarily inside the reach that let it be built — a second check there would guard a case
	// that cannot arise.
	| 'OUTSIDE_REACH'
	| 'TILE_OCCUPIED'
	| 'NO_IDLE_CHARACTER'
	| 'INSUFFICIENT_RESOURCES'
	| 'TILE_YIELDS_NOTHING'
	| 'MISSING_REQUIRED_BUILDING'
	// A realm-wide build prerequisite isn't met — you don't yet own the building this type needs
	// (a Stone wall before any Quarry). Distinct from MISSING_REQUIRED_BUILDING, which is
	// tile-local ("a Quarry on *this* tile"); this one is "a Quarry *anywhere*".
	| 'MISSING_PREREQUISITE'
	| 'UNKNOWN_OPERATION'
	// Training-specific: a settler is needed (not just any idle body), a School must stand on the
	// tile, and the chosen profession must exist.
	| 'NO_IDLE_SETTLER'
	| 'MISSING_SCHOOL'
	| 'UNKNOWN_PROFESSION'
	// Restyling something that is not a road you own. Deliberately one reason for both halves —
	// "no such building" and "not a road" — because a building belonging to somebody else must not
	// be distinguishable from one that does not exist.
	| 'NOT_A_ROAD'
	// Crafting: the tile holds no workshop of yours (no building, someone else's, or one whose type
	// carries no recipe — one reason for all three, same argument as NOT_A_ROAD), and a workshop
	// already working a batch takes no second one.
	| 'NOT_A_WORKSHOP'
	| 'WORKSHOP_BUSY';

// crewSize is how many bodies to send — a *maximum*, not a requirement: the order takes up to that
// many of the qualifying idle workers and is happy with fewer. Optional on the wire so an older
// client, and every existing caller, still means "one".
//
// allowedProfessionIds narrows who may work it. Absent, null or empty all mean anyone — an empty
// list is a player who unchecked everything, and reading that as "nobody may build this" would be
// a rule they didn't ask for.
export type OrderRequest = {
	x: number;
	y: number;
	buildingTypeId: number;
	crewSize?: number;
	allowedProfessionIds?: number[] | null;
};
export type TrainRequest = { x: number; y: number; professionId: number };
// Ordering a batch at a workshop. No buildingTypeId: the tile already holds the building, and that
// building's type *is* the recipe — asking the client to name it would be asking it to agree with
// what is standing there.
export type CraftRequest = {
	x: number;
	y: number;
	crewSize?: number;
	allowedProfessionIds?: number[] | null;
};

// The same shape as an order, because it asks the same question — it just doesn't spend.
export type EstimateRequest = OrderRequest;
export type EstimateResponse = {
	/**
	 * Whole seconds from placing the order to the finished building, travel included — and null
	 * with an empty crew, which is the honest answer to "when?" for a build that has nobody to do
	 * it yet. It will queue, and the panel says so instead of quoting a time it cannot know.
	 */
	seconds: number | null;
	quality: number | null;
	/** The bodies that would go, best first. `name`/`professionId` null for a settler. */
	crew: { characterId: number; name: string | null; professionId: number | null }[];
};

// Where the five bands fall. Tuning, not structure — retune the numbers, not the code.
//
// Five even cuts of [0.15, 0.80]: the settler baseline at the bottom, and at the top the observed
// ceiling of a well-rolled specialist working their own trade (a Carpenter measured at 0.80 —
// bundle 0.7 swung up by good stats). Anchored on what the game actually produces rather than on
// the round numbers in the design, because a band that never changes as you rebuild the crew tells
// the player nothing, which is the exact failure showing a raw 0.44 would have been.
const BANDS: [number, string][] = [
	[0.28, 'Rough'],
	[0.41, 'Fair'],
	[0.54, 'Good'],
	[0.67, 'Fine']
];

/**
 * Quality as a word. `0.44` on screen is not information — nobody knows whether that is good, and
 * the raw number belongs in a tooltip rather than the sentence.
 *
 * One function, used by both the preview and the finished building, so the two can never disagree
 * about what a number means. That is the whole reason it is here rather than inline in the panel.
 */
export function qualityBand(quality: number): string {
	return BANDS.find(([ceiling]) => quality < ceiling)?.[1] ?? 'Masterwork';
}

// ponytail: the whole world, every read. Terrain dominates the payload, and at 128×128 that is
// 16,384 small ints row-major, plus one dense same-length array for the live deposit levels
// (`tileQuantity`), most of whose entries are `null`. `tileCapacity` used to be a second dense
// array here; it shipped the same fact 16,384 times (capacity is a pure function of terrain type,
// per terrainType.capacity below), so it moved into the catalog instead. `tileQuantity` stays
// dense — going sparse trades bytes for client code, and that trade wants a measurement before
// it's made, not a guess.
//
// **KNOWN PROBLEM, measured, not yet fixed — see readWorld in world.server.ts.** An earlier
// version of this note weighed the response at "a few hundred KB, gzipped to a fraction" and
// concluded it was fine at this cadence. That reasoning was about the wrong number. Gzipped it
// really is ~6 KB to the browser, and it really is fine; what is not fine is what the *database*
// sends to build it. Two statements behind this type return 28,583 rows a read — the tile grid
// and its join to resources — which is ~1.3 MB of Neon egress per request, ~200x the response
// the player receives. A 30-second heartbeat therefore costs ~156 MB an hour per open tab doing
// nothing, and in July 2026 that plus a read-heavy test suite put 8.44 GB through a 5 GB monthly
// allowance and got the project suspended mid-work.
//
// Both of those statements are static between seeds, so the ceiling is not inherent: cache them
// in process, keyed on a version `npm run seed` bumps (the invalidation matters — seeding is a
// supported live operation, so "terrain only changes on deploy" is false). That takes a read from
// ~1.3 MB to a few KB. `npm run egress` is how to watch it. Viewport culling still belongs to the
// map-client epic; this does not wait for it.
export type WorldPayload = {
	now: string;
	gridSize: number;
	// Set by the /api/world route, not by readWorld — it is a fact about *this request*
	// (the realm you asked for was gone), not about the world. True on exactly one response,
	// so the client makes it sticky rather than re-reading it.
	worldReset?: boolean;
	// The realm's sphere of influence — a circle of `radius` tiles around its Marketplace, in the
	// same (x, y) the rest of the wire uses. Drawn by the client (MapCanvas's `arc()`) and enforced
	// by the server (world.server.ts's `withinReach` gate) from these same three numbers, so the
	// line drawn and the line enforced can never disagree. Null only in principle — resolveWorld
	// throws rather than ever shipping a realm with no Marketplace, so a live payload always
	// carries a real circle; the type stays nullable for the moment before a world has loaded.
	reach: { x: number; y: number; radius: number } | null;
	terrainTypes: {
		id: number;
		displayName: string;
		color: string;
		/** Symbol id in Sprites.svelte, minus the `i-` prefix. Unknown key ⇒ colour only. */
		icon: string;
		buildable: boolean;
		yieldsResourceId: number | null;
		// The building types legal on this terrain, computed server-side by `eligibleTypeIds` — the
		// same rule the server gate enforces, so the menu can only ever offer what the writer allows.
		// Empty on unbuildable ground and on a deposit whose extractor doesn't exist yet.
		buildableTypeIds: number[];
		// How much a tile of this terrain holds when full; null where the deposit is infinite (never
		// runs out) or the ground yields nothing. One value per *type*, not per tile — the seed writes
		// the same capacity to every tile of a given terrain, so a per-tile array on the wire would be
		// the identical fact repeated once per tile. `tileQuantity` below is still per-tile: the live
		// level genuinely differs tile to tile as players draw it down.
		capacity: number | null;
	}[];
	// icon names a symbol in Sprites.svelte, minus the `i-` prefix — what the resource bar draws
	// in place of the word. Unknown or empty ⇒ nothing drawn.
	resources: { id: number; displayName: string; icon: string }[];
	// The professions a settler can be trained into, for the School's Train picker. Global
	// catalog, unfiltered by player — the callings the world offers, like building types.
	professions: { id: number; displayName: string }[];
	// What you hold, one entry per resource — fractional, because accrual is continuous. The
	// client floors it; the server never does.
	//
	// ratePerHour is where it is heading: everything being earned right now minus everything being
	// eaten, signed, for the +/- beside the number. Computed by the server (see `netRates`) rather
	// than by the client, because it is economy arithmetic — a second implementation in the panel
	// would be free to disagree with the one that actually moves the stock.
	stock: { resourceId: number; quantity: number; ratePerHour: number }[];
	// What each building type costs. A type with no entries is free.
	buildingCosts: { buildingTypeId: number; resourceId: number; quantity: number }[];
	// What one batch consumes at each workshop — the same shape as buildingCosts, because it is the
	// same question asked of the other table. Only workshop types appear.
	recipeInputs: { buildingTypeId: number; resourceId: number; quantity: number }[];
	// Row-major, index = y * gridSize + x, value = terrainTypeId — the same flat indexing the
	// client already uses to derive (x, y). movementCost is deliberately absent: nothing on the
	// client estimates travel.
	terrain: number[];
	// Row-major like `terrain`. How much this tile still holds right now; null where the deposit
	// is infinite or the ground yields nothing — pair it with the terrain type's own `capacity`
	// above to know "how full". Dense rather than a sparse list of the tiles you have touched —
	// a sparse one would have made the client learn capacity in order to fill in the gaps, which
	// is the same information arranged so that it can be got wrong.
	tileQuantity: (number | null)[];
	buildingTypes: {
		id: number;
		displayName: string;
		icon: string;
		buildSeconds: number;
		// How many settlers this type houses — the population cap is the SUM over what you have
		// built. On the wire so the build menu can say "houses 10" beside the price, which is the
		// only way a Longhouse's whole point is legible *before* you pay for it.
		housingCapacity: number;
		// What this type does to the ground's movement cost; null means nothing. Non-null is what
		// makes a type *linear infrastructure* — the client draws it as arms joining its own kind
		// rather than as a single building sprite, and routing walks bodies onto it.
		movementCost: number | null;
		// The type that must stand somewhere in your realm before this one can be placed; null if
		// none. The client greys a type whose prerequisite isn't owned, labelled with its name.
		requiresBuildingTypeId: number | null;
		// The recipe, all three or none of them. Non-null is what makes a type a **workshop**: the
		// client offers "Make 10 Planks" on one you own, and nothing else in the payload says so.
		producesResourceId: number | null;
		outputQuantity: number | null;
		craftSeconds: number | null;
	}[];
	// quality is how well it was built — null on anything raised before it was recorded, which
	// reads as nothing at all rather than as "unknown". roadMask is the player's override of a
	// road's shape; null means derive it from the neighbours (see `roadArms`).
	buildings: {
		id: number;
		x: number;
		y: number;
		buildingTypeId: number;
		quality: number | null;
		roadMask: number | null;
	}[];
	// professionId null ⇒ settler (a dot); set ⇒ a named specialist (drawn distinct). name is
	// the specialist's, null for a settler.
	//
	// The four stats ride along for the citizens roster — which of your two Masons is the better
	// one is the whole reason to open it, and they are all-or-nothing with the profession (the
	// character_tier CHECK holds that), so a settler simply has none.
	characters: {
		id: number;
		x: number;
		y: number;
		speed: number;
		professionId: number | null;
		name: string | null;
		strength: number | null;
		dexterity: number | null;
		constitution: number | null;
		intelligence: number | null;
	}[];
	operations: {
		id: number;
		type: OperationType;
		// Both null on a gather: it builds nothing, and it never finishes on its own. On a **craft**
		// this names the workshop the batch is being made at, not something being raised — which is
		// why every site-ghost and build-list filter here keys on `type === 'build'` rather than on
		// this being set.
		buildingTypeId: number | null;
		// The profession a train operation will grant; null on build/gather.
		professionId: number | null;
		destX: number;
		destY: number;
		// Both null on a queued build: it is holding its tile and its paid-for cost, waiting for a
		// worker to free. It has no crew, so it has no travel legs to draw either.
		startedAt: string | null;
		completeAt: string | null;
		// The crew. One entry for a gather or a training; a build may have several. The route and the
		// arrival are per-body because members leave from their own tiles and walk their own way —
		// the client composes one TravelLeg per worker from `{path, op.startedAt, travelDoneAt:
		// arrivesAt}`.
		//
		// `path` is the route as walked (row-major tile indices, origin first), stored rather than
		// recomputed: the body must be drawn on the route the server *timed it on*, and a road built
		// while it is walking must not reroute it retroactively.
		workers: { characterId: number; path: number[]; arrivesAt: string }[];
	}[];
};

// 'craft' is a batch at a workshop: a build in all but its ending — cost taken up front, crew solved
// by the same arithmetic, one completion time — that adds to stock instead of raising a building.
export type OperationType = 'build' | 'gather' | 'train' | 'craft';

export type AssignRequest = { x: number; y: number };

/**
 * How much a worker has taken since they were last paid out. Pure and database-free, which
 * is the point: continuous accrual is the one thing in this game that cannot be checked by
 * watching it — a thirty-day regrowth is not a test you run — so the arithmetic lives
 * somewhere `npm test` can reach it.
 *
 * Integrating elapsed time on read, rather than ticking, is what makes a week away come out
 * the same as a hundred small visits. Nothing here depends on how often it is called.
 *
 * A negative interval is not an error to shout about: `accrued_at` starts at the moment the
 * worker *arrives*, so every read while they are still walking asks about time that has not
 * happened yet. The honest answer to that is zero.
 *
 * Two clocks, because there genuinely are two. `workedSeconds` is how long *this worker* has
 * gone unpaid; `agedSeconds` is how long the *tile* has gone unmeasured. They are equal while
 * one person works one tile without pause, and they come apart the moment a tile is abandoned
 * and later returned to — a forest keeps growing whether or not anybody is standing in it.
 */
export function accrue(
	ratePerHour: number,
	workedSeconds: number,
	// null is an infinite deposit — stone, clay, iron, forage. No capacity, no clamp, no floor
	// to run into: the worker simply takes their rate.
	deposit: {
		quantity: number;
		capacity: number;
		regrowSeconds: number;
		agedSeconds: number;
	} | null
): { harvested: number; quantity: number | null } {
	const wanted = workedSeconds > 0 ? (ratePerHour * workedSeconds) / 3600 : 0;
	if (!deposit) return { harvested: wanted, quantity: null };

	const grown =
		deposit.agedSeconds > 0 ? (deposit.capacity / deposit.regrowSeconds) * deposit.agedSeconds : 0;
	// You cannot take more than is there, and what regrew during the interval is there to be
	// taken. At an emptied tile this is what the worker is left with — the regrowth itself,
	// which at ~1 tree per 29 hours against 1 per 20 minutes reads as "this forest is
	// finished" without needing a special case that says so.
	const harvested = Math.min(wanted, deposit.quantity + grown);
	// Clamped at both ends: a tile cannot go below empty, and cannot regrow past full.
	const quantity = Math.min(Math.max(deposit.quantity + grown - harvested, 0), deposit.capacity);
	return { harvested, quantity };
}

/**
 * Which way each resource is moving, per real hour, right now — the signed number the resource bar
 * paints green or red.
 *
 * Pure and database-free like `accrue` and `population`, and for the same reason: it is the only
 * thing on screen that claims to predict the future, so the two ways it can lie are worth pinning
 * in `npm test` rather than squinting at.
 *
 * **A worker still walking earns nothing.** `accrue` bills from the moment a body *arrives*, so a
 * gather ordered across the map contributes zero until then, and the bar has to say the same or it
 * is quoting income nobody is producing yet. Arrivals are per-body (a crew leaves from its own
 * tiles), so the rate steps up as they land.
 *
 * **Food drains by head count**, at the settlement's own per-capita rate — the same product
 * `population` charges. This is the one entry that is normally negative, and a hamlet whose forager
 * cannot cover its own mouths reads as red before anybody starves, which is the point.
 *
 * Not modelled, deliberately: a finite deposit running dry mid-hour (the rate is instantaneous, not
 * a forecast), and a build that will spend from stock on completion (already spent — cost is taken
 * at order time).
 */
export function netRates(
	gathers: {
		resourceId: number;
		unitsPerHour: number;
		qualityMultiplier: number;
		/** Epoch ms each body on this job reaches the tile. */
		arrivals: number[];
	}[],
	nowMs: number,
	food: { resourceId: number; perCapitaHour: number; population: number } | null
): Map<number, number> {
	const rates = new Map<number, number>();
	const add = (resourceId: number, delta: number) =>
		rates.set(resourceId, (rates.get(resourceId) ?? 0) + delta);
	for (const g of gathers) {
		const working = g.arrivals.filter((a) => a <= nowMs).length;
		if (working > 0) add(g.resourceId, g.unitsPerHour * g.qualityMultiplier * working);
	}
	if (food) add(food.resourceId, -food.population * food.perCapitaHour);
	return rates;
}

export type PopulationConfig = {
	growthPerHour: number;
	foodPerCapitaHour: number;
	starvePerHour: number;
};

/**
 * How a settlement's population and its food move over an interval. Pure and database-free for
 * the same reason as `accrue`: this runs in real time whether or not anyone is watching, so the
 * arithmetic has to live where `npm test` can reach it.
 *
 * One interval, three coupled things:
 *  - **Food** drains at `pop × foodPerCapitaHour`. It is stored fractional and drained smoothly
 *    over the whole elapsed interval, so the number on screen always agrees with the clock.
 *  - **Growth**: while there is spare housing *and* food, settlers accrue at `growthPerHour`.
 *  - **Starvation**: once food runs out, people leave at `starvePerHour` — gently, which lessens
 *    the drain and lets the settlement self-correct. No hard cliff.
 *
 * Piecewise, not a loop: food covers the first `fedSeconds` of the interval (the whole of it, or
 * up to the single crossover instant `food / drainRate`), and the settlement starves for the
 * rest. Growth pressure accrues over the fed part, starvation pressure over the hungry part.
 *
 * People are whole but the pressures are fractional, so the sub-person remainder is carried in
 * `accrued` — a *signed* accumulator (positive = a birth pending, negative = a departure pending)
 * threaded back in by the caller. That carry, not the interval length, is what makes the result
 * independent of how often it is called. Two backlog clamps mirror `grow`'s old ones: at the cap
 * positive pressure is discarded (a House built after a week full fills gradually, not instantly),
 * and at zero population negative pressure is discarded (an emptied realm doesn't owe deaths).
 *
 * ponytail: within one interval `pop` is treated as constant for the food crossover — births and
 * deaths that land mid-interval don't retroactively re-rate the drain. Exact only when pop holds
 * (at the cap, or with no food crossover); elsewhere it is close at read cadence, and seeding
 * `foodPerCapitaHour` below one forager's yield keeps the common "a forager feeds the hamlet"
 * case correct. Split the interval at each birth/death if starvation ever feels wrong.
 */
export function population(
	pop: number,
	capacity: number,
	food: number,
	accrued: number,
	config: PopulationConfig,
	elapsedSeconds: number
): { born: number; died: number; foodDrained: number; accrued: number } {
	if (elapsedSeconds <= 0) return { born: 0, died: 0, foodDrained: 0, accrued };

	// How long food lasts within this interval. pop constant across the interval (see ponytail).
	const drainPerSecond = (pop * config.foodPerCapitaHour) / 3600;
	const fedSeconds =
		drainPerSecond > 0 ? Math.min(elapsedSeconds, food / drainPerSecond) : elapsedSeconds;
	const foodDrained = drainPerSecond * fedSeconds; // = food when it runs out, else the full draw
	const starveSeconds = elapsedSeconds - fedSeconds;

	let acc = accrued;
	// Growth only where there is room *and* food. The `food > 0` gate is what stops an empty,
	// unprovisioned settlement from conjuring settlers from nothing — with no mouths the drain is
	// zero and `fedSeconds` spans the whole interval, so without it a realm at zero pop and zero
	// food would still "grow". A stocked empty settlement does repopulate, which is the recovery
	// path out of a starvation wipe. The fraction over the cap is not banked.
	if (capacity - pop > 0 && food > 0) acc += (config.growthPerHour * fedSeconds) / 3600;
	// Departures accrue over the hungry tail. Gentle by design — a low rate reads as "people
	// drift away" rather than "the town dies at once".
	acc -= (config.starvePerHour * starveSeconds) / 3600;

	let born = 0;
	let died = 0;
	while (acc >= 1 && pop + born < capacity) {
		born++;
		acc -= 1;
	}
	while (acc <= -1 && pop - died > 0) {
		died++;
		acc += 1;
	}
	// No banking a backlog at either wall: full house discards surplus growth pressure, empty
	// realm discards surplus starvation pressure. Between the walls the fraction is kept.
	if (pop + born >= capacity && acc > 0) acc = 0;
	if (pop - died <= 0 && acc < 0) acc = 0;

	return { born, died, foodDrained, accrued: acc };
}

// A specialist's stat sheet, rolled once at training. Kept in [STAT_MIN, STAT_MAX] so every
// specialist is competent but no two are identical — the spread is what makes one genuinely
// better than another (Slice 6 turns it into output). Range is a seed constant, not live-tunable
// balance data: it shapes character generation, not the economy a running world is balanced on.
export const STAT_MIN = 3;
export const STAT_MAX = 8;
export type Stats = {
	strength: number;
	dexterity: number;
	constitution: number;
	intelligence: number;
};

/**
 * Rolls a specialist's four base stats. Takes its randomness as an argument — pure given the
 * `rng`, so a seeded generator makes the roll a repeatable unit test rather than a coin flip
 * `npm test` can't pin. Each stat is a uniform integer in [STAT_MIN, STAT_MAX].
 */
export function rollStats(rng: () => number): Stats {
	const span = STAT_MAX - STAT_MIN + 1;
	const roll = () => STAT_MIN + Math.floor(rng() * span);
	return { strength: roll(), dexterity: roll(), constitution: roll(), intelligence: roll() };
}

// The pool trained specialists are named from. Flavor, not balance — a seed constant, and
// deliberately neutral-European placeholder names (the feudal-Japan reskin swaps this list, per
// VISION). Public-repo-safe: no real people.
export const NAME_POOL = [
	'Aldric',
	'Rowena',
	'Bertram',
	'Maud',
	'Cedric',
	'Edith',
	'Godwin',
	'Hilda',
	'Oswin',
	'Mabel',
	'Reyner',
	'Sib',
	'Wat',
	'Alditha',
	'Emory',
	'Joan',
	'Leofric',
	'Cwen',
	'Osric',
	'Milburga'
];

/**
 * Picks a specialist name, preferring one not already in `taken`. Pure given `rng`. When every
 * name is taken it reuses one rather than failing — duplicate names are a cosmetic shrug, not a
 * bug, and a realm with twenty specialists is far past this epic's concern.
 */
export function pickName(rng: () => number, taken: Set<string> = new Set()): string {
	const free = NAME_POOL.filter((n) => !taken.has(n));
	const pool = free.length ? free : NAME_POOL;
	return pool[Math.floor(rng() * pool.length)];
}

export type SkillConfig = {
	// What an untrained settler works at — a flat multiplier on the reference rate.
	settlerBaseline: number;
	// How much a specialist's two governing stats swing their output around the trained value.
	skillCurve: number;
};

/**
 * The multiplier a worker applies to a job's flat rate — the whole "who does it changes the
 * result" mechanic in one pure function, so it can be pinned in `npm test` rather than felt for.
 *
 * A settler (no skill bundle for this work, or no rolled stats) works at `settlerBaseline` — slow
 * and poor, the same for every anonymous body. A specialist trained for this skill works at their
 * `bundleValue`, swung by how their two governing stats compare to the middle of the roll range:
 * a strong-for-the-job specialist beats a weak one, and both beat a settler by roughly the 4–5×
 * the design asks for (baseline ~0.15 against a bundle ~0.7).
 *
 * A specialist doing work *outside* their profession — a Mason sent to forage — has no bundle
 * for it and falls to the settler baseline, so profession is a real choice, not a free upgrade.
 * The floor keeps even a poorly-rolled specialist from dropping below a settler at their own craft.
 *
 * Derived, never stored: the caller recomputes this from the live bundle at each assignment and
 * snapshots only the result onto the operation, so retuning a profession reaches the next job a
 * specialist takes (the design's "a balance edit still moves them") without rewriting history.
 */
export function skillValue(
	bundleValue: number | null,
	statA: number | null,
	statB: number | null,
	config: SkillConfig
): number {
	if (bundleValue === null || statA === null || statB === null) return config.settlerBaseline;
	const mid = (STAT_MIN + STAT_MAX) / 2;
	const statAvg = (statA + statB) / 2;
	const mult = bundleValue * (1 + (config.skillCurve * (statAvg - mid)) / mid);
	// Never worse at your own trade than an untrained settler, whatever the roll.
	return Math.max(config.settlerBaseline, mult);
}

/**
 * Each member's effort per second, in the order given. The whole crew rule lives here: sort by
 * competence, and the *k*-th best works at `1/√k` of their own pace.
 *
 * Two things fall out of that one weighting, and they are the epic's feel:
 *  - **Diminishing returns without a cap.** The 8th body adds a third of what the 1st does, so
 *    piling bodies on is self-punishing and no rule has to say "at most N".
 *  - **The best worker leads at full weight.** Your Mason runs the site and the rest fetch and
 *    carry — legible without a rule that says so.
 */
function memberRates(multipliers: number[]): number[] {
	const byCompetence = multipliers.map((_, i) => i).sort((a, b) => multipliers[b] - multipliers[a]);
	const rates = new Array<number>(multipliers.length);
	byCompetence.forEach((i, k) => (rates[i] = multipliers[i] / Math.sqrt(k + 1)));
	return rates;
}

/** How much effort a crew delivers per second, all together. */
export function crewRate(multipliers: number[]): number {
	return memberRates(multipliers).reduce((sum, r) => sum + r, 0);
}

/**
 * When a crew finishes a build, and how well they build it. Pure and database-free like `accrue`
 * and `population`, so the four feel invariants are assertions in `npm test` rather than something
 * felt for in a browser.
 *
 * A build needs `buildSeconds` of effort. Members arrive at their own times (they walk from their
 * own tiles), so the site's rate is piecewise-constant, stepping up as each one lands — and the
 * weighting is re-applied among **whoever is present**, not among the whole crew. That matters:
 * ranked against absent betters, an early arrival would dawdle at half pace on an empty site, and
 * adding a body could make a build slower. Ranking the present keeps it monotone.
 *
 * `arrivesAtSeconds` and the returned `seconds` are both measured from the order, so the answer is
 * the whole clock — travel included — and the caller stamps one `complete_at` from it. Every
 * arrival is already known at order time, so this is solved **once** and never revisited: nothing
 * in the resolve loop has to recompute a build's schedule.
 *
 * Quality is the effort-weighted mean of the members' own multipliers — you get out the average of
 * whoever actually did the work. A member who arrives after the last stone is laid delivers zero
 * effort and therefore has zero influence, with no special case to write it.
 *
 * A one-member crew is exactly the old arithmetic: `arrivesAt + buildSeconds / multiplier`, quality
 * `multiplier`. Solo builds keep the numbers they had.
 */
export function crewBuild(
	members: { multiplier: number; arrivesAtSeconds: number }[],
	buildSeconds: number
): { seconds: number; quality: number } {
	// An operation is its crew; a crewless one is a corrupt call, not a game rule (the writer
	// refuses an order with nobody on it long before this).
	if (members.length === 0) throw new Error('crewBuild needs at least one member');

	const crew = [...members].sort((a, b) => a.arrivesAtSeconds - b.arrivesAtSeconds);
	const effort = new Array<number>(crew.length).fill(0);
	let remaining = buildSeconds;
	let t = crew[0].arrivesAtSeconds;
	let arrived = 0;
	let present: number[] = [];

	while (remaining > 0) {
		while (arrived < crew.length && crew[arrived].arrivesAtSeconds <= t) present.push(arrived++);
		const rates = memberRates(present.map((i) => crew[i].multiplier));
		const rate = rates.reduce((sum, r) => sum + r, 0);
		// This phase ends when the next member lands, or when the work does — whichever first.
		const untilNext = arrived < crew.length ? crew[arrived].arrivesAtSeconds - t : Infinity;
		const untilDone = remaining / rate;
		const span = Math.min(untilDone, untilNext);
		present.forEach((i, k) => (effort[i] += rates[k] * span));
		t += span;
		// Subtracting `rate * span` instead would leave a float crumb behind and spin one more
		// zero-length phase; the work is done when the span that finishes it is the shorter one.
		if (untilDone <= untilNext) break;
		remaining -= rate * untilNext;
	}

	const quality = effort.reduce((sum, e, i) => sum + e * crew[i].multiplier, 0) / buildSeconds;
	return { seconds: t, quality };
}

// A trip, as walked: the tiles crossed and how long the whole thing takes. `path` is row-major tile
// indices, origin first and destination last, so it is one flat array of small ints on the wire and
// one lookup away from coordinates on either side.
export type Route = { path: number[]; seconds: number };

export type TravelLeg = {
	/** Row-major tile indices — see `Route.path`. */
	path: number[];
	startedAt: string;
	travelDoneAt: string;
};

// A binary min-heap of [cost, node], private to `route`. A sorted-array queue would make Dijkstra
// O(n²) over 2304 tiles, which is measurable on an estimate that re-quotes as you type.
function heapPush(heap: [number, number][], item: [number, number]): void {
	heap.push(item);
	let i = heap.length - 1;
	while (i > 0) {
		const parent = (i - 1) >> 1;
		if (heap[parent][0] <= heap[i][0]) break;
		[heap[parent], heap[i]] = [heap[i], heap[parent]];
		i = parent;
	}
}

function heapPop(heap: [number, number][]): [number, number] {
	const top = heap[0];
	const last = heap.pop()!;
	if (heap.length) {
		heap[0] = last;
		let i = 0;
		for (;;) {
			const left = 2 * i + 1;
			const right = left + 1;
			let small = i;
			if (left < heap.length && heap[left][0] < heap[small][0]) small = left;
			if (right < heap.length && heap[right][0] < heap[small][0]) small = right;
			if (small === i) break;
			[heap[small], heap[i]] = [heap[i], heap[small]];
			i = small;
		}
	}
	return top;
}

/**
 * The route a body actually walks, and how long it takes — cheapest total time, not shortest
 * distance. This is what makes terrain a *decision* rather than a tax: a worker walks around a lake
 * instead of swimming it, takes the pass rather than the peak, and (once roads exist) prefers the
 * road because a road is a cheap tile.
 *
 * It replaced a straight line sampled for cost. That model could only ever charge for the ground
 * between two points; it could not choose different ground, so no road anybody built would have been
 * walked on unless it happened to lie along the line.
 *
 * Dijkstra over the tile grid, eight-way, with each step costing its own length (1 or √2) times the
 * mean of the two tiles' movement costs, over `speed`. Averaging the pair rather than charging the
 * tile you land on is what keeps A→B and B→A identical — the same reason the old midpoint sampling
 * was symmetric, and the estimate and the order it turns into are two separate calls that must agree
 * exactly.
 *
 * No heuristic, deliberately: A* would want a lower bound on any tile's cost, and the day a road or
 * a bridge undercuts that bound the routes go quietly suboptimal. 2304 tiles is small enough that
 * the exact answer is cheap — measured at 0.06 ms for a trip near the hamlet and 0.44 ms corner to
 * corner, against an estimate that re-quotes per keystroke — and it early-exits the moment the
 * destination is settled. Add the heuristic when the map is big enough for that to stop being true.
 *
 * `cost` takes *integer tile coordinates* and returns that tile's movement cost. Required rather than
 * defaulted, because a default of 1 would hand terrain-free timings back to a caller that forgot to
 * pass terrain, silently.
 *
 * ponytail: every tile is passable — expensive, never forbidden — which is why this has no
 * unreachable case to report. An impassable tile (a cliff, a wall) would need `cost` to return
 * Infinity and this to answer "no route" rather than throwing.
 */
export function route(
	originX: number,
	originY: number,
	destX: number,
	destY: number,
	speed: number,
	cost: (x: number, y: number) => number,
	gridSize: number
): Route {
	const start = originY * gridSize + originX;
	const goal = destY * gridSize + destX;
	// Ordering a build on the body's own tile: a one-tile path, no time. The client's travelFraction
	// reads a zero-length leg as arrived.
	if (start === goal) return { path: [start], seconds: 0 };

	const cells = gridSize * gridSize;
	const best = new Float64Array(cells).fill(Infinity);
	const cameFrom = new Int32Array(cells).fill(-1);
	const settled = new Uint8Array(cells);
	best[start] = 0;
	const heap: [number, number][] = [[0, start]];

	while (heap.length) {
		const [soFar, node] = heapPop(heap);
		// The stale copy of a node whose cost improved after it was pushed.
		if (settled[node]) continue;
		settled[node] = 1;
		if (node === goal) break;

		const x = node % gridSize;
		const y = (node - x) / gridSize;
		const here = cost(x, y);
		for (let dy = -1; dy <= 1; dy++) {
			for (let dx = -1; dx <= 1; dx++) {
				if (!dx && !dy) continue;
				const nx = x + dx;
				const ny = y + dy;
				if (nx < 0 || ny < 0 || nx >= gridSize || ny >= gridSize) continue;
				const next = ny * gridSize + nx;
				if (settled[next]) continue;
				const step = ((dx && dy ? Math.SQRT2 : 1) * ((here + cost(nx, ny)) / 2)) / speed;
				if (soFar + step >= best[next]) continue;
				best[next] = soFar + step;
				cameFrom[next] = node;
				heapPush(heap, [best[next], next]);
			}
		}
	}

	// Unreachable is impossible while every tile is passable (see the ponytail note), so this is a
	// corrupt grid rather than a game rule — the same reading `readWorld` gives a hole in the map.
	if (!Number.isFinite(best[goal]))
		throw new Error(`no route from (${originX}, ${originY}) to (${destX}, ${destY})`);

	const path = [goal];
	for (let node = cameFrom[goal]; node !== -1; node = cameFrom[node]) path.push(node);
	path.reverse();
	return { path, seconds: Math.ceil(best[goal]) };
}

// The four sides a road can join, clockwise from north, as bits. Clockwise matters: the bit order is
// also the order the arms are drawn in, so an arm's rotation is just its index × 90°.
export const ROAD_SIDES = [
	{ bit: 1, dx: 0, dy: -1, degrees: 0 },
	{ bit: 2, dx: 1, dy: 0, degrees: 90 },
	{ bit: 4, dx: 0, dy: 1, degrees: 180 },
	{ bit: 8, dx: -1, dy: 0, degrees: 270 }
] as const;

/** Both straights, for the override picker: north–south, and east–west. */
const NORTH_SOUTH = 1 | 4;
const EAST_WEST = 2 | 8;

/**
 * Which arms a road tile draws — the auto-shape from its neighbours, narrowed by the player's stored
 * override. Fifteen sprites' worth of shape from one rule, so a road laid next to a road becomes a
 * corner or a crossing without anybody choosing an orientation, which is the bit Lands of Lords makes
 * you do by hand.
 *
 * The override is **intersected**, never unioned: a player can hide an arm at a junction, and cannot
 * draw one to a tile that has no road on it. That is also what makes it self-healing — pave over a
 * junction's northern arm, tear that road up later, and the override quietly stops claiming it rather
 * than leaving a stub pointing at grass.
 *
 * Pure and free of the payload so the shape rule is a unit test rather than something to squint at:
 * `isRoad` answers "is there a road of this kind on that tile", off-map included (false).
 */
export function roadArms(
	x: number,
	y: number,
	isRoad: (x: number, y: number) => boolean,
	stored: number | null
): number {
	let auto = 0;
	for (const side of ROAD_SIDES) if (isRoad(x + side.dx, y + side.dy)) auto |= side.bit;
	return stored === null ? auto : stored & auto;
}

/**
 * The shapes worth offering for a tile whose neighbours make `auto` — what "change road" cycles
 * through. Null first, meaning "however it joins up", then whichever straights the junction
 * contains: a crossroads can read as north–south or east–west, a T as the straight through it.
 *
 * Only junctions get a choice. A corner, a dead end or a plain through-road is already the only
 * sensible drawing of itself, and offering to restyle it would be a button that changes nothing.
 */
export function roadStyles(auto: number): (number | null)[] {
	const bits = ROAD_SIDES.filter((s) => auto & s.bit).length;
	if (bits < 3) return [null];
	return [null, ...[NORTH_SOUTH, EAST_WEST].filter((straight) => (auto & straight) === straight)];
}

/** How far along the travel leg we are at `nowMs`, clamped to [0, 1]. */
export function travelFraction(leg: TravelLeg, nowMs: number): number {
	const start = Date.parse(leg.startedAt);
	const end = Date.parse(leg.travelDoneAt);
	// Ordering a build on the character's own tile gives a zero-length leg — treat as arrived
	// rather than dividing by zero.
	if (end <= start) return 1;
	return Math.min(1, Math.max(0, (nowMs - start) / (end - start)));
}

/**
 * Where a body is right now: how far along its route the clock has carried it. Derived, never
 * stored — the server does not tick intermediate positions.
 *
 * ponytail: spread evenly along the route by *distance*, not by each tile's movement cost. So a
 * route that mixes fast and slow ground draws the body a little ahead of itself on the slow part and
 * a little behind on the fast — it still leaves and arrives on the second, and the error is worst in
 * the middle and zero at both ends.
 *
 * Roads widened this: half a route on paving at 0.4 and half on meadow at 1.0 is a real difference
 * in pace that the drawing flattens, up to about a tile out at the midpoint. Fixing it means putting
 * every terrain's movement cost on the wire (deliberately absent — nothing on the client estimates
 * travel) and giving this a cost lookup, at which point it is exact. Worth doing the day somebody
 * notices a body sauntering down a road; not before.
 */
export function positionAt(
	leg: TravelLeg,
	nowMs: number,
	gridSize: number
): { x: number; y: number } {
	const points = leg.path.map((i) => ({ x: i % gridSize, y: Math.floor(i / gridSize) }));
	if (points.length === 1) return points[0];

	const steps = points.slice(1).map((p, i) => Math.hypot(p.x - points[i].x, p.y - points[i].y));
	let want = steps.reduce((sum, s) => sum + s, 0) * travelFraction(leg, nowMs);
	for (let i = 0; i < steps.length; i++) {
		if (want > steps[i] && i < steps.length - 1) {
			want -= steps[i];
			continue;
		}
		const t = steps[i] > 0 ? Math.min(1, want / steps[i]) : 1;
		return {
			x: points[i].x + (points[i + 1].x - points[i].x) * t,
			y: points[i].y + (points[i + 1].y - points[i].y) * t
		};
	}
	return points[points.length - 1];
}

/**
 * The building types that may be placed on a given terrain — the one rule authored once and
 * consumed twice: the server gate refuses anything not in this set, and `readWorld` ships it per
 * terrain type as the wire allow-list so the client's menu offers exactly what the writer permits.
 *
 * Three cases, and its empty result subsumes the old bare `buildable` check (unbuildable ground
 * yields `[]`, so every type fails the gate there):
 *  - **Unbuildable ground** (Mountain, Water) → `[]`.
 *  - **A deposit** (Stone outcrop, Clay pit, Iron vein) → only the one extractor that takes its
 *    yield (Stone ⇒ Quarry), or `[]` when no extractor exists yet (Clay, Iron have none).
 *  - **Plain buildable ground** → every type *except* an extractor, so a Quarry can't squat on a
 *    meadow — and except a type the catalog itself marks not player-buildable (the Marketplace),
 *    which is placed once at realm creation and never offered again.
 *
 * Pure and database-free — the caller passes the catalogs it already holds — so the terrain-menu
 * rule is pinned in `npm test` rather than only felt through the browser.
 */
export function eligibleTypeIds(
	terrain: { buildable: boolean; isDeposit: boolean; yieldsResourceId: number | null },
	buildingTypes: { id: number; playerBuildable: boolean }[],
	resources: { id: number; requiresBuildingTypeId: number | null }[]
): number[] {
	if (!terrain.buildable) return [];
	// The types that are somebody's extractor — never offered on plain ground.
	const extractors = new Set(
		resources.map((r) => r.requiresBuildingTypeId).filter((id): id is number => id !== null)
	);
	if (terrain.isDeposit) {
		const yielded = resources.find((r) => r.id === terrain.yieldsResourceId);
		const extractor = yielded?.requiresBuildingTypeId ?? null;
		return extractor !== null ? [extractor] : [];
	}
	return buildingTypes.filter((t) => t.playerBuildable && !extractors.has(t.id)).map((t) => t.id);
}

/**
 * Is (x, y) inside a reach circle? Euclidean, not the grid's own eight-way step distance — the
 * circle a canvas `arc()` draws and the circle the server gate enforces have to be the same
 * arithmetic, or the line drawn and the line enforced could disagree. Exactly on the radius counts
 * as inside: a boundary tile is *in* your reach, not the first tile past it.
 *
 * Takes the circle as one nullable value rather than three separate arguments — a caller with no
 * reach loaded yet (the world hasn't arrived) has nothing to be inside, which this answers as
 * `false` rather than making every call site null-check first.
 */
export function withinReach(
	x: number,
	y: number,
	reach: { x: number; y: number; radius: number } | null
): boolean {
	return reach !== null && Math.hypot(x - reach.x, y - reach.y) <= reach.radius;
}

/**
 * The reach radius a settlement has *earned* at this population — the milestone lookup itself,
 * pure so it is the thing `npm test` actually runs. The write side of the ratchet is one SQL
 * keyword (`GREATEST(reach_radius, reachFor(...))` in world.server.ts's `resolveWorld`); this
 * function is the arithmetic behind that number, tested here rather than only trusted there.
 *
 * The highest threshold met wins, not the last one in the array — `milestones` is seeded content
 * (VISION #10) and nothing here assumes it arrives in population order. Below every threshold is
 * `0`, not the lowest milestone's radius: a settlement that hasn't reached the first rung hasn't
 * earned any reach yet.
 */
export function reachFor(
	population: number,
	milestones: { population: number; radius: number }[]
): number {
	let radius = 0;
	for (const m of milestones) if (population >= m.population) radius = Math.max(radius, m.radius);
	return radius;
}
