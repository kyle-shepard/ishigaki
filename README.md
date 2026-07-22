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

> **Every visitor gets their own private world — for now.** There is no login. A cookie
> holds a player id, and your first request to the API creates a hamlet and a character
> for you at the same starting coordinates everyone else gets. You cannot see anyone
> else's buildings and they cannot see yours, so two people can build on the same tile.
>
> This is a **temporary testing arrangement**, not the design. Ishigaki is meant to be
> one shared map where players are neighbours; the isolation is there so testers can
> play the loop without fighting over one character. See VISION #4 for the override and
> how to reverse it.
>
> Practical consequence: **clear your cookies and your realm is gone.** So is everyone's
> when the database is reseeded. Treat these worlds as disposable until accounts land.

## Running locally

Prereqs: **Node 24+** (the seed script and tests run TypeScript directly, relying on
native type stripping) and a Postgres database — local, Docker, or hosted
[Neon](https://neon.tech).

```sh
npm install
cp .env.example .env          # then set DATABASE_URL to your Postgres connection string
npm run db:migrate            # applies migrations (creates the tables)
npm run seed                  # fills the global catalogs and the 16×16 terrain grid
npm run dev                   # serves at http://localhost:5173
```

Seeding is not optional: the grid is 256 stored tiles, and `/api/world` throws rather than
render a world with no ground under it.

> **Secrets:** `.env` is gitignored and has never been committed.
>
> **`.env` and production currently point at the same Neon database.** There is no separate
> development branch — earlier revisions of this file claimed there was, which is worse than
> saying nothing, because it invites you to run destructive scripts without thinking. Assume
> everything you do locally is live: migrations apply to production the moment you run them,
> and ordinary play writes real rows.
>
> `npm run seed` truncates every realm, so it refuses to run when players exist unless you
> pass `--wipe`. That flag is the only thing standing between a routine reseed and deleting
> everyone's world.
>
> Splitting the two is real work rather than a second credential: `vercel-build` only runs
> migrations, so a fresh production branch would serve 500s from `/api/world` until something
> seeded it. Worth doing before the URL reaches a real player, or before the first migration
> that drops anything.

Verify the full app → Drizzle → Postgres path:

```sh
curl http://localhost:5173/health
# → {"ok":true,"db":"connected","check":{"id":1,"note":"scaffold ok","createdAt":"..."}}
```

Useful scripts: `npm run check` (type-check), `npm run format` / `npm run lint`
(prettier), `npm run db:generate` (new migration from schema changes),
`npm run db:studio` (Drizzle Studio).

## Deployment

Hosted on Vercel, deployed from GitHub: every push to `main` builds and ships. Postgres is
[Neon](https://neon.tech) — **the same database local development uses**, per the note above.
`npm run seed -- --wipe` on your machine wipes the live world, and a local `npm run db:migrate`
migrates production before the code using that schema has shipped.

Vercel runs `npm run vercel-build`, which is `drizzle-kit migrate && vite build`. Schema
changes therefore apply themselves on deploy; there is no "remember to migrate prod"
step. A failing migration fails the build, which is the point — a broken migration
should stop the deploy rather than leave the site serving against a schema that doesn't
match the code.

Configuration is one environment variable in the Vercel project: `DATABASE_URL`, the Neon
pooled connection string — currently the same branch `.env` points at. Nothing else.

It must be ticked for the **Production** environment specifically, not just added. Because
`vercel-build` migrates, the variable is read at **build** time, not only at runtime — so a
missing or wrongly-scoped one fails the build outright with `DATABASE_URL is not set`
before Vite ever runs. That is the intended failure: the alternative is a green deploy that
500s on every request. Saving the variable does not rebuild on its own, either — redeploy
after setting it.

If preview deployments start failing the same way, give the Preview scope its own
`DATABASE_URL` pointing at the development branch.

Seeding is deliberately _not_ part of the build — `npm run seed` truncates. It now seeds
only the global building catalog; players, hamlets, and characters are created on demand
when a visitor first hits the API. **Reseeding production drops every player**, so every
tester's cookie stops resolving and they each get a fresh world on their next request.
Seed by hand, once, and again only when a schema change makes the old worlds invalid:

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
