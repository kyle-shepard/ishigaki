# Ishigaki (石垣)

A persistent, browser-based strategy game where players grow a single tiny hamlet —
over real, slow time — into a village, a castle town, a domain, and eventually a realm.

It's map-driven and slow-real-time: a zoomable tile world, buildings and populations,
and timed actions that resolve over real-world hours. It draws inspiration from
[Lands of Lords](https://www.landsoflords.com/), then goes its own way.

The setting is **feudal Japan**. _Ishigaki_ — the fitted-stone base of a Japanese
castle — is what everything is built on top of.

## Status

Early. Stack is locked (see [VISION.md](VISION.md)): **SvelteKit + PostgreSQL +
Drizzle**, TypeScript full-stack. The tracer bullet works end to end — you can order a
building, watch a character walk to the tile, and see it finish — on a featureless
16×16 grid. Terrain is the epic in progress.

> **There is no login, and there is no "your" hamlet.** `PLAYER_ID` is hardcoded to 1,
> so everyone who opens the deployed site shares one world, one hamlet, and one
> character. If two people click at once they are ordering the same character around.
> That is a deliberate stage, not a bug: the shared persistent world is the premise,
> and per-player identity is a later epic. Treat the live site as a sandbox to poke,
> not a game to win.

## Running locally

Prereqs: **Node 24+** (the seed script and tests run TypeScript directly, relying on
native type stripping) and a Postgres database — local, Docker, or hosted
[Neon](https://neon.tech).

```sh
npm install
cp .env.example .env          # then set DATABASE_URL to your Postgres connection string
npm run db:migrate            # applies migrations (creates health_check + seeds a row)
npm run dev                   # serves at http://localhost:5173
```

> **Secrets:** `.env` is gitignored and has never been committed — it holds your
> **development** branch credential only. The production credential lives in Vercel's
> environment variables and never enters this repo.

Verify the full app → Drizzle → Postgres path:

```sh
curl http://localhost:5173/health
# → {"ok":true,"db":"connected","check":{"id":1,"note":"scaffold ok","createdAt":"..."}}
```

Useful scripts: `npm run check` (type-check), `npm run format` / `npm run lint`
(prettier), `npm run db:generate` (new migration from schema changes),
`npm run db:studio` (Drizzle Studio).

## Deployment

Hosted on Vercel, deployed from GitHub: every push to `main` builds and ships. Postgres
is [Neon](https://neon.tech), on a **separate branch from local development** — so
`npm run seed` on your machine can't wipe the live world.

Vercel runs `npm run vercel-build`, which is `drizzle-kit migrate && vite build`. Schema
changes therefore apply themselves on deploy; there is no "remember to migrate prod"
step. A failing migration fails the build, which is the point — a broken migration
should stop the deploy rather than leave the site serving against a schema that doesn't
match the code.

Configuration is one environment variable in the Vercel project: `DATABASE_URL`, the
Neon **production** branch pooled connection string. Nothing else. If preview
deployments start failing, give the Preview scope its own `DATABASE_URL` pointing at
the development branch.

Seeding is deliberately _not_ part of the build — `npm run seed` truncates. The
production branch gets seeded by hand, once, and again only when a schema change makes
the old world invalid:

```sh
DATABASE_URL="<neon production branch url>" npm run seed
```

## Project layout

Standard SvelteKit. The convention that matters for growth (VISION decision #11 —
clean feature seams):

- `src/routes/` — pages and JSON API endpoints (`+server.ts`).
- `src/lib/server/` — server-only code (never shipped to the client). `db/` holds the
  Drizzle client and `schema.ts`.
- `src/lib/features/<feature>/` — **feature modules.** As game systems land (map,
  buildings, operations, characters), each gets its own folder here holding its schema,
  server logic, and UI — kept as a self-contained seam rather than spread across global
  folders. Created per feature when built, not pre-scaffolded.
- `drizzle/` — generated SQL migrations (committed).
