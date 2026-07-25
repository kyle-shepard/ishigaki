<script lang="ts">
	import { onMount } from 'svelte';
	// SvelteKit polls its own version manifest (interval set in vite.config.ts) and flips this
	// when the deployed build changes. Rolling our own version field on the world payload
	// would have been the same feature, written twice.
	import { updated } from '$app/state';
	import Sprites from '$lib/features/world/Sprites.svelte';
	import {
		GRID_SIZE,
		positionAt,
		qualityBand,
		travelFraction,
		type EstimateResponse,
		type OrderReason,
		type TravelLeg,
		type WorldPayload
	} from '$lib/features/world/world';

	const CELL = 32;

	const REASON_TEXT: Record<OrderReason, string> = {
		OUT_OF_BOUNDS: 'That tile is off the map.',
		UNKNOWN_BUILDING_TYPE: "You can't build that.",
		TILE_NOT_BUILDABLE: "You can't build on that ground.",
		TILE_OCCUPIED: 'Something is already on that tile.',
		NO_IDLE_CHARACTER: 'Everyone is busy.',
		INSUFFICIENT_RESOURCES: "You don't have the materials for that.",
		TILE_YIELDS_NOTHING: "There's nothing to take from that ground.",
		MISSING_REQUIRED_BUILDING: 'That needs a building on the tile before anyone can work it.',
		MISSING_PREREQUISITE: 'You need another building before you can raise that.',
		UNKNOWN_OPERATION: 'Nobody is working there.',
		NO_IDLE_SETTLER: 'You have no idle settler to train.',
		MISSING_SCHOOL: 'Training needs a School on the tile.',
		UNKNOWN_PROFESSION: "That isn't a profession anyone can learn."
	};

	// A click selects a tile; the inspector panel to the right of the map owns the verbs. No
	// mode toggle — the tile decides which actions are offered (buildable+empty ⇒ Build, yields
	// something ⇒ Gather), and the panel shows them together.
	let selected = $state<{ x: number; y: number } | null>(null);
	// Which building to raise. Null until the first world arrives, then the first type in the catalog.
	let chosen = $state<number | null>(null);
	// Which profession to train at a School. Defaults to the first once a world arrives.
	let chosenProfession = $state<number | null>(null);
	// How many bodies to send. A maximum, not a demand — the order takes up to this many of whoever
	// is free. Persists across tiles like `chosen` does, so a chosen crew size sticks.
	let crewSize = $state(1);
	// Which professions may work the order. Empty is the common case and means anyone; settlers are
	// not on the list, because a settler has no profession to name — you hold your good worker back
	// by not picking them, not by asking for settlers.
	let allowedProfessionIds = $state<number[]>([]);

	// Which panel is showing. The inspector is one of three now: the tile you clicked, every
	// building you hold, every person in your realm. Not routes — the world payload already has
	// all three, so a page load to re-read what is in memory would be a slower way to show it.
	let tab = $state<'tile' | 'buildings' | 'citizens'>('tile');

	// The map's scroll box. 48×48 at 32px is wider than most windows, so the map pans by scrolling
	// and the roster panels need a way to bring a tile into view.
	let pane = $state<HTMLElement | null>(null);
	// A jump, not a glide. `behavior: 'smooth'` is animated by the compositor, so it doesn't run in
	// a tab that isn't painting — and a smooth pan across half a 1536px map is a long wait for
	// somebody who clicked a list row to *be* there. Instant also needs no reduced-motion carve-out.
	function centreOn(x: number, y: number) {
		if (!pane) return;
		// scrollTo clamps for us at every edge, so a tile in a corner just gets as centred as it can.
		pane.scrollTo({
			left: (x + 0.5) * CELL - pane.clientWidth / 2,
			top: (y + 0.5) * CELL - pane.clientHeight / 2,
			behavior: 'instant'
		});
	}
	// What a row in the buildings or citizens list does: select the tile, show it, and go there.
	function goToTile(x: number, y: number) {
		selectTile(x, y);
		centreOn(x, y);
	}

	// Take hold of the map and move it. The pane is still an ordinary scroll container — its bars are
	// hidden in CSS, not its scrolling — so a drag is just its scroll offset moved by the pointer's
	// delta. No transform and no second coordinate system, which is what keeps every tile's own hit
	// testing, focus ring and aria label working while the map moves under them.
	//
	// Mouse only, deliberately: a touch already pans the pane natively, and handling it here as well
	// would move the map twice as fast as the finger.
	// Plain, not $state: it is mutated on every pointermove and nothing renders from it. The cursor
	// does, so that is a separate boolean rather than a reactive proxy re-firing per mouse move.
	let pan: { lastX: number; lastY: number; travel: number } | null = null;
	let panning = $state(false);
	// True once a drag has actually travelled. Read by the click swallow below — a pan that happens to
	// end on a tile must not also select it.
	let dragged = false;
	// Under this it is a click with an unsteady hand, not a pan.
	const DRAG_SLOP = 4;

	function panStart(e: PointerEvent) {
		if (e.button !== 0 || e.pointerType !== 'mouse') return;
		pan = { lastX: e.clientX, lastY: e.clientY, travel: 0 };
		panning = true;
		// Cleared here rather than after the swallow: a drag released outside the map never produces a
		// click to clear it, and a stale flag would eat the next real one.
		dragged = false;
	}
	function panMove(e: PointerEvent) {
		if (!pan || !pane) return;
		const dx = e.clientX - pan.lastX;
		const dy = e.clientY - pan.lastY;
		pan.lastX = e.clientX;
		pan.lastY = e.clientY;
		pan.travel += Math.hypot(dx, dy);
		if (pan.travel < DRAG_SLOP) return;
		dragged = true;
		// Assigning rather than scrollBy: it clamps at the edges for free and never animates.
		pane.scrollLeft -= dx;
		pane.scrollTop -= dy;
	}
	function panEnd() {
		pan = null;
		panning = false;
	}
	function swallowClick(e: MouseEvent) {
		if (!dragged) return;
		e.stopPropagation();
		e.preventDefault();
	}

	// Open on the hamlet rather than on the map's top-left corner. Not $state: writing it must not
	// re-run the effect, and nothing renders from it.
	let centred = false;
	$effect(() => {
		const home = world?.buildings[0] ?? world?.characters[0];
		if (centred || !pane || !home) return;
		centred = true;
		// One task late, deliberately. Centring is measured off the pane's own size, and the effect
		// can run before the stylesheet has finished applying — which centres the map on a pane that
		// is not yet the size it is about to be. A timer rather than requestAnimationFrame because a
		// backgrounded tab suspends frames entirely, and a game opened in a second tab should still
		// be looking at the hamlet when you get to it.
		setTimeout(() => centreOn(home.x, home.y));
	});

	// Light/dark. The real source of truth is documentElement.dataset.theme (set pre-paint in
	// app.html); this mirrors it so the toggle button re-renders. Persisted to localStorage.
	let theme = $state<'light' | 'dark'>('light');
	function toggleTheme() {
		theme = theme === 'dark' ? 'light' : 'dark';
		document.documentElement.dataset.theme = theme;
		try {
			localStorage.setItem('theme', theme);
		} catch {
			// Private mode or blocked storage — the toggle still works for this session.
		}
	}

	let world = $state<WorldPayload | null>(null);
	let message = $state('');
	// Sticky: the server reports a lost realm on one response only, and a heartbeat refresh
	// half a minute later must not quietly erase the notice before it has been read.
	let worldReset = $state(false);
	// Server time, advanced by rAF. Positions are *derived* from it rather than written by
	// the loop, so the very first paint is already correct — no frame has to fire first.
	let nowMs = $state(0);

	// The browser clock is never trusted directly — only its offset from the server's.
	let clockOffset = 0;

	// When the last successful read landed. Drives the idle heartbeat below.
	let lastReadMs = 0;

	function apply(payload: WorldPayload) {
		clockOffset = Date.now() - Date.parse(payload.now);
		world = payload;
		nowMs = Date.parse(payload.now);
		lastReadMs = Date.now();
		// Only until the player has picked for themselves — re-defaulting on every refresh
		// would snatch their choice back twice a minute.
		if (chosen === null) chosen = payload.buildingTypes[0]?.id ?? null;
		if (chosenProfession === null) chosenProfession = payload.professions[0]?.id ?? null;
		if (payload.worldReset) worldReset = true;
	}

	// The server distinguishes "you broke a game rule" (400 with a reason) from "something
	// went wrong" (anything else). The client has to keep that distinction visible instead of
	// applying an error body as if it were a world.
	const TROUBLE = 'Lost contact with the world. Retrying…';
	// Slow on purpose: the economy runs in minutes, so this only has to be faster than a
	// player noticing that a live content edit hasn't landed.
	const IDLE_REFRESH_MS = 30_000;

	let refreshing = false;
	async function refresh() {
		if (refreshing) return;
		refreshing = true;
		try {
			const res = await fetch('/api/world');
			if (!res.ok) throw new Error(`world read failed: ${res.status}`);
			apply(await res.json());
			if (message === TROUBLE) message = '';
		} catch (e) {
			console.error(e);
			message = TROUBLE;
		} finally {
			refreshing = false;
		}
	}

	// Operations we've already refetched for. Without this, an operation that came back still
	// in-progress would re-request every frame — a fetch storm at 60fps.
	const settled = new Set<number>();

	onMount(() => {
		// Mirror whatever app.html's pre-paint script settled on.
		theme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';

		let frame: number;

		// Runs on a timer, not on rAF: a backgrounded tab suspends animation frames entirely,
		// and neither reconnecting nor keeping up with the world is a rendering concern.
		//
		// Two jobs, one timer. Reconnect attempts stay fast; otherwise this is a slow heartbeat
		// so that a live content edit (VISION #10 — retune a movement cost, edit a display name,
		// no deploy) actually reaches an open tab. Without it an idle player never re-reads at
		// all: refreshes only fired on mount and when an operation came due, so "live on next
		// read" had no next read.
		const retry = setInterval(() => {
			if (message === TROUBLE || Date.now() - lastReadMs > IDLE_REFRESH_MS) refresh();
		}, 3000);

		const tick = () => {
			nowMs = Date.now() - clockOffset;

			// One refetch when a build comes due — the server resolves it on read. Gathers are
			// excluded because they never come due; they are collected by the idle heartbeat
			// above, which is also what keeps the resource bar creeping upward.
			const due = world?.operations.filter(
				(o) =>
					o.type === 'build' &&
					o.completeAt !== null &&
					Date.parse(o.completeAt) <= nowMs &&
					!settled.has(o.id)
			);
			if (due?.length) {
				for (const o of due) settled.add(o.id);
				refresh();
			}
			frame = requestAnimationFrame(tick);
		};

		(async () => {
			await refresh();
			frame = requestAnimationFrame(tick);
		})();

		return () => {
			clearInterval(retry);
			cancelAnimationFrame(frame);
		};
	});

	// Every rule-bearing request answers the same two ways — a world, or a reason — so they
	// share one caller rather than three copies of the same try/catch.
	async function act(path: string, init: RequestInit) {
		try {
			const res = await fetch(path, {
				headers: { 'content-type': 'application/json' },
				...init
			});

			if (res.ok) {
				apply(await res.json());
				message = '';
				return;
			}
			// A 400 is a game rule and always carries a reason. Any other status is a failure,
			// not a rule, and must not be dressed up as one.
			if (res.status !== 400) throw new Error(`${path} failed: ${res.status}`);

			const { reason } = await res.json();
			message = REASON_TEXT[reason as OrderReason] ?? reason;
		} catch (e) {
			console.error(e);
			message = TROUBLE;
		}
	}

	// A click no longer acts — it selects. The panel's buttons act on the selection. Clearing
	// any prior refusal so a stale "everyone is busy" doesn't hang over a freshly picked tile.
	// Clicking the map also pulls the panel back to the tile view: you asked about a tile.
	function selectTile(x: number, y: number) {
		selected = { x, y };
		tab = 'tile';
		if (message !== TROUBLE) message = '';
	}

	function buildHere() {
		if (!selected || chosen === null) return;
		const { x, y } = selected;
		act('/api/orders', {
			method: 'POST',
			body: JSON.stringify({ x, y, buildingTypeId: chosen, crewSize, allowedProfessionIds })
		});
	}

	function gatherHere() {
		if (!selected) return;
		const { x, y } = selected;
		act('/api/assignments', { method: 'POST', body: JSON.stringify({ x, y }) });
	}

	function trainHere() {
		if (!selected || chosenProfession === null) return;
		const { x, y } = selected;
		act('/api/training', {
			method: 'POST',
			body: JSON.stringify({ x, y, professionId: chosenProfession })
		});
	}

	const recall = (id: number) => act(`/api/assignments/${id}`, { method: 'DELETE' });
	// Cancel an in-progress build; the server deletes the operation and refunds the full cost.
	const cancelSite = (id: number) => act(`/api/orders/${id}`, { method: 'DELETE' });

	async function newGame() {
		// Native confirm, because this destroys a realm someone spent real time on and the
		// browser already ships the dialog.
		if (!confirm('Start a new realm? Everything you have built will be lost.')) return;
		try {
			const res = await fetch('/api/new-game', { method: 'POST' });
			if (!res.ok) throw new Error(`new game failed: ${res.status}`);
			// The cookie is gone, so the refresh below bootstraps a fresh realm the same way a
			// first visit does.
			worldReset = false;
			message = '';
			settled.clear();
			await refresh();
		} catch (e) {
			console.error(e);
			message = TROUBLE;
		}
	}

	const tiles = Array.from({ length: GRID_SIZE * GRID_SIZE }, (_, i) => ({
		x: i % GRID_SIZE,
		y: Math.floor(i / GRID_SIZE)
	}));
	// `terrain` is row-major over the same index this array was built from, so tiles[i] and
	// terrain[i] line up with no second indexing concept.
	const terrainById = $derived(new Map(world?.terrainTypes.map((t) => [t.id, t]) ?? []));
	const resourceName = $derived(new Map(world?.resources.map((r) => [r.id, r.displayName]) ?? []));
	const terrainAt = (i: number) => terrainById.get(world!.terrain[i]);
	const buildingTypeById = $derived(new Map(world?.buildingTypes.map((t) => [t.id, t]) ?? []));
	// The art carries what's on a tile for everyone who can see it. The label is the same
	// information for everyone who can't — so it names the building too, not just the ground.
	function tileLabel(i: number, x: number, y: number) {
		const t = terrainAt(i);
		if (!t) return `Tile ${x}, ${y}`;
		// Floored, so a tile reading "1 of 25" always has a whole unit in it and one reading
		// "0 of 25" really is stripped.
		const left = world!.tileQuantity[i];
		const full = world!.tileCapacity[i];
		const yield_ = t.yieldsResourceId
			? ` — yields ${resourceName.get(t.yieldsResourceId)}` +
				(left !== null && full !== null ? ` (${Math.floor(left)} of ${full} left)` : '')
			: '';
		const built = world!.buildings.find((b) => b.x === x && b.y === y);
		const site = world!.operations.find(
			(o) => o.type === 'build' && o.destX === x && o.destY === y
		);
		const on = built
			? ` — ${typeName(built.buildingTypeId)}`
			: site
				? ` — ${typeName(site.buildingTypeId!)} under construction`
				: '';
		return `Tile ${x}, ${y} — ${t.displayName}${yield_}${on}`;
	}
	const typeName = (id: number) => buildingTypeById.get(id)?.displayName ?? '?';
	// A building with no cost rows is free, and says so rather than showing an empty bracket.
	function priceOf(id: number) {
		const parts = (world?.buildingCosts ?? [])
			.filter((c) => c.buildingTypeId === id)
			.map((c) => `${c.quantity} ${resourceName.get(c.resourceId)}`);
		return parts.length ? parts.join(' + ') : 'free';
	}
	const resourceAt = (x: number, y: number) => {
		const id = terrainById.get(world!.terrain[y * GRID_SIZE + x])?.yieldsResourceId;
		return id ? resourceName.get(id) : 'nothing';
	};
	// An unknown key resolves to no symbol and draws nothing — a tile missing its art, not a
	// broken page.
	const typeIcon = (id: number) => buildingTypeById.get(id)?.icon ?? '';
	// Each member of a crew walks their own leg — from their own tile, arriving at their own time —
	// so a travel leg is composed per worker rather than read off the operation.
	type Op = WorldPayload['operations'][number];
	function legFor(op: Op, characterId: number): TravelLeg | undefined {
		const w = op.workers.find((w) => w.characterId === characterId);
		// A queued build has neither: nobody is walking anywhere yet.
		if (!w || op.startedAt === null) return undefined;
		return {
			originX: w.originX,
			originY: w.originY,
			destX: op.destX,
			destY: op.destY,
			startedAt: op.startedAt!,
			travelDoneAt: w.arrivesAt
		};
	}
	// A character with an in-progress operation is walking or building; its stored tile is
	// where it left from, so the live position comes from the operation instead.
	function at(c: { id: number; x: number; y: number }) {
		const op = opFor(c.id);
		const leg = op && legFor(op, c.id);
		return leg ? positionAt(leg, nowMs) : c;
	}
	const professionName = $derived(
		new Map(world?.professions.map((p) => [p.id, p.displayName]) ?? [])
	);
	const characterById = $derived(new Map(world?.characters.map((c) => [c.id, c]) ?? []));
	// A body's name if it's a specialist, else "a settler" — how the panel and roster label it.
	const who = (c: { name: string | null; professionId: number | null }) =>
		c.name ? `${c.name} (${professionName.get(c.professionId!)})` : 'a settler';
	const opFor = (id: number) =>
		world?.operations.find((o) => o.workers.some((w) => w.characterId === id));
	// What a worker is doing right now, for the panel. Walking is derived from the travel leg,
	// not a stored status — a worker mid-trip reads as walking whatever they'll do on arrival.
	function doing(c: { id: number }): string {
		const op = opFor(c.id);
		if (!op) return 'idle';
		const leg = legFor(op, c.id);
		if (leg && travelFraction(leg, nowMs) < 1) return `walking to ${op.destX}, ${op.destY}`;
		if (op.type === 'build') return `building ${typeName(op.buildingTypeId!)}`;
		if (op.type === 'train') return `training as ${professionName.get(op.professionId!)}`;
		return `gathering ${resourceAt(op.destX, op.destY)}`;
	}

	// Everything the panel reads off the selected tile. Derived, so a build landing or a worker
	// arriving updates the open panel with no re-click. `present` keys on live position, so it
	// recomputes as nowMs advances and workers walk on and off the tile.
	const selIndex = $derived(selected ? selected.y * GRID_SIZE + selected.x : -1);
	const selTerrain = $derived(selected ? terrainAt(selIndex) : undefined);
	const selYields = $derived(selTerrain?.yieldsResourceId ?? null);
	const selBuilt = $derived(
		selected ? world?.buildings.find((b) => b.x === selected!.x && b.y === selected!.y) : undefined
	);
	const selSite = $derived(
		selected
			? world?.operations.find(
					(o) => o.type === 'build' && o.destX === selected!.x && o.destY === selected!.y
				)
			: undefined
	);
	// Build is offered only where the ground allows *some* type and nothing already stands or is
	// rising. Keys on the terrain's eligible list (per-terrain, server-authored), not the bare
	// `buildable` flag — so a deposit still offers its extractor and Mountain offers nothing.
	const canBuild = $derived(
		!!selected && (selTerrain?.buildableTypeIds.length ?? 0) > 0 && !selBuilt && !selSite
	);
	// The building types the player owns, for greying a type whose realm-wide prerequisite isn't met.
	const ownedTypeIds = $derived(new Set(world?.buildings.map((b) => b.buildingTypeId) ?? []));
	// The menu for the selected tile: only types this terrain allows, each flagged if its
	// prerequisite building isn't owned yet (greyed, "Requires a {name}").
	const buildOptions = $derived.by(() => {
		if (!world || !selTerrain) return [];
		const eligible = new Set(selTerrain.buildableTypeIds);
		return world.buildingTypes
			.filter((bt) => eligible.has(bt.id))
			.map((bt) => {
				const need = bt.requiresBuildingTypeId;
				const blocked = need !== null && !ownedTypeIds.has(need);
				return { ...bt, blocked, needName: need !== null ? typeName(need) : null };
			});
	});
	// The Build button is live only when the chosen type is actually placeable here — `chosen`
	// persists across tiles, so a Quarry picked on an outcrop mustn't fire a doomed order on a meadow.
	const chosenOk = $derived(buildOptions.some((o) => o.id === chosen && !o.blocked));
	// Training is offered where a finished School stands on the selected tile.
	const selIsSchool = $derived(!!selBuilt && typeName(selBuilt.buildingTypeId) === 'School');
	const present = $derived(
		selected && world
			? world.characters.filter((c) => {
					const p = at(c);
					return Math.round(p.x) === selected!.x && Math.round(p.y) === selected!.y;
				})
			: []
	);

	// Bodies on the map are dots, and bodies sharing a tile fan into a 2×2 so a stack reads as
	// a crowd rather than one pawn (LoL-style). A lone body sits centred (slot −1); past four on
	// a tile the extras are only in the panel's worker list — the map says "a crowd", the panel
	// says who. Keyed on live position, so it recomputes as workers walk and regroups on arrival.
	const DOT = 6; // how far a dot sits from cell centre, in the 32-unit viewBox
	const slotOffset = (slot: number) =>
		slot < 0 ? [0, 0] : [slot % 2 ? DOT : -DOT, slot < 2 ? -DOT : DOT];
	const dots = $derived.by(() => {
		if (!world) return [];
		// Settlers are the dots; specialists are drawn as their own pawns (below), so they don't
		// take a dot slot here.
		const settlers = world.characters.filter((c) => c.professionId === null);
		const groups = new Map<string, { id: number; x: number; y: number }[]>();
		for (const c of settlers) {
			const p = at(c);
			const key = `${Math.round(p.x)},${Math.round(p.y)}`;
			(groups.get(key) ?? groups.set(key, []).get(key)!).push({ id: c.id, x: p.x, y: p.y });
		}
		const out: { id: number; x: number; y: number; slot: number }[] = [];
		for (const arr of groups.values()) {
			const lone = arr.length === 1;
			arr.slice(0, 4).forEach((d, i) => out.push({ ...d, slot: lone ? -1 : i }));
		}
		return out;
	});
	// Named specialists, for both the map pawns and the roster. Live position so a pawn tracks a
	// walking specialist.
	const specialists = $derived(world?.characters.filter((c) => c.professionId !== null) ?? []);

	// ---- The resource bar ----------------------------------------------------------------------
	const resourceIcon = $derived(new Map(world?.resources.map((r) => [r.id, r.icon]) ?? []));
	// Below this the number is noise: a rate rounds to 0.0 and a "+0.0" beside a still stock reads
	// as a promise nothing is keeping.
	const RATE_SHOWN = 0.05;
	const rateText = (r: number) => `${r > 0 ? '+' : '-'}${Math.abs(r).toFixed(1)}`;

	// ---- The buildings panel -------------------------------------------------------------------
	// Everything you have raised, plus everything you are raising — a site is a building you are
	// waiting on, and leaving it out would make the list disagree with the map.
	//
	// No maintenance column: nothing in the world decays, needs upkeep, or has a condition, so
	// there is no number to put there. It goes beside `quality` when the decay epic gives it one.
	type Row = {
		key: string;
		x: number;
		y: number;
		typeId: number;
		quality: number | null;
		state: 'built' | 'building' | 'waiting';
	};
	const buildingRows = $derived.by<Row[]>(() => {
		if (!world) return [];
		const rows: Row[] = world.buildings.map((b) => ({
			key: `b${b.id}`,
			x: b.x,
			y: b.y,
			typeId: b.buildingTypeId,
			quality: b.quality,
			state: 'built'
		}));
		for (const o of world.operations) {
			if (o.type !== 'build') continue;
			rows.push({
				key: `o${o.id}`,
				x: o.destX,
				y: o.destY,
				typeId: o.buildingTypeId!,
				quality: null,
				state: o.startedAt === null ? 'waiting' : 'building'
			});
		}
		// By kind, then down the map — so the same building is in the same place between reads, and
		// the two Houses sit together.
		return rows.sort(
			(a, b) => typeName(a.typeId).localeCompare(typeName(b.typeId)) || a.y - b.y || a.x - b.x
		);
	});
	// "Houses 3 · Barn 1" — the summary the list itself can't give you at a glance once it's long.
	const buildingSummary = $derived.by(() => {
		const counts = new Map<string, number>();
		for (const r of buildingRows) {
			const name = typeName(r.typeId);
			counts.set(name, (counts.get(name) ?? 0) + 1);
		}
		return [...counts].map(([name, n]) => `${n} ${name}`).join(' · ');
	});

	// ---- The citizens panel --------------------------------------------------------------------
	// Specialists first, by trade then name; the anonymous many after them, in the order they
	// arrived. A roster you scan for a person, and the settlers are a block at the bottom.
	const citizens = $derived(
		[...(world?.characters ?? [])].sort((a, b) => {
			if ((a.professionId === null) !== (b.professionId === null))
				return a.professionId === null ? 1 : -1;
			if (a.professionId !== b.professionId)
				return (professionName.get(a.professionId!) ?? '').localeCompare(
					professionName.get(b.professionId!) ?? ''
				);
			return (a.name ?? '').localeCompare(b.name ?? '') || a.id - b.id;
		})
	);

	// ---- The live estimate ---------------------------------------------------------------------
	// What this build would cost you in time and workmanship, before you spend anything. The server
	// answers from the same code path the order takes, so the quote and the outcome are the same
	// arithmetic rather than two implementations that agree for now.
	let estimate = $state<EstimateResponse | null>(null);
	// A refusal the estimate saw — shown inline by the numbers rather than as a page-level error,
	// because nothing has been attempted yet.
	let estimateRefusal = $state<OrderReason | null>(null);

	// The quote, narrowed once. A build with nobody free answers with nulls — a real answer, not a
	// missing one — and splitting it here keeps the template from re-asking on every field.
	const quote = $derived(
		estimate && estimate.seconds !== null && estimate.quality !== null
			? { seconds: estimate.seconds, quality: estimate.quality, crew: estimate.crew }
			: null
	);

	function duration(seconds: number) {
		const m = Math.floor(seconds / 60);
		const s = Math.round(seconds % 60);
		return m ? `${m}m ${s}s` : `${s}s`;
	}

	// Re-quotes whenever the tile, the type or the crew size changes. Debounced, because the crew
	// stepper fires per keystroke and nobody needs a round trip per digit.
	$effect(() => {
		const target = selected;
		const type = chosen;
		const size = crewSize;
		// Read here, in the effect's synchronous part, so it is a tracked dependency: ticking a
		// profession has to re-quote, not sit on a stale number.
		const only = [...allowedProfessionIds];
		if (!target || type === null || !canBuild) {
			estimate = null;
			estimateRefusal = null;
			return;
		}
		const timer = setTimeout(async () => {
			try {
				const res = await fetch('/api/orders/estimate', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						x: target.x,
						y: target.y,
						buildingTypeId: type,
						crewSize: size,
						allowedProfessionIds: only
					})
				});
				if (res.status === 400) {
					estimate = null;
					estimateRefusal = (await res.json()).reason;
					return;
				}
				if (!res.ok) throw new Error(`estimate failed: ${res.status}`);
				estimate = await res.json();
				estimateRefusal = null;
			} catch (e) {
				// A quote that can't be fetched is not worth a page-level error — the Build button
				// still works, and the server is still the one that decides.
				console.error(e);
				estimate = null;
				estimateRefusal = null;
			}
		}, 200);
		return () => clearTimeout(timer);
	});
