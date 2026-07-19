# Ishigaki — Core Vision

The durable design charter. Epics are broken off from this document as GitHub issues;
each epic then runs its own QRSPI cycle. This is the _what and why_, deliberately not the
_how_ — implementation detail belongs in each epic's research/design step, not here.

Status: **Session 0 output** (architecture locked, mechanics shaped, hard parts parked).

---

## North star

A persistent, browser-based, slow-real-time strategy game. Recognizably a
[Lands of Lords](https://www.landsoflords.com/) clone in _feel_ — a zoomable tile map,
buildings, populations, timed actions that resolve over real-world hours — cloned closely
enough to be familiar, then diverged from **deliberately**. The first deliberate divergence
is already chosen: the builder/character system (see below). Feudal-Japan flavor is the
_eventual_ skin, not the build vocabulary (see "Setting & naming").

Single-player-first: we design and build for one player, but the schema is multiplayer-shaped
from day one so multiplayer is a feature-add, not a rewrite.

---

## Locked decisions (Session 0)

These were argued out and are settled. Change them only with a deliberate reversal.

1. **Interaction model** — Async, page/tick-style. No live socket, no real-time client sync.
   "Slowness" lives in _action timers_, not in the transport. A player loads the app, views
   state, issues orders, leaves, and comes back later to resolved outcomes.

2. **Client shape** — A rich **SPA map client + JSON API**, _not_ server-rendered pages. The
   zoomable multi-level map is a real interactive front-end.

3. **Tech stack** — **TypeScript full-stack: SvelteKit + PostgreSQL + Drizzle.** One language
   and shared types across the map client and the API. Postgres because the world is typed
   relational rows (tiles, buildings, populations, characters, operations). Performance is
   database-bound and low-QPS by design — language runtime speed is a non-factor; the fix for
   any future hot path is set-based SQL or a compiled worker, not the web framework.

4. **World model** — **One shared, finite, square-tile grid** with integer coordinates. In
   single-player, only the player's starting hamlet is seeded; the rest of the grid exists but
   is unclaimed. Not per-player sandboxes (would wall off multiplayer), not a region graph.

5. **Multiplayer-readiness** — **Multi-tenant schema, zero multiplayer features.** Every
   ownable entity carries a `player_id` from day one. No auth, accounts, or politics yet —
   but adding them later is a feature, not a migration across every table.

6. **People — two tiers.**
   - **Commoner labor** — a fungible aggregate mass, counted in groups (starting ratio ≈ 1
     unit : 10 people, a tunable data value). Fills buildings, provides raw workforce. No
     individual stat sheets.
   - **Skilled characters** — a much smaller set of _individual_ actors with ability points
     and skills that determine the **quality** of what they build/make. These are the entities
     the "restrict builders / pick specialties" filter selects among, and the ones you see when
     you click a tile.

7. **Activity model — the first deliberate divergence from LoL.** LoL's manual
   select-worker → walk-to-tile → build loop is rejected as too micromanagey. Instead
   (Rimworld-flavored):
   - **Designate** what to build on a tile.
   - Optionally **restrict builders** and select required specialties/skills.
   - The system **auto-assigns** an eligible skilled character from the available pool.
   - The assigned character still **physically travels** to the tile (distance-based delay,
     visible movement on the map) — we automate _who is picked and dispatched_, not the
     movement itself.
   - Quality of the result is set by the assigned character's skills.

8. **Operations are first-class, mutable, lifecycle entities.** Every timed action
   (construction, crafting, movement, production) is a real row with a lifecycle:
   `queued → in-progress → { completed | cancelled | rushed }`. Because players return
   mid-action to check progress, cancel, or rush, in-progress is a genuine persisted state,
   not a value derived from two timestamps. Progress-check, cancel, and rush all fall out of
   this one decision for free.

9. **Time / progression — lazy on read (working direction, pending R-step validation).**
   Operations resolve when next viewed: an operation with a completion time is integrated
   forward on read. Idle players cost ~zero CPU. A light global tick is reserved _only_ for
   genuinely world-wide events and is not built until a mechanic demands it. **Open:** exact
   resolution of the hard cases (offline↔offline interactions, concurrency, combat) — this is
   the top R-step research item and shapes the schema, so it is resolved before world-sim code.

10. **Content is data, not code.** Building types, costs, yields, the group ratio, skill
    effects, **and all display names** live in tables and are edited live. This buys:
    - Balance/content changes with **no deploy** (edit a row → live on next read).
    - The setting reskin as a **1:1 data swap** (see below).

11. **Live-updatability without over-building.** "Update while live" = **data-driven content**
    (no deploy for balance/content) **+ zero-downtime rolling deploys** (page/tick has no
    persistent connection to sever, so a deploy between two page loads is invisible) **+ clean
    feature-module code organization.** Explicitly **not** a runtime plugin container and
    **not** hot-code-swap — state lives in Postgres, so any process restarts freely and those
    mechanisms solve problems we designed away.

12. **Premium currency & rush** — Leave room for a hard currency ("gems"-style) that moves an
    operation's completion time forward (rush) and funds server costs. Architecturally near-free
    given decision #8. Specifics parked.

---

## Setting & naming

**Build in neutral English domain terms** — Settlement, Building, Population, Character, Skill,
Resource, Tile. The feudal-Japan flavor (village→*mura*, rice→*koku*, peasant→*heimin*, and the
`石垣` foundation motif) is the **eventual reskin**, applied later as a data swap over the
display-name columns — _not_ the code vocabulary.

> **Intentional deviation from `CLAUDE.md`.** That file says "prefer Japanese-flavored domain
> terms." For the build phase we are overriding that on purpose: neutral terms in code, Japanese
> as a later skin. Do not rename code identifiers back to Japanese — the Japanese glossary in
> `CLAUDE.md` becomes the reskin dataset when we choose to flip it.

---

## Core mechanics (shaped, detail deferred to epics)

- **The map** — one shared finite tile grid, rendered as a zoomable client with level-of-detail
  tiers: continent → regional terrain (mountains, seas) → building tiles → individual character
  dots. **Phased:** the _building-tile_ zoom level (where the game is actually played) is built
  first; continent/regional LOD and nation/city **borders** come later.
- **Settlement hierarchy** — a growth ladder (village → town → castle-town, then domain/province
  scale) with thresholds and a political layer (vassalage, alliances, war, governance). Wanted,
  entirely parked — a late epic.
- **Economy** — resources, production chains, and storage feeding construction and population.
  Model specifics parked.

---

## Explicitly deferred / open

Parked on purpose. Each becomes a research/design question inside its epic, not a Session-0
blocker.

- **Time-resolution mechanics** — validate lazy-on-read against offline/concurrent/combat cases
  (top research item; gates world-sim schema).
- **Group ratio** — 1:10 is a starting value, retuned via data.
- **Character autonomy / random schedules** — the "characters live their own lives" depth layer.
- **World generation** — how the terrain map (mountains, seas, biomes) is produced.
- **Map LOD phasing** — continent/regional zoom tiers and nation/city borders.
- **Settlement & title ladder** — exact stages and thresholds.
- **Political / multiplayer layer** — vassalage, war, player governance.
- **Resource & economy model** — resources, chains, currency.
- **Premium currency specifics** — pricing, what's rushable, monetization shape.

---

## Epic plan (tracer-bullet first)

Structure: **one thin vertical slice through every system first** (a tracer bullet — something
testable and feelable fast), **then dedicated horizontal epics that thicken each strand.** After
the tracer, the deepening epics have no strict dependency order — prioritize by feel.

**Issue #1 — Setup** ([#1](https://github.com/kyle-shepard/ishigaki/issues/1), created): the
empty running skeleton (SvelteKit + Postgres + Drizzle). No game logic.

**Reminder — break the rest into GitHub issues _after_ #1 lands.** The breakdown below is held
here for that moment, not yet created as issues.

### Epic 2 — Tracer bullet (the thin vertical slice)

The thinnest loop that is still recognizably _this game_:

> Load the app → see a small fixed tile grid with your hamlet and one character → click an empty
> tile, order "build a house" → the character auto-dispatches and travels there (distance delay)
> → the construction runs `queued → in-progress → completed`, resolving lazily on reload → the
> house appears on the tile.

Lights up the whole spine: schema, the operation lifecycle, lazy-on-read resolution, the JSON
API, SvelteKit render-and-order, and the travel primitive.

- **In:** fixed small grid as plain squares (no zoom), one hardcoded player (no auth), one/few
  characters, one minimally-data-driven building type, the full operation lifecycle, lazy-on-read,
  a basic distance delay, minimal SPA.
- **Out (thickened later):** zoom/LOD, terrain/world-gen, two-tier population, skills→quality,
  restrict-builders, cancel/rush, premium currency, **resource cost — the tracer's build is free**,
  multiplayer/auth, settlement hierarchy.

### Deepening epics (order by feel after the tracer)

3. **Construction depth** — data-driven building catalog; restrict-builders + specialties;
   cancel/rush; requirements.
4. **People depth** — two-tier model; commoner aggregate; individual skilled characters with
   abilities/skills → quality; auto-assign pool; multiple characters.
5. **Economy & resources** — build costs, production chains, storage. _(turns the tracer into a
   game fastest — thicken early)_
6. **Time/progression hardening** — robust offline/concurrency resolution (the hard cases the
   tracer stubs); depends on the R-step time-model decision.
7. **Map client depth** — zoom/LOD tiers, terrain rendering.
8. **World generation** — the terrain map.
9. **Premium currency & rush** — hard currency, rush-an-operation. _(small)_
10. **Accounts & multiplayer shell** — auth, player identity. _(schema already ready)_
11. **Settlement hierarchy & politics** — growth ladder, domains/provinces, vassalage, war.

Recommended first thickenings: **Construction + Economy + People** — the trio that turns
"a house appears" into "a settlement you're growing." Each epic runs its own QRSPI cycle.

---

## How we work

QRSPI per epic (Question → Research → Spec/design → Plan → Implement), each with a human
checkpoint. This vision doc is the parent artifact; epics are GitHub issues; code ships as PRs
linked to issues. Close the loop — nothing ships unwatched.
