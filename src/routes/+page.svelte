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
		travelFraction,
		type OrderReason,
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
				(o) => o.type === 'build' && Date.parse(o.completeAt!) <= nowMs && !settled.has(o.id)
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
	function selectTile(x: number, y: number) {
		selected = { x, y };
		if (message !== TROUBLE) message = '';
	}

	function buildHere() {
		if (!selected || chosen === null) return;
		const { x, y } = selected;
		act('/api/orders', { method: 'POST', body: JSON.stringify({ x, y, buildingTypeId: chosen }) });
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
	// A character with an in-progress operation is walking or building; its stored tile is
	// where it left from, so the live position comes from the operation instead.
	function at(c: { id: number; x: number; y: number }) {
		const op = world?.operations.find((o) => o.characterId === c.id);
		return op ? positionAt(op, nowMs) : c;
	}
	const professionName = $derived(
		new Map(world?.professions.map((p) => [p.id, p.displayName]) ?? [])
	);
	// A body's name if it's a specialist, else "a settler" — how the panel and roster label it.
	const who = (c: { name: string | null; professionId: number | null }) =>
		c.name ? `${c.name} (${professionName.get(c.professionId!)})` : 'a settler';
	const opFor = (id: number) => world?.operations.find((o) => o.characterId === id);
	// What a worker is doing right now, for the panel. Walking is derived from the travel leg,
	// not a stored status — a worker mid-trip reads as walking whatever they'll do on arrival.
	function doing(c: { id: number }): string {
		const op = opFor(c.id);
		if (!op) return 'idle';
		if (travelFraction(op, nowMs) < 1) return `walking to ${op.destX}, ${op.destY}`;
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
</script>

<header class="topbar">
	<div class="frame topbar-inner">
		<h1>石垣 Ishigaki</h1>
		<button class="theme-toggle" onclick={toggleTheme} aria-label="Toggle light or dark mode">
			{theme === 'dark' ? '☀ Light' : '☾ Dark'}
		</button>
	</div>
</header>

<main class="frame">
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

	{#if world}
		<Sprites />
		<!-- Floored, not rounded: showing 5 Wood when you hold 4.9 and then refusing a 5-Wood
	     build would read as the server lying. -->
		<p class="stock">
			{#each world.stock as s (s.resourceId)}
				<span><b>{resourceName.get(s.resourceId)}</b> {Math.floor(s.quantity)}</span>
			{/each}
		</p>
		<div class="layout">
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

			<!-- The inspector: one surface for a tile's facts and every action it affords. Which buttons
	     show is the tile's decision, not a mode the player has to set first. -->
			<aside class="panel">
				{#if !selected}
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
						<p><b>{typeName(selBuilt.buildingTypeId)}</b> stands here.</p>
					{:else if selSite}
						<p><b>{typeName(selSite.buildingTypeId!)}</b> under construction.</p>
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
						<button onclick={trainHere} disabled={chosenProfession === null}>Train a settler</button
						>
					{/if}
				{/if}

				{#if message}<p class="error">{message}</p>{/if}
			</aside>
		</div>

		{#if specialists.length}
			<!-- The specialist roster: find one by name even when they're out working the map. -->
			<h3 class="roster-title">Specialists</h3>
			<ul class="roster">
				{#each specialists as c (c.id)}
					<li>{who(c)} — {doing(c)}</li>
				{/each}
			</ul>
		{/if}
	{:else}
		<p>Loading…</p>
	{/if}

	<p><button onclick={newGame}>New game</button></p>
</main>

<style>
	/* One shared width, centred — the header band's contents and the game frame line up. */
	.frame {
		max-width: 920px;
		margin: 0 auto;
		padding: 0 1rem;
		box-sizing: border-box;
	}
	/* The offcolour header band, full-bleed, with the title and the theme toggle. */
	.topbar {
		background: var(--header-bg);
		border-bottom: 1px solid var(--border);
		margin-bottom: 1.25rem;
	}
	.topbar-inner {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding-top: 0.6rem;
		padding-bottom: 0.6rem;
	}
	.topbar h1 {
		margin: 0;
		font-size: 1.5rem;
	}
	.theme-toggle {
		background: var(--panel-bg);
		color: var(--text);
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 0.35rem 0.7rem;
		cursor: pointer;
		font: inherit;
	}
	.theme-toggle:hover {
		filter: brightness(0.97);
	}
	main.frame {
		padding-bottom: 2rem;
	}
	.grid {
		position: relative;
		display: grid;
		grid-template-columns: repeat(var(--size), var(--cell));
		width: max-content;
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
	   relayout all 256 cells every frame. z-index keeps them above a *selected* tile — which
	   lifts itself to z-index 1 for its ring — so clicking a building doesn't bury it under the
	   raised grass tile. */
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
	.stock {
		display: flex;
		gap: 1rem;
		font-variant-numeric: tabular-nums;
	}
	/* Map and inspector side by side; the panel wraps under the map on a narrow screen. */
	.layout {
		display: flex;
		flex-wrap: wrap;
		gap: 1.5rem;
		align-items: flex-start;
	}
	.panel {
		min-width: 15rem;
		max-width: 20rem;
		background: var(--panel-bg);
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 0.75rem 1rem;
	}
	.panel h2 {
		margin: 0 0 0.25rem;
	}
	.panel h3 {
		margin: 1rem 0 0.25rem;
	}
	.hint {
		color: var(--muted);
	}
	.roster-title {
		margin: 1.25rem 0 0.25rem;
	}
	.roster {
		list-style: none;
		padding: 0;
		margin: 0;
		font-variant-numeric: tabular-nums;
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
	/* A ring on the selected tile — outline so it sits over the art without shrinking it, same
	   trick as .site. Drawn above neighbours so the ring isn't clipped by the next cell's border. */
	.tile.selected {
		outline: 2px solid #1d4ed8;
		outline-offset: -2px;
		z-index: 1;
	}
	.price {
		color: var(--muted);
	}
	.error {
		color: #b91c1c;
	}
	.notice {
		background: #fef9c3;
		border-left: 4px solid #ca8a04;
		padding: 0.5rem 0.75rem;
		max-width: 34rem;
	}
</style>
