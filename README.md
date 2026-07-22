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
> **Local development and production now use different Neon branches.** `.env` points at the
> development branch; Vercel's `DATABASE_URL` points at the production one. So `npm run seed`
> and `npm run db:migrate` no longer touch the live world, and production only migrates when a
> deploy runs `vercel-build`.
>
> **Do not trust the Neon console's branch names to tell you which is which.** They were
> misleading here — the branch labelled "dev" was the one Vercel actually served from. Names are
> a claim; the env var is the fact. Verify empirically before running anything destructive:
>
> ```sh
> # count players locally, hit production twice with no cookie, count again
> curl -s -o /dev/null https://ishigaki-eosin.vercel.app/api/world   # x2
> ```
>
> Each cookie-less request to `/api/world` mints a player. If your local player count moves,
> your `.env` is pointed at production — stop. `.env` itself carries the current mapping and
> how it was established; keep that comment true if you change branches.
>
> `npm run seed` on its own is **not destructive** — it upserts the catalog and leaves realms
> alone, which is what makes it safe for a deploy to run. `npm run seed -- --wipe` is the
> destructive one, and that flag is the only thing standing between a reseed and deleting
> everyone's world if `.env` is ever wrong.

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
[Neon](https://neon.tech), on a **separate branch from the one local development uses** (see the
note above). A local `npm run seed -- --wipe` or `npm run db:migrate` therefore hits development
only; production's schema changes when a deploy runs, not when you run a command.

Vercel runs `npm run vercel-build`, which is `drizzle-kit migrate && node scripts/seed.ts &&
vite build`. Schema _and_ content therefore apply themselves on deploy; there is no "remember
to migrate prod" step and no "remember to seed prod" one either. A failure in either stage
fails the build, which is the point — it should stop the deploy rather than leave the site
serving against a schema or a catalog that doesn't match the code.

**Content has to ship with the deploy, not after it**, because the code depends on it:
`ensurePlayer` throws if there is no House and no Barn to hand out, so a deploy that migrated
the schema and left the catalog behind serves 500s on every `/api/*` request while the page
itself still renders. That is exactly what happened on 2026-07-22, the first deploy after the
Neon branches were split — until then, content reached production because seeding "dev" _was_
seeding prod. `npm run seed` without `--wipe` is idempotent for this reason; running it on
every deploy is a no-op whenever the catalog already matches.

Note that `vercel-build` runs on **preview** deployments too, against whatever `DATABASE_URL`
is scoped to Preview. Scope that variable to the development branch, or a preview will migrate
and reseed production.

Configuration is one environment variable in the Vercel project: `DATABASE_URL`, the Neon
pooled connection string for the **production** branch — not the one `.env` uses. Nothing else.

It must be ticked for the **Production** environment specifically, not just added. Because
`vercel-build` migrates, the variable is read at **build** time, not only at runtime — so a
missing or wrongly-scoped one fails the build outright with `DATABASE_URL is not set`
before Vite ever runs. That is the intended failure: the alternative is a green deploy that
500s on every request. Saving the variable does not rebuild on its own, either — redeploy
after setting it.

If preview deployments start failing the same way, give the Preview scope its own
`DATABASE_URL` pointing at the development branch.

Seeding the catalog **is** part of the build, and is safe there because it upserts. Players,
hamlets and characters are never seeded — they are created on demand when a visitor first
hits the API.

Wiping production is a separate, deliberate act, and there is no reason to do it except when
a change genuinely cannot carry realms forward (see `ensurePlayer` on how that announces
itself). **It drops every player**, so every tester's cookie stops resolving and they each get
a fresh world on their next request:

```sh
DATABASE_URL="<neon production branch url>" node scripts/seed.ts --wipe
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
