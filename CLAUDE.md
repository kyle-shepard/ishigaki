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

**Setting:** feudal Japan, not medieval Europe. This is the intended point of
divergence and flavor. *Ishigaki* (石垣) is the fitted-stone foundation of a Japanese
castle — the thing everything is built on top of.

## Ubiquitous language (working draft)

Prefer Japanese-flavored domain terms over generic/European ones. This list is a
starting point, not settled — refine it as the design firms up. The English gloss is
for us; player-facing naming can differ.

| Concept | Term | Notes |
|---|---|---|
| The stone-wall foundation / the game itself | 石垣 *ishigaki* | Castle base wall |
| Settlement ladder (small → large) | *mura* (village) → *machi* (town) → *jōkamachi* (castle town) | Growth stages |
| Feudal domain / fief | *han* (藩) | Player's realm once large enough |
| Province | *kuni* (国) | Region grouping domains |
| Great lord / ruler | *daimyō* (大名) | Top-tier player title |
| Warrior / retainer class | *samurai* / *bushi* | Military population |
| Peasant / common labor | *heimin* / *hyakushō* | Economic population |
| Rice as core resource/currency | *koku* (石) | Historical unit of land yield — note it's the same 石 as in ishigaki |

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
