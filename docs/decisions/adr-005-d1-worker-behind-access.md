---
title: ADR-005 — Cloudflare D1 behind an Access-gated Worker
status: accepted
date: 2026-10-29
context: issue #48 (owner decision, HITL triage 2026-10-26)
summary: "ADR-005: atto1's store is Cloudflare D1 (SQLite) behind a Worker that verifies Cloudflare Access JWTs; Supabase, its auth and RLS are dropped. Supersedes ADR-003's data layer"
read_when:
  - changing a table, column or constraint
  - touching worker/ or src/lib/api.ts
  - wiring sign-in, Access or the Cloudflare deploy
  - asking why there is no Supabase, RLS or magic-link sign-in
---

# ADR-005: Cloudflare D1 behind an Access-gated Worker

## Context

[ADR-003](adr-003-data-model.md) put atto1's data in Supabase: Postgres tables with row-level
security, PostgREST as the API, Supabase Auth (magic link) for sign-in, and a browser client
(`src/lib/supabase.ts`) holding the anon key. Nothing was ever applied: the Supabase project
([#2](https://github.com/deanjstone/atto1/issues/2)) was never created.

On 2026-10-26 the owner decided to rescope off Supabase: "Rescope to use SQLite", on
"Cloudflare D1 (SQLite) behind a Worker, Access-gated". atto1 is a single-owner app that is
already planned for a Cloudflare hostname ([ADR-001](adr-001-deploy-via-myargus-subdomain.md)),
so a second vendor with its own project, keys, auth settings and redirect allow-list buys
nothing. D1 is SQLite, the data is a few hundred rows, and Cloudflare Access can sign the
owner in at the edge with whichever identity provider the Access policy names.

## Decision

- **Store: Cloudflare D1.** One database, `atto1`, with the schema in `migrations/`
  (Wrangler's D1 layout), applied by `wrangler d1 migrations apply`.
- **API: one Worker** (`worker/index.ts`). It answers `/api/*` from D1 and serves the built
  app from the same origin through Workers Static Assets, so there is no CORS and no
  separate Pages project. It exposes `GET /api/me` and `GET /api/dashboard`, the dashboard's
  reads, and `POST /api/vehicles`, `/api/charging-sessions`, `/api/range-observations` and
  `/api/vehicle-features` (atto1#52), which add one row each, bound to the Access `sub`. The
  API has no update or delete.
- **Sign-in: Cloudflare Access.** An Access application on the hostname signs the owner in at
  the edge. There is no Supabase Auth, no sign-in form and no session in the app. The
  header's sign-out is Access's own `/cdn-cgi/access/logout`.
- **The Worker does not trust that Access is in front of it.** `worker/access.ts` verifies
  the `Cf-Access-Jwt-Assertion` token on every request, assets included, and fails closed:
  - RS256 only, signature checked with the key published at
    `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` (cached for ten minutes;
    refetched for an unknown key id at most once a minute);
  - issuer must be exactly `https://<team>.cloudflareaccess.com`, the audience must contain the
    application's AUD tag, `exp` is required, `nbf` is honoured, with a minute of clock skew;
    issuer and audience are compared in constant time;
  - the `sub` claim is the caller's identity; a token without one (a service token) is refused;
  - no token, a malformed one, unreachable signing keys, or unset `ACCESS_TEAM_DOMAIN` /
    `ACCESS_AUD` all refuse: 401 for a bad caller, 503 when Access is not configured. The
    response never says why; the reason goes to the Worker log.
  - only the header is read, never the `CF_Authorization` cookie.
- **Authorisation is the query.** Rows carry `user_id` (the Access `sub`); every query the
  Worker runs binds it, and child tables reference `vehicles (id, user_id)` so a row cannot
  point at another user's vehicle even through a buggy query. This replaces row-level security.
- **The Worker is reachable only on the custom domain.** `workers_dev` and `preview_urls` are
  off in `wrangler.jsonc`.

### What carries over from ADR-003

The entities, units (km, kWh, integer cents plus a currency, UTC instants, 0-100 state of
charge), derived-values-are-not-stored rule, specs-as-rows design and the CHECK constraints
stand. They are ported to SQLite as follows:

| Postgres | D1 (SQLite) |
|---|---|
| `uuid` ids from `gen_random_uuid()` | text ids, a uuid v4 default expression |
| `timestamptz`, `date` | UTC ISO 8601 text and `YYYY-MM-DD` text, checked with `julianday()` / `date()` |
| enums | text with `CHECK (... IN (...))` |
| `boolean`, `text[]` | `0`/`1` integer; JSON-array text (the Worker maps `climate_on` back to a boolean) |
| `numeric(p,s)` | `real`; `STRICT` tables keep integer columns integral |
| regex `CHECK`s (VIN, currency) | `GLOB` |
| `user_id default auth.uid()` + FK to `auth.users` | `user_id` text with no default; the Worker supplies it |
| `on delete set null (vehicle_id)` on notes | a `before delete` trigger on `vehicles` |
| `set_updated_at()` trigger function | one `after update` trigger per table |
| RLS policies, `anon` / `authenticated` roles | none |

### Types and validation

`src/lib/data-model/types.ts` stays hand-written. There is no `supabase gen types` and no
equivalent worth adopting: the Worker reshapes SQLite's loose types (booleans, JSON tags), so a
generator's output would not match what the client receives. `validation.ts` still mirrors the
CHECK constraints for forms; the database stays the authority, and the two change together.

### Tests

- `worker/schema.test.ts` applies `migrations/` to an in-process SQLite (Node's built-in
  `node:sqlite`, so no new dependency) and keeps every ADR-003 constraint test.
- The **RLS tests** the data-model PR planned (a user sees only their own rows, `user_id`
  cannot be forged, `anon` sees nothing) are replaced by Worker-level authorisation tests:
  `worker/dashboard.test.ts` (queries are scoped by user, the subject is bound and never
  spliced into SQL), `worker/access.test.ts` (every way a token can be wrong is refused) and
  `worker/index.test.ts` (no token, no data, no assets; an unconfigured Worker serves nobody).
- `node:sqlite` is stock SQLite like D1, but it is a stand-in. The first run against real D1 is
  the owner's `wrangler d1 migrations apply`, listed in `docs/deploy-branch.md`.

## Consequences

- Supersedes ADR-003's "Ownership and security" and "Types" sections and its Supabase tooling;
  the rest of ADR-003 stands. [#2](https://github.com/deanjstone/atto1/issues/2),
  [#26](https://github.com/deanjstone/atto1/issues/26) and
  [#36](https://github.com/deanjstone/atto1/issues/36) are Supabase-specific and are closed or
  rewritten by this change; [#47](https://github.com/deanjstone/atto1/issues/47) becomes a
  Worker deploy instead of a Pages deploy. [#10](https://github.com/deanjstone/atto1/issues/10)
  (BYD telemetry) is unaffected.
- Amends [ADR-001](adr-001-deploy-via-myargus-subdomain.md): the hostname stays, the host is a
  Worker with static assets, not Pages, and there are no Supabase redirect URLs.
- Amends [ADR-004](adr-004-deploy-only-from-the-deploy-branch.md): `pnpm run db:migrate`
  (`wrangler d1 migrations apply atto1 --remote`) and `pnpm run deploy` (`wrangler deploy`)
  replace `db:push` and the Pages deploy, behind the same `require-deploy-checkout.sh` guard.
- Wrangler is a global tool (ADR-002), not a dependency. Dependencies drop `@supabase/supabase-js`
  and `@electric-sql/pglite`.
- The dev server (`pnpm run dev`) answers `/api/*` from the dashboard fixtures; it has no
  Worker, D1 or Access. The Worker's behaviour is covered by its tests, not by the dev server.
- Until the owner creates the D1 database and Access application and fills the ids into
  `wrangler.jsonc`, nothing is live. A deploy before that fails (placeholder database id) or the
  Worker answers 503 (empty Access settings).
- Writes (and the forms that use them) are not built. A first writer needs its own endpoint,
  validation shared with `validation.ts`, and ownership tests.
- Sign-in no longer works away from Access: signing in to a local preview is not a thing. A
  sign-in method change (a different identity provider, or one-time PINs) is an Access policy
  edit, not a code change.
