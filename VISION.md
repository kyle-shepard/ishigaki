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

### Current target (2026-07-25): a browser Banished

A hard scope pause, taken after reading the [Lands of Lords encyclopedia](https://www.landsoflords.com/help/)
properly for the first time. LoL is enormous — hundreds of goods running to gunpowder and
automata, organisations from lordship to empire, era-gated global content unlocks, cults,
tournaments, excommunication. Copying **most** of it before forking remains the plan; copying
**all** of it in one pass is not a plan.

So the target narrows to the half of LoL that needs nobody else in the world: **the village
survival economy.** Terrain, buildings, jobs, resources, needs, people. In one line — _Banished,
in a browser_, with LoL's quality system as the thing that gives it depth and the
designate/auto-assign model (locked decision #7) as the thing that makes it playable without micromanagement.

**In:** production chains, tools, needs beyond food, seasons, decay and repair, storage limits,
the quality feedback loop, map depth.

**Out until the village works:** accounts and identity, organisations and titles, the era
system, politics, military, trade. All of it is multiplayer-shaped or scale-shaped, and none of
it can be honestly designed against a world with one player and forty people in it.

**Not Rimworld, yet.** Individual colonists with moods, traits, and a storyteller generating
crises is the most attractive _fork_ on the table — but it is a fork, and it comes after the
economy it would generate crises against. Ishigaki already has Rimworld's assignment model
(locked decision #7); it does not need Rimworld's psychology to be a game.

**Reaffirmed 2026-08-07, after drifting from it.** The map work that followed the shared-world
reversal was good and is finished, but four consecutive epics went into what the world _is_ and
none into what a player _does_ — and the honest read of the result is that the loop still is not
fun. Everything multiplayer-shaped that had crept back onto the board went back off it: the
political overlay ([#21](https://github.com/kyle-shepard/ishigaki/issues/21)) and session-scoped
realms ([#27](https://github.com/kyle-shepard/ishigaki/issues/27)) were both closed unbuilt. The
rule above was right the first time; the failure mode it guards against is that world-building is
easier and more legible than game design, so it is what gets done when nobody is watching the
scope.

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

4. **World model** — **One shared, finite, square-tile grid** with integer coordinates, and
   not a region graph. The terrain map itself is shared, read-only data: every player plays
   the same geography. **A tile is a physical place: whoever builds there first holds it**,
   world-wide, not per player — this is the current, live behaviour (reversed back from the
   interim override below). Buildings and settlements are public — position, building type,
   and owner are visible to everyone, because they are things standing on the ground; stock,
   operations, characters, reach, and quality stay private to the realm that holds them.
   Reaches may legitimately overlap between neighbouring realms; where they do, occupancy
   settles it first-come-first-served, with no territory contest — that is "expansion &
   borders" below, deliberately still parked. Every realm now opens at its own scattered start
   (`findStarts` in `worldgen.ts`) rather than a single shared coordinate, spaced so two realms
   grown to the reach ladder's top rung never overlap by construction.

   **History — the interim override this reverses.** For the testing stage, occupancy was
   scoped **per player**: each visitor got an isolated sandbox on the shared map, their own
   hamlet at one single shared starting coordinate, nobody else's buildings visible or in the
   way. It existed so testers could play the single-player loop without fighting over one
   character or one tile, and it was the smallest change that achieved that — no tenant
   column, just `player_id` on the occupancy checks and the tile uniqueness index, plus every
   realm sharing `game_config.start_x/start_y`. That override is now removed: the occupancy
   checks in `world.server.ts`, `building_tile_idx`, and the single shared start coordinate are
   gone, in favour of the world-global model this decision always intended.

   **Timing.** The reversal landed once the world had somewhere to put more than a handful of
   realms without them claiming nearly all the usable land between them (measured on the old
   128×128 map: six mature reaches claimed 94% of it) — a wider map and scattered starts,
   shipped together. What is still deliberately parked is everything _past_ "a tile is a
   physical place": expansion, borders, and any contest over an overlapping reach. Every
   deepening epic before this was designed against a world with no neighbours in it; the ones
   after it can assume neighbours exist, but not yet that they compete for ground.

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

   **Amended 2026-07-25 — the commoner tier is deferred, not owed.** The 1:10 group ratio was
   taken from LoL, where it is literal: _"a unit is not an individual, but rather a group of ten
   individuals specialised in the same profession."_ That is correct for a feudal MMO counting
   thousands of people. It is wrong for a village of forty, where the individual villager **is**
   the interesting object — which is why Banished tracks every one of them by name. What shipped
   is individuals for both tiers, and under the current target that is the right model, not a
   shortcut. The aggregate returns when settlement scale makes forty names unreadable, and not
   before.

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
- **Character autonomy / random schedules** — the "characters live their own lives" depth layer.
  The nearest thing to a Rimworld fork, and the most attractive one once the economy stands up.
- **Aging & generations** ([#19](https://github.com/kyle-shepard/ishigaki/issues/19)) — whether villagers grow old and die. It is what makes Banished hard
  and what makes a lot of players quit it; a product call, not a design gap.
- **Settlement & title ladder** — superseded by LoL's organisations model; see "Parked" below.
- **Political / multiplayer layer** — vassalage, war, player governance.
- **Premium currency specifics** — pricing, what's rushable, monetization shape.

Moved off this list and onto the ladder: world generation, map LOD, and the resource/economy
model (production chains, needs, storage).

---

## Epic plan (tracer-bullet first)

Structure: **one thin vertical slice through every system first** (a tracer bullet — something
testable and feelable fast), **then dedicated horizontal epics that thicken each strand.** After
the tracer, the deepening epics have no strict dependency order — prioritize by feel.

**Issue #1 — Setup** ([#1](https://github.com/kyle-shepard/ishigaki/issues/1), created): the
empty running skeleton (SvelteKit + Postgres + Drizzle). No game logic.

The core-mechanic trio is now written up as issues; the rest of the breakdown below is held here
until each is actually next. An epic gets an issue when it's close enough that the issue won't be
rewritten before anyone reads it.

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

### Shipped

3. **Economy & resources** ([#6](https://github.com/kyle-shepard/ishigaki/issues/6)) — build
   costs, stock, tile deposits with depletion and regrowth.
4. **Construction depth** ([#7](https://github.com/kyle-shepard/ishigaki/issues/7)) —
   data-driven catalog, requirements, terrain gating, cancel with refund.
5. **People depth** ([#8](https://github.com/kyle-shepard/ishigaki/issues/8)) — individual
   characters with stats, professions, skills; food drain, population growth against housing,
   starvation.
6. **Labor & crews** ([#9](https://github.com/kyle-shepard/ishigaki/issues/9)) — crews, the
   speed-vs-quality curve, the live pre-commit estimate.
7. **Production buildings & recipes** ([#14](https://github.com/kyle-shepard/ishigaki/issues/14)) —
   a staffed building that consumes inputs and emits outputs over time. The keystone that had to
   land before tools, second needs, or a reason for a catalog.
8. **Map depth** ([#10](https://github.com/kyle-shepard/ishigaki/issues/10)) — zoom/LOD tiers and
   world generation, merged.
9. **The map at world scale** ([#22](https://github.com/kyle-shepard/ishigaki/issues/22),
   [#21](https://github.com/kyle-shepard/ishigaki/issues/21),
   [#24](https://github.com/kyle-shepard/ishigaki/issues/24)) — scattered starts on shared ground,
   a 6912² continent generated as a pure function and stored nowhere, the parchment wide zoom, and
   a name on every place. This is where the egress emergency was solved for good; see CLAUDE.md.

The economy spine stands up: extract → eat → grow → house → more hands → **make something out of
something**. What it still does not have is anything **needed but food**, anything that **wears
out**, or any reason the quality already being recorded should matter.

**And that is the problem worth naming.** The loop is not yet fun, and the reason is specific:
with one need there is one right answer every turn. Nothing on the map, however large, fixes that.
The next epics are the ones that put a second thing on the other side of the scale.

### The village ladder (current target)

All four are what turn a working economy into a game with a decision in it. **The keystone they
all waited on (#14) has shipped, so none of them is blocked by another** — the order below is a
preference, not a dependency chain, and the one that most directly answers "there is only ever one
right answer" is Needs beyond food.

1. **Needs beyond food** ([#16](https://github.com/kyle-shepard/ishigaki/issues/16)) — heating and
   clothing alongside food. One need is a dial; two are a decision, because the same finite pool of
   villagers has to serve both. `resource.is_food` generalises to a needs table.
2. **Tools & the quality loop** ([#15](https://github.com/kyle-shepard/ishigaki/issues/15)) — tools
   as produced goods, and effective skill computed live from base skill, tool quality, the building
   worked in, and the land. This is LoL's actual mechanic (_"skills … calculated in real time
   depending on the context of the unit: its level of fatigue, the quality of its equipment, the
   building or the land where it is located"_) and it is what closes the loop: better tools make
   better tools. Quality stops being a scoreboard.
3. **Seasons** ([#17](https://github.com/kyle-shepard/ishigaki/issues/17)) — a year that swings
   yields and consumption, so the same numbers become a stockpile-or-die rhythm rather than a flat
   drain.
4. **Decay, repair & storage limits** ([#18](https://github.com/kyle-shepard/ishigaki/issues/18)) —
   buildings wear out (quality's second consumer, already promised in the schema), and stock stops
   being unbounded so a barn has a job.

One hole in what already ships, sized to run on its own: **clay and iron are seeded across the map
and cannot be touched** ([#20](https://github.com/kyle-shepard/ishigaki/issues/20)) — with them,
the Digger and Miner professions are unreachable too. Stone is the worked example to copy.

**A note on testing these.** All four are slow-clock mechanics: a food crisis, a season, a
building wearing out. Judging whether any of them is _fun_ means reaching a grown settlement, and
today that has to be played into existence. The admin back door
([#11](https://github.com/kyle-shepard/ishigaki/issues/11)) is what makes the question answerable
in less than real-world days.

### Parked until the village works

Not cancelled — sequenced behind a game that stands up on its own. Every one of them is
multiplayer-shaped, scale-shaped, or both.

- **Accounts & identity** — auth, player identity, armorial, rankings. _(schema already ready)_
- **Organisations & titles** — LoL's legal-person model: lordship→empire, bishoprics, guilds,
  vassal/suzerain. Supersedes the old "settlement hierarchy" line as the thing to copy.
- **The era system** — LoL gates content globally by week, medieval through automata. A genuine
  fork in the content model, and an open product question rather than an epic.
- **Expansion & borders** — how a settlement claims more than the tile it started on.
- ~~**Shared-world reversal**~~ — **done** (locked decision #4,
  [#22](https://github.com/kyle-shepard/ishigaki/issues/22)). Starts are scattered across shared
  ground, and buildings and settlements are public facts about the map.
- ~~**The scale ladder**~~ — **the rendering half is done, the content half is what's parked.**
  The world is 6912² (47.8M tiles) generated as a pure function, the zoom runs from a single tile
  to the whole continent, and pulling back fades the ground to parchment so that what survives is
  the marks on it. What does _not_ exist is anything to mark: the far view draws one pin and one
  name per realm and stops there.

  The rest — county borders, seats, heraldry, labels per zoom band — is the **political overlay**,
  and it stays parked for the reason #10's Q step first gave and #21 closed on: with one player and
  expansion parked it draws an empty legend. It sequences behind **expansion & borders** and a
  reason for players to have a relationship. The rendering was always the easier half, and it is
  the half that got built.

- **Logistics, trade, military, politics** — in that order, and all after the reversal.
- **Premium currency & rush**, **time/progression hardening**, **character autonomy**.

Outside the ladder, three tickets that are interaction design and tooling rather than a strand of
the vision, and are sized to run on their own: an **admin back door** for seeding test states
([#11](https://github.com/kyle-shepard/ishigaki/issues/11)), a **right-click build menu**
([#12](https://github.com/kyle-shepard/ishigaki/issues/12)), and the **rosters** moved out of the
inspector rail ([#13](https://github.com/kyle-shepard/ishigaki/issues/13)).

Each epic runs its own QRSPI cycle.

---

## How we work

QRSPI per epic (Question → Research → Spec/design → Plan → Implement), each with a human
checkpoint. This vision doc is the parent artifact; epics are GitHub issues; code ships as PRs
linked to issues. Close the loop — nothing ships unwatched.
