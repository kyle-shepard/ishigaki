# Ishigaki (石垣)

A persistent, browser-based strategy game where players grow a single tiny hamlet —
over real, slow time — into a village, a castle town, a domain, and eventually a realm.

It's map-driven and slow-real-time: a zoomable tile world, buildings and populations,
and timed actions that resolve over real-world hours. It draws inspiration from
[Lands of Lords](https://www.landsoflords.com/), then goes its own way.

The setting is **feudal Japan**. *Ishigaki* — the fitted-stone base of a Japanese
castle — is what everything is built on top of.

## Status

Scaffolding stage. Stack is locked (see [VISION.md](VISION.md)): **SvelteKit +
PostgreSQL + Drizzle**, TypeScript full-stack. No game logic yet — this is the empty
stage the tracer-bullet epic builds on.

## Running locally

Prereqs: Node 20+ and a Postgres database (any — local, Docker, or a hosted one like
[Neon](https://neon.tech)).

```sh
npm install
cp .env.example .env          # then set DATABASE_URL to your Postgres connection string
npm run db:migrate            # applies migrations (creates health_check + seeds a row)
npm run dev                   # serves at http://localhost:5173
```

> **Secrets:** `.env` holds a shared **dev** credential and is gitignored. Before this
> repo/app goes public, rotate the DB credential and move it to a real secret store.

Verify the full app → Drizzle → Postgres path:

```sh
curl http://localhost:5173/health
# → {"ok":true,"db":"connected","check":{"id":1,"note":"scaffold ok","createdAt":"..."}}
```

Useful scripts: `npm run check` (type-check), `npm run format` / `npm run lint`
(prettier), `npm run db:generate` (new migration from schema changes),
`npm run db:studio` (Drizzle Studio).

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