</script>

<Sprites />

<!-- The band across the top: the realm, what it holds, and the two verbs that aren't about a tile.
     Fixed, because the map beneath it is the whole window now and nothing scrolls the page. -->
<header class="topbar">
	<h1>石垣</h1>
	{#if world}
		<!-- Stellaris-style: the icon *is* the label, the number is what you hold, and the rate beside
		     it is where it's going. Floored, not rounded: showing 5 Wood when you hold 4.9 and then
		     refusing a 5-Wood build would read as the server lying. The name is kept for screen
		     readers and in the tooltip — an icon alone is not a label. -->
		<ul class="stock">
			{#each world.stock as s (s.resourceId)}
				<li
					title="{resourceName.get(s.resourceId)} — {Math.floor(s.quantity)}{Math.abs(
						s.ratePerHour
					) >= RATE_SHOWN
						? `, ${rateText(s.ratePerHour)} per hour`
						: ''}"
				>
					<svg class="res" viewBox="0 0 32 32" aria-hidden="true">
						<use href="#i-{resourceIcon.get(s.resourceId)}" />
					</svg>
					<span class="sr-only">{resourceName.get(s.resourceId)}</span>
					<b>{Math.floor(s.quantity)}</b>
					{#if Math.abs(s.ratePerHour) >= RATE_SHOWN}
						<span class="rate" class:loss={s.ratePerHour < 0}>{rateText(s.ratePerHour)}</span>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
	<div class="topbar-end">
		<button onclick={toggleTheme} aria-label="Toggle light or dark mode">
			{theme === 'dark' ? '☀ Light' : '☾ Dark'}
		</button>
		<button onclick={newGame}>New game</button>
	</div>
</header>

<!-- Over the map rather than above it, since there is no page flow left to sit in. -->
<div class="notices">
	{#if updated.current}
		<p class="notice">
			A new version of the world has been deployed.
			<!-- Full reload, not goto(): the point is to drop the old JS this tab is running. -->
			<button onclick={() => location.reload()}>Refresh</button>
		</p>
	{/if}

	{#if worldReset}
		<p class="notice">
			Your previous realm couldn't be carried across a change to how the world works, so this is a
			fresh start. Sorry — the world is still being built.
		</p>
	{/if}
</div>

{#if world}
	<!-- The map owns the window and pans by scrolling. 48×48 doesn't fit on any screen, and a
	     viewport that shows the whole world is the one thing a map this size can't be. -->
	<main
		class="map-pane"
		class:panning
		bind:this={pane}
		onpointerdown={panStart}
		onpointermove={panMove}
		onpointerup={panEnd}
		onpointercancel={panEnd}
		onpointerleave={panEnd}
		onclickcapture={swallowClick}
	>
		<div class="grid" style="--cell: {CELL}px; --size: {GRID_SIZE}">
			{#each tiles as t, i (t.x + ',' + t.y)}
				<button
					class="tile"
					class:blocked={terrainAt(i)?.buildable === false}
					class:selected={selected?.x === t.x && selected?.y === t.y}
					style="background: {terrainAt(i)?.color}"
					onclick={() => selectTile(t.x, t.y)}
					aria-label={tileLabel(i, t.x, t.y)}
				>
					<!-- Mirrored on every other tile so a run of forest doesn't read as wallpaper.
				     Parity of x+y rather than of the index, or the flips line up into stripes. -->
					<svg
						class="art"
						viewBox="0 0 32 32"
						style:transform={(t.x + t.y) % 2 ? 'scaleX(-1)' : null}
					>
						<use href="#i-{terrainAt(i)?.icon}" />
					</svg>
				</button>
			{/each}
			{#each world.buildings as b (b.id)}
				<svg
					class="over"
					viewBox="0 0 32 32"
					style="transform: translate({b.x * CELL}px, {b.y * CELL}px)"
				>
					<use href="#i-{typeIcon(b.buildingTypeId)}" />
				</svg>
			{/each}
			<!-- Under construction is drawn from the operation: a building row only exists once
		     built, so presence in `buildings` means finished. Same art, ghosted and pegged out —
		     what's coming is legible before it's there. Builds only: a gather has no building
		     type, and would otherwise paint an empty dashed square wherever someone is working. -->
			{#each world.operations.filter((o) => o.type === 'build') as o (o.id)}
				<svg
					class="over site"
					class:waiting={o.startedAt === null}
					viewBox="0 0 32 32"
					style="transform: translate({o.destX * CELL}px, {o.destY * CELL}px)"
				>
					<use href="#i-{typeIcon(o.buildingTypeId!)}" />
				</svg>
			{/each}
			{#each dots as d (d.id)}
				{@const off = slotOffset(d.slot)}
				<svg
					class="over"
					viewBox="0 0 32 32"
					style="transform: translate({d.x * CELL}px, {d.y * CELL}px)"
				>
					<circle class="dot" cx={16 + off[0]} cy={16 + off[1]} r="5" />
				</svg>
			{/each}
			<!-- Specialists are pawns, not dots — a named individual reads as a body, not one of a
			     crowd. Distinct from the settler dots by silhouette. -->
			{#each specialists as c (c.id)}
				<svg
					class="over"
					viewBox="0 0 32 32"
					style="transform: translate({at(c).x * CELL}px, {at(c).y * CELL}px)"
				>
					<use href="#i-pawn" />
				</svg>
			{/each}
		</div>
	</main>

	<!-- The inspector, and the two rosters. One surface pinned to the right edge, three tabs: which
	     buttons the tile view offers is the tile's decision, not a mode the player has to set. -->
	<aside class="panel">
		<nav class="tabs">
			<button class:on={tab === 'tile'} onclick={() => (tab = 'tile')}>Tile</button>
			<button class:on={tab === 'buildings'} onclick={() => (tab = 'buildings')}>
				Buildings <span class="count">{buildingRows.length}</span>
			</button>
			<button class:on={tab === 'citizens'} onclick={() => (tab = 'citizens')}>
				Citizens <span class="count">{world.characters.length}</span>
			</button>
		</nav>

		{#if tab === 'buildings'}
			{#if buildingRows.length === 0}
				<p class="hint">Nothing raised yet. Click a tile and build something.</p>
			{:else}
				<p class="hint">{buildingSummary}</p>
				<ul class="rows">
					{#each buildingRows as b (b.key)}
						<li>
							<!-- The row is the button: clicking it centres the map on the tile and opens it,
							     which is the whole reason to have a list rather than a count. -->
							<button onclick={() => goToTile(b.x, b.y)}>
								<svg class="rowart" viewBox="0 0 32 32" aria-hidden="true">
									<use href="#i-{typeIcon(b.typeId)}" />
								</svg>
								<span class="rowmain">
									<b>{typeName(b.typeId)}</b>
									<span class="price">{b.x}, {b.y}</span>
								</span>
								{#if b.state === 'built'}
									<!-- The same band the estimate quoted and the tile shows, from the same
									     function. A building raised before quality was recorded says nothing. -->
									<span
										class="price"
										title={b.quality !== null ? `quality ${b.quality.toFixed(2)}` : ''}
									>
										{b.quality !== null ? qualityBand(b.quality) : '—'}
									</span>
								{:else}
									<span class="price">{b.state === 'waiting' ? 'waiting' : 'building…'}</span>
								{/if}
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		{:else if tab === 'citizens'}
			<p class="hint">
				{world.characters.length} people, {specialists.length} trained
			</p>
			<ul class="rows">
				{#each citizens as c (c.id)}
					<li>
						<button onclick={() => goToTile(Math.round(at(c).x), Math.round(at(c).y))}>
							<svg class="rowart" viewBox="0 0 32 32" aria-hidden="true">
								{#if c.professionId !== null}
									<use href="#i-pawn" />
								{:else}
									<circle class="dot" cx="16" cy="16" r="7" />
								{/if}
							</svg>
							<span class="rowmain">
								<b>{c.name ?? 'Settler'}</b>
								<span class="price">
									{c.professionId !== null ? professionName.get(c.professionId) : 'untrained'} — {doing(
										c
									)}
								</span>
								<!-- The rolled sheet, for the one question a roster exists to answer: which of
								     your two Masons is the better one. Settlers have none. -->
								{#if c.strength !== null}
									<span class="stats">
										STR {c.strength} · DEX {c.dexterity} · CON {c.constitution} · INT {c.intelligence}
									</span>
								{/if}
							</span>
						</button>
					</li>
				{/each}
			</ul>
		{:else if !selected}
			<p class="hint">Click a tile to inspect it.</p>
		{:else}
			<h2>Tile {selected.x}, {selected.y}</h2>
			<p>
				{selTerrain?.displayName ?? 'Unknown ground'}
				{#if selYields !== null}
					— yields {resourceName.get(selYields)}
					{#if world.tileQuantity[selIndex] !== null && world.tileCapacity[selIndex] !== null}
						({Math.floor(world.tileQuantity[selIndex]!)} of {world.tileCapacity[selIndex]} left)
					{/if}
				{/if}
			</p>

			{#if selBuilt}
				<!-- The same band the estimate quoted, from the same function — so what you were
					     promised and what stands there can never read differently. A building raised
					     before quality was recorded says nothing, rather than "unknown". -->
				<p>
					<b>{typeName(selBuilt.buildingTypeId)}</b> stands here.{#if selBuilt.quality !== null}{' '}<span
							class="price"
							title="quality {selBuilt.quality.toFixed(2)}"
							>{qualityBand(selBuilt.quality)} work.</span
						>{/if}
				</p>
			{:else if selSite && selSite.startedAt === null}
				<p><b>{typeName(selSite.buildingTypeId!)}</b> — waiting for a builder.</p>
				<p class="crew">Starts itself as soon as someone is free.</p>
				<p><button onclick={() => cancelSite(selSite.id)}>Cancel — full refund</button></p>
			{:else if selSite}
				<p><b>{typeName(selSite.buildingTypeId!)}</b> under construction.</p>
				<!-- Who is raising it. The crew is the operation's own membership, so this says the
					     same thing the server acted on rather than guessing from who's standing nearby. -->
				<p class="crew">
					Raised by {selSite.workers
						.map((w) => {
							const c = characterById.get(w.characterId);
							return c ? who(c) : 'someone';
						})
						.join(', ')}
				</p>
				<p><button onclick={() => cancelSite(selSite.id)}>Cancel — full refund</button></p>
			{/if}

			{#if present.length}
				<h3>Workers here</h3>
				<ul class="present">
					{#each present as c (c.id)}
						{@const op = opFor(c.id)}
						<li>
							{#if c.name}<b>{c.name}</b> ({professionName.get(c.professionId!)}) —
							{/if}{doing(c)}
							{#if op?.type === 'gather' && op.destX === selected.x && op.destY === selected.y}
								<button onclick={() => recall(op.id)}>Recall</button>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}

			{#if canBuild}
				<h3>Build here</h3>
				<ul class="build-picker">
					{#each buildOptions as bt (bt.id)}
						<li class:blocked-type={bt.blocked}>
							<label>
								<input type="radio" bind:group={chosen} value={bt.id} disabled={bt.blocked} />
								{bt.displayName}
								<span class="price">{priceOf(bt.id)}</span>
								{#if bt.blocked}<span class="requires">Requires a {bt.needName}</span>{/if}
							</label>
						</li>
					{/each}
				</ul>
				<!-- A native number input: the browser already ships the stepper, the keyboard
					     handling and the mobile numeric pad. `max` is how many bodies you actually
					     have — more than that is a number with nobody behind it. -->
				<label class="crew-size">
					Crew
					<input type="number" min="1" max={world.characters.length} bind:value={crewSize} />
					<span class="price">more hands, less craft</span>
				</label>
				<!-- Who may work it. Nothing ticked is the ordinary case and means anyone; the whole
					     profession catalog is offered because the payload deliberately ships no skill
					     bundles, so the client cannot know which trades build well — the estimate is
					     what tells you that, and it re-quotes as you tick. -->
				<details class="only">
					<summary>
						Only certain trades
						{#if allowedProfessionIds.length}
							<span class="price">({allowedProfessionIds.length} picked)</span>
						{/if}
					</summary>
					<ul class="build-picker">
						{#each world.professions as p (p.id)}
							<li>
								<label>
									<input
										type="checkbox"
										value={p.id}
										bind:group={allowedProfessionIds}
									/>{p.displayName}
								</label>
							</li>
						{/each}
					</ul>
				</details>
				<!-- The numbers, before you commit. They move as the crew moves — the whole point
					     of the epic, and the thing Lands of Lords only tells you after you've spent
					     the bodies. The raw quality rides in the title; the sentence gets the band. -->
				{#if quote}
					<p class="estimate">
						<b title="quality {quote.quality.toFixed(2)}">
							≈ {duration(quote.seconds)} · {qualityBand(quote.quality)}
						</b>
						<span class="price">
							sending {quote.crew.map((c) => c.name ?? 'a settler').join(', ')}
						</span>
					</p>
				{:else if estimate}
					<!-- Nobody free, or nobody the filter admits. Worth placing anyway: the order
						     holds the tile and the cost, and starts itself when someone frees. -->
					<p class="estimate">
						<b>Nobody is free</b>
						<span class="price">this will wait, and start itself when someone is</span>
					</p>
				{:else if estimateRefusal}
					<p class="estimate price">{REASON_TEXT[estimateRefusal] ?? estimateRefusal}</p>
				{/if}
				<button onclick={buildHere} disabled={!chosenOk}>Build</button>
			{/if}

			{#if selYields !== null}
				<p><button onclick={gatherHere}>Send someone to gather</button></p>
			{/if}

			{#if selIsSchool}
				<h3>Train a specialist</h3>
				<ul class="build-picker">
					{#each world.professions as p (p.id)}
						<li>
							<label>
								<input type="radio" bind:group={chosenProfession} value={p.id} />
								{p.displayName}
							</label>
						</li>
					{/each}
				</ul>
				<button onclick={trainHere} disabled={chosenProfession === null}>Train a settler</button>
			{/if}
		{/if}

		{#if message}<p class="error">{message}</p>{/if}
	</aside>
{:else}
	<p class="loading">Loading…</p>
{/if}

<style>
	/* Nothing on this page is in page flow. The header is fixed to the top, the map fills every
	   pixel under it and pans by scrolling itself, and the inspector floats over the map's right
	   edge. There is no centred column any more: a 48×48 world is the layout. */
	.topbar {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		height: var(--header-h);
		box-sizing: border-box;
		display: flex;
		align-items: center;
		gap: 1rem;
		padding: 0 0.75rem;
		background: var(--header-bg);
		border-bottom: 1px solid var(--border);
		/* Above the panel, which is above the map's overlays. */
		z-index: 20;
	}
	.topbar h1 {
		margin: 0;
		font-size: 1.35rem;
		flex: none;
	}
	/* The resource strip. Scrolls itself rather than wrapping or squeezing the title out — the
	   header is one line tall and has to stay that way. */
	.stock {
		flex: 1;
		display: flex;
		gap: 0.9rem;
		margin: 0;
		padding: 0;
		list-style: none;
		overflow-x: auto;
		font-variant-numeric: tabular-nums;
	}
	.stock li {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		white-space: nowrap;
	}
	.res {
		width: 1.45rem;
		height: 1.45rem;
		flex: none;
	}
	/* Where the stock is heading. Green up, red down, and absent when it isn't moving. */
	.rate {
		font-size: 0.82em;
		color: var(--gain);
	}
	.rate.loss {
		color: var(--loss);
	}
	/* The icon carries the resource for everyone who can see it; this is the same information for
	   everyone who can't. Clipped rather than hidden, because display:none isn't read out. */
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
	.topbar-end {
		display: flex;
		gap: 0.5rem;
		flex: none;
	}
	.topbar-end button {
		background: var(--panel-bg);
		color: var(--text);
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 0.35rem 0.7rem;
		cursor: pointer;
		font: inherit;
	}
	.topbar-end button:hover {
		filter: brightness(0.97);
	}
	.notices {
		position: fixed;
		top: calc(var(--header-h) + 0.5rem);
		left: 0.75rem;
		z-index: 15;
		max-width: 34rem;
	}
	.notice {
		background: #fef9c3;
		color: #2b2420;
		border-left: 4px solid #ca8a04;
		padding: 0.5rem 0.75rem;
		margin: 0 0 0.5rem;
	}
	.map-pane {
		position: fixed;
		inset: var(--header-h) 0 0 0;
		/* Scrolls, but shows no bars: two grey gutters framing a map you drag is furniture, and the
		   window is the viewport now. Hidden rather than `overflow: hidden`, because that would kill
		   the wheel and the keyboard's scroll-into-view along with the bars — this keeps every way of
		   moving the map except the one nobody wanted to look at. */
		overflow: auto;
		scrollbar-width: none;
		/* A drag across tiles must not start selecting them. */
		user-select: none;
		cursor: grab;
	}
	.map-pane::-webkit-scrollbar {
		display: none;
	}
	.map-pane.panning {
		cursor: grabbing;
	}
	.grid {
		position: relative;
		display: grid;
		grid-template-columns: repeat(var(--size), var(--cell));
		width: max-content;
		/* So the eastern edge of the map can be scrolled out from under the inspector. Right only:
		   an absolutely positioned overlay is placed against the padding box, so left or top padding
		   would slide every building off its tile. */
		padding-right: 21rem;
	}
	.tile {
		/* The containing block for .art — without it the art sizes against .grid and one tile's
		   mountain covers the map. */
		position: relative;
		width: var(--cell);
		height: var(--cell);
		border: 1px solid rgba(0, 0, 0, 0.15);
		box-sizing: border-box;
		padding: 0;
		cursor: pointer;
	}
	/* Brightness, not a background: a hover colour would erase the terrain underneath. */
	.tile:hover {
		filter: brightness(1.12);
	}
	/* Hints, doesn't enforce — the button stays enabled on purpose. Letting the click reach
	   the server and showing the server's own refusal is what proves the rule lives there. */
	.tile.blocked {
		cursor: not-allowed;
	}
	/* Terrain art fills its tile and never eats the click — the whole cell stays the button. */
	.art {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		pointer-events: none;
	}
	/* Overlays are absolutely positioned and moved with transform: animating left/top would
	   relayout every cell on the map every frame. z-index keeps them above a *selected* tile —
	   which lifts itself to z-index 1 for its ring — so clicking a building doesn't bury it under
	   the raised grass tile. */
	.over {
		position: absolute;
		top: 0;
		left: 0;
		width: var(--cell);
		height: var(--cell);
		pointer-events: none;
		z-index: 2;
	}
	/* A body on the map. Filled dark with a light rim so it reads on any terrain colour. */
	.dot {
		fill: #2b2420;
		stroke: #f5f2ea;
		stroke-width: 1.5;
	}
	/* outline, not border: a border would sit inside the box and shrink the 32px art. */
	.site {
		opacity: 0.45;
		outline: 2px dashed #4a3520;
		outline-offset: -2px;
	}
	/* Queued: fainter still, and a dotted outline rather than a dashed one — nobody is on it yet. */
	.site.waiting {
		opacity: 0.22;
		outline-style: dotted;
	}
	/* A ring on the selected tile — outline so it sits over the art without shrinking it, same
	   trick as .site. Drawn above neighbours so the ring isn't clipped by the next cell's border. */
	.tile.selected {
		outline: 2px solid #1d4ed8;
		outline-offset: -2px;
		z-index: 1;
	}
	/* Pinned to the window's right edge rather than laid out beside the map.

	   It used to be a flex sibling that wrapped underneath as soon as the window got narrow, which
	   put the verbs for the tile you had just clicked below the fold — the panel disappeared exactly
	   when the screen was too small to spare it. Fixed instead: always in the same place, always
	   reachable, whatever the map is doing underneath.

	   Overlapping the map is the intent now rather than a concession: the map owns the window, and
	   the map is the thing that can give way. The grid's right padding means even the last column
	   can still be scrolled clear of it. */
	.panel {
		position: fixed;
		top: var(--header-h);
		right: 0;
		/* Never wider than the window it is pinned to, however small that gets. border-box so that
		   bound counts the padding and the border — otherwise it is the *content* that is capped and
		   the panel still runs past the edge it was meant to fit inside. */
		box-sizing: border-box;
		width: min(20rem, calc(100vw - 2rem));
		/* A tall panel scrolls itself instead of running off the bottom of the window. */
		max-height: calc(100vh - var(--header-h) - 1.5rem);
		overflow-y: auto;
		/* Above the map's own overlays, which sit at 2. */
		z-index: 10;
		background: var(--panel-bg);
		border: 1px solid var(--border);
		/* Flush with the edge, so only the left corners are rounded and the right border is gone —
		   it reads as attached to the window rather than floating loose next to it. */
		border-right: none;
		border-top: none;
		border-radius: 0 0 0 8px;
		padding: 0.75rem 1rem;
		/* Lifts it off whatever it is covering, so the overlap reads as intended. */
		box-shadow: 0 2px 12px rgb(0 0 0 / 0.12);
	}
	/* Stuck to the top of the panel's own scroll, so a hundred citizens never scroll the way out of
	   the roster you are reading. The negative margins are what let its background reach the
	   panel's edges despite the panel's padding. */
	.tabs {
		position: sticky;
		top: 0;
		z-index: 1;
		display: flex;
		gap: 0.25rem;
		margin: -0.75rem -1rem 0.5rem;
		padding: 0.5rem 1rem 0;
		background: var(--panel-bg);
	}
	.tabs button {
		flex: 1;
		font: inherit;
		color: var(--muted);
		background: transparent;
		border: none;
		border-bottom: 2px solid var(--border);
		padding: 0.3rem 0.15rem;
		cursor: pointer;
	}
	.tabs button.on {
		color: var(--text);
		font-weight: 600;
		border-bottom-color: var(--text);
	}
	.count {
		color: var(--muted);
		font-weight: 400;
		font-size: 0.85em;
	}
	/* The two rosters. Each row is a button, because each row goes somewhere. */
	.rows {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.rows button {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		text-align: left;
		font: inherit;
		color: inherit;
		background: transparent;
		border: none;
		border-bottom: 1px solid var(--border);
		padding: 0.35rem 0.1rem;
		cursor: pointer;
	}
	.rows button:hover {
		background: rgb(127 127 127 / 0.12);
	}
	.rowart {
		width: 1.7rem;
		height: 1.7rem;
		flex: none;
	}
	.rowmain {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-width: 0;
	}
	.rowmain .price {
		font-size: 0.82em;
	}
	.stats {
		font-size: 0.78em;
		color: var(--muted);
		font-variant-numeric: tabular-nums;
	}
	.panel h2 {
		margin: 0 0 0.25rem;
	}
	.panel h3 {
		margin: 1rem 0 0.25rem;
	}
	.hint {
		color: var(--muted);
		margin: 0.25rem 0 0.5rem;
	}
	.crew {
		color: var(--muted);
	}
	.crew-size {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		margin: 0.5rem 0;
	}
	.crew-size input {
		width: 4rem;
		font: inherit;
	}
	.estimate {
		margin: 0.25rem 0 0.6rem;
		font-variant-numeric: tabular-nums;
	}
	.estimate span {
		display: block;
	}
	/* Collapsed by default — an unrestricted order is the common one, and seven checkboxes should
	   not be the first thing in the way of the Build button. */
	.only {
		margin: 0.4rem 0;
	}
	.only summary {
		cursor: pointer;
		color: var(--muted);
	}
	.present,
	.build-picker {
		list-style: none;
		padding: 0;
		margin: 0;
	}
	.build-picker label {
		display: flex;
		align-items: center;
		gap: 0.35rem;
	}
	/* A type whose prerequisite isn't owned yet — dimmed and unselectable, with the reason inline. */
	.build-picker li.blocked-type label {
		color: var(--muted);
		cursor: not-allowed;
	}
	.requires {
		color: var(--muted);
		font-style: italic;
	}
	.price {
		color: var(--muted);
	}
	.error {
		color: var(--loss);
	}
	.loading {
		padding: 5rem 1rem;
		text-align: center;
		color: var(--muted);
	}
</style>
