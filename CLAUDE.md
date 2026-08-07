# Ishigaki — project guide

## What this is

A persistent, multiplayer, browser-based web game. Players each start with a tiny
hamlet and grow it — slowly, over real-world time — up a ladder of settlement and
political scale. The game runs continuously; there is no "match." Progress accrues
whether or not you're logged in, and the world is shared and player-shaped.

**Design north star:** [Lands of Lords](https://www.landsoflords.com/). The initial
goal is to reproduce its feel — a map/tile-driven feudal MMO with a slow real-time
economy and player-run politics — closely enough to be a recognizable clone, then
diverge deliberately from there. When a mechanic is undecided, "what would Lands of
Lords do?" is a reasonable default question, not a mandate.

**Setting:** feudal Japan is the _eventual_ skin, applied later as a data swap over
display-name columns (see [VISION.md](VISION.md)). For the current build phase, code and
docs use **neutral English domain terms**, with medieval-European framing as the interim
placeholder where flavor is needed. _Ishigaki_ (石垣) — the fitted-stone foundation of a
Japanese castle — remains the project's name and motif.

## Ubiquitous language

**Code vocabulary is neutral English** — Settlement, Building, Population, Character,
Skill, Resource, Tile — medieval-European where interim flavor helps. The Japanese terms
below are **not** the current code vocabulary; they are the **future reskin dataset**,
swapped 1:1 over display-name columns when we choose to flip the setting (per VISION.md).
Do **not** name code identifiers in Japanese now.

| Concept                                     | Reskin term                                                   | Notes                                                                |
| ------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------- |
| The stone-wall foundation / the game itself | 石垣 _ishigaki_                                               | Castle base wall                                                     |
| Settlement ladder (small → large)           | _mura_ (village) → _machi_ (town) → _jōkamachi_ (castle town) | Growth stages                                                        |
| Feudal domain / fief                        | _han_ (藩)                                                    | Player's realm once large enough                                     |
| Province                                    | _kuni_ (国)                                                   | Region grouping domains                                              |
| Great lord / ruler                          | _daimyō_ (大名)                                               | Top-tier player title                                                |
| Warrior / retainer class                    | _samurai_ / _bushi_                                           | Military population                                                  |
| Peasant / common labor                      | _heimin_ / _hyakushō_                                         | Economic population                                                  |
| Rice as core resource/currency              | _koku_ (石)                                                   | Historical unit of land yield — note it's the same 石 as in ishigaki |

The resource model is settled (see the schema); settlement scale and the title ladder are not — see
"Open decisions" below.

## Public repo hygiene

This repo is headed for **public release**. Keep everything that ships — commit messages,
code comments, doc prose, branch names, PR text — free of personal information (real
names, emails, internal paths, employer/client references) and secrets. Write it as if a
stranger will read it, because they will. Secrets live in gitignored `.env` files, never
in tracked code or history; rotate any dev credential before going public.

## How we work here

This project follows the QRSPI flow (see `C:\dev\victorylive\qrspi-flow.md`):
**Q**uestion → **R**esearch → **S**pec/design → **P**lan → **I**mplement, each with a
human checkpoint. Claude does the volume; the human owns the decisions. Artifacts
(tickets, designs, plans) live on the GitHub issue for this repo, not as doc sprawl.

Close the loop: never ship code you haven't watched run. Build → run → look → fix until
the real output proves it works, then report what was actually observed.

## Watch this: database egress

**The binding resource on this project is Neon's network transfer**, not compute or storage. In
July 2026 a read-heavy epic put **8.44 GB through a 5 GB allowance** and the project was suspended
mid-work, while compute sat at 23 of 100 CU-hours. Every `/api/world` read was pulling 28,583 rows
— the 16,384-tile grid plus its 12,199-row join to resources — ~1.3 MB per request to deliver ~6 KB
to the browser, ~156 MB/hour per idle open tab.

**Fixed, and then fixed harder.** Three changes retired it, in order:

1. **Content-versioned static payload** ([#21](https://github.com/kyle-shepard/ishigaki/issues/21)
   architecture A) — terrain and the catalogs never change between seeds, so they are served from
   `/api/world/static/[version]` under an immutable cache, keyed on a **content-derived
   `world_version`** (a hash of `WORLD_SEED`, `GRID_SIZE` and `worldgen.ts`'s own source — never a
   timestamp, because `vercel-build` runs the seed on every deploy). The heartbeat also pauses on
   `document.hidden`.
2. **Terrain stopped being rows.** It is a pure function of the seed, generated in-process and
   trusted only once its hash matches `game_config.terrain_hash`. The `tile` table is **deleted**.
3. **Terrain stopped being shipped.** The generator runs in the browser too, so the client builds
   the grid itself. The static payload is **4,786 bytes** for a 47.8M-tile world, measured on
   production.

A cold `/api/world` went from 67 s / 5,178,273 rows / 238 MB to **2.5 s / ~110 rows / ~0**. A
heartbeat is **2,158 bytes**. `npm run seed` went from two minutes to about six seconds.

Still worth your attention:

- **`npm run egress`** reports rows sent and what they cost. Run it after any work that touches the
  database, and report the number. It exists because nothing warned us the first time.
- **Terrain is off the meter, the rest is not.** Everything still read per request — buildings,
  settlements, characters, operations, stock — scales with how much the world holds, and
  `buildings` and `settlements` are full reads, not viewport-scoped. That is cheap at a handful of
  realms and is the next thing to cull if it ever isn't.
- Beware anything that loops HTTP requests (`npm run check:rules` is ~110 calls a run) and beware
  leaving a dev server with a tab open — much cheaper than it was, not free.

**Ceilings, current.** `route()` searches a window around the journey rather than allocating
`gridSize²` buffers, and the overview bitmap is a fixed 1024² regardless of world size, so neither
scales with world area any more. What is left is CPU, not egress: the coarse hydrology grid is built
eagerly at import (1.1 s for 6912², server _and_ browser), and building the overview bitmap samples
the generator 1,048,576 times. Both are paid once per process per world version, and both scale with
world area — so a world much larger than this one needs the terrain artifact chunked, which is where
[#21](https://github.com/kyle-shepard/ishigaki/issues/21)'s architecture C would come back.

## Decisions already made

Don't reopen these casually — each is load-bearing and most have code shaped around them.

- **Tech stack** — TypeScript, SvelteKit (Svelte 5 runes), Postgres on Neon via Drizzle, hosted on
  Vercel. No real-time transport: the client polls `GET /api/world` on a heartbeat that pauses on
  `document.hidden`.
- **World model** — a dense tile grid, 6912 × 6912 (47.8M tiles, ~20 m a tile), generated as a pure
  function of the seed and stored nowhere. Settlements sit on seeded `start_position` rows with
  wilderness between them.
- **Time model** — no ticks. Everything is **integrated on read** from a stored timestamp, which is
  why a week away equals a hundred visits and why the economy can run slowly without a scheduler.
- **Persistence & concurrency** — Postgres, with the settlement row locked for the duration of a
  world resolve and `FOR UPDATE SKIP LOCKED` where two visitors can race for the same ground.
- **Testing** — `node --test`, no framework. Pure functions carry the arithmetic so the slow
  mechanics can be pinned without playing them.

## Open decisions (not yet made)

Deliberately unresolved. Don't assume an answer — raise them for the human.

- **Settlement & title ladder** — reach radius steps at population milestones today; the stages
  from hamlet to realm and their thresholds are not settled.
- **Multiplayer/political layer** — vassalage, alliances, war, player governance. Parked, not
  designed. See "Where the focus is" below.
- **Tile size and the population ceiling** —
  [#25](https://github.com/kyle-shepard/ishigaki/issues/25). A continent-sized world with a
  1,000-person cap gives sparse cities; a smaller tile would buy the city look and multiply the
  tile count again. Both are game-feel calls.

## Where the focus is

**The single-city loop, until it is fun.** The map is finished for that purpose — it renders a
continent, costs nearly nothing to serve, fades to parchment when you pull back, and names every
place on it. Multiplayer-shaped work is parked _again_, on purpose: politics, borders, heraldry,
accounts and session lifetime were all closed unbuilt because there is nothing to be political
about yet.

The open question is not "how does the world scale" — it is **"is there a decision worth making
on any given turn."** Today there is one need (food) and therefore one right answer. That is the
thing to fix. See VISION's village ladder, and prefer tickets that change what a player _does_
over tickets that change what the world _is_.

## Repo

- GitHub: https://github.com/kyle-shepard/ishigaki
- Default branch: `main`
