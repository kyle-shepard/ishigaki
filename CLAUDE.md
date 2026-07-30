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

Settlement scale, title ladder, and resource model are all still open — see below.

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

**Largely fixed** ([#21](https://github.com/kyle-shepard/ishigaki/issues/21) architecture A): terrain
and the catalogs are static between seeds, so they are memoized in-process behind a **content-derived
`world_version`** (a hash of `WORLD_SEED`, `GRID_SIZE` and `worldgen.ts`'s own source — never a
timestamp, because `vercel-build` runs the seed on every deploy) and served separately from
`/api/world/static/[version]` under an immutable cache. A read now pulls **~52 rows**, measured.
The heartbeat also pauses on `document.hidden`.

Still worth your attention:

- **`npm run egress`** reports rows sent and what they cost. Run it after any work that touches the
  database, and report the number. It exists because nothing warned us the first time.
- The memo is **per lambda instance** — each spin-up re-pays one grid read, ~1.3 MB at the
  128×128 grid this was measured against. The grid moved to 256×256 (65,536 tiles) for the
  shared-world reversal (VISION #4), which roughly quadruples that to ~5 MB — still two orders of
  magnitude under the old per-hour cost, and most cold instances should never reach it at all once
  the edge is serving `/api/world/static/[version]`. Re-measure with `npm run egress` the next
  time this number matters; the upgrade path is a blob/CDN artifact (#21 architecture C), which
  also takes distant terrain out of the database entirely.
- **`route()` and `loadGrid` still scale with world area**, so the ceiling is ~1024²–2048² tiles.
  Past that the terrain artifact must go chunked and routing viewport-scoped.
- Beware anything that loops HTTP requests (`npm run check:rules` is ~110 calls a run) and beware
  leaving a dev server with a tab open — much cheaper than it was, not free.

## Open decisions (not yet made)

These are deliberately unresolved. Don't assume an answer — raise them for the human.

- **Tech stack** — language, web framework, DB, real-time transport, hosting. Nothing
  chosen yet. This is the immediate next fork.
- **World model** — tile grid vs. region graph; map scale; how adjacency/expansion works.
- **Time model** — tick cadence, offline progression, how "slow" the economy runs.
- **Settlement & title ladder** — exact stages from hamlet to realm, and the thresholds.
- **Multiplayer/political layer** — vassalage, alliances, war, player governance.
- **Persistence & concurrency** — how shared world state is stored and updated safely.

## Repo

- GitHub: https://github.com/kyle-shepard/ishigaki
- Default branch: `main`
