---
title: ADR-003 — Initial data model
status: accepted
date: 2026-10-07
context: issue #3
summary: "ADR-003: entities, units and constraints of the data model; its Supabase data layer is superseded by ADR-005 (D1)"
read_when:
  - changing a table, column or RLS policy
  - touching src/lib/data-model/
  - writing a query against the schema
---

# ADR-003: Initial data model

> **Partly superseded by [ADR-005](adr-005-d1-worker-behind-access.md).** The data layer moved
> from Supabase to Cloudflare D1 behind an Access-gated Worker. The entities, units, derived
> values, specs-as-rows design and validation sections stand, ported to SQLite as ADR-005
> describes. The Supabase specifics below (Postgres types and enums, `auth.uid()`, RLS, the
> PGlite tests, `supabase gen types`, `supabase/migrations/`) are history.

## Context

atto1 needs somewhere to record charging sessions, range observations, vehicle specs/features,
maintenance and freeform notes ([#3](https://github.com/deanjstone/atto1/issues/3)). The stack
already commits to Supabase (Postgres + PostgREST + Auth), and `src/lib/supabase.ts` is the only
data-access entry point. No Supabase project is wired up yet ([#2](https://github.com/deanjstone/atto1/issues/2)),
so the schema has to be defined and tested without a live database.

## Decision

The schema lives in `supabase/migrations/` (Supabase CLI layout) and is mirrored in TypeScript by
`src/lib/data-model/`.

### Entities

| Table | One row is… | Notable columns |
|---|---|---|
| `vehicles` | a car the user owns | `nickname`, `vin`, `model_year`, `variant`, `battery_capacity_kwh`, `purchased_on` |
| `charging_sessions` | one plug-in | `started_at`, `ended_at` (null while charging), `energy_kwh`, `cost_cents` + `currency`, `charger_type`, `location_name`, `start_soc_pct`/`end_soc_pct`, `odometer_km` |
| `range_observations` | a reading of the dash range estimate | `observed_at`, `soc_pct`, `displayed_range_km`, `odometer_km`, `outside_temp_c`, `climate_on` |
| `vehicle_features` | one spec or feature fact | `category`, `name`, `value` (text), `unit`, `manual_reference` |
| `maintenance_records` | one service, repair, recall, tyre job, software update… | `performed_on`, `category`, `title`, `provider`, `odometer_km`, `cost_cents`, `next_due_on`/`next_due_km` |
| `notes` | freeform note | `title`, `body`, `tags[]`, `pinned`, optional `vehicle_id` |

Every table has `id uuid`, `user_id`, `created_at` and `updated_at` (bumped by trigger).

### Units and types

- Distance: whole **km** (`integer`). Energy: **kWh** (`numeric`). Temperature: **°C**.
  State of charge: whole **percent 0–100**. The ATTO 1 is sold in km markets; miles are a display
  conversion only (`kmToMiles`).
- Money: integer **minor units** (`cost_cents`) plus an ISO 4217 `currency` defaulting to `AUD`.
  Never floats.
- Instants: `timestamptz`; calendar days (service dates, purchase date): `date`.
- **Derived values are not stored**: session duration, cost per kWh, kWh/100 km and projected
  full range are computed by `src/lib/data-model/units.ts`. Storing them invites drift.
- Closed vocabularies (`charger_type`, `feature_category`, `maintenance_category`) are Postgres
  enums; open ones (variant, provider, unit) are text.

### Ownership and security

- `user_id` defaults to `auth.uid()`; RLS on every table allows `authenticated` users only their
  own rows. `anon` sees nothing.
- Child tables reference `vehicles (id, user_id)` with a composite foreign key, so a row cannot be
  attached to another user's vehicle even by a buggy client.
- Deleting a vehicle cascades to its sessions, observations, features and maintenance, but
  **detaches** its notes (`on delete set null (vehicle_id)`): notes are user knowledge, not vehicle
  telemetry.

### Specs and features as rows, not columns

`vehicle_features` is a typed key/value table (`category`, `name`, `value`, `unit`) rather than a
wide `vehicle_specs` table. Spec sheets vary by variant and market and the app's goal is to be a
knowledge source for the manuals, so `manual_reference` (e.g. "Owner's manual p. 142") is carried
alongside each fact. The few specs the app computes with (battery capacity) are real columns on
`vehicles`.

### Validation in two places

The database `CHECK` constraints are the authority. `src/lib/data-model/validation.ts` mirrors them
so forms can show errors before a round trip. Both are covered by tests; change them together.

### Types

`src/lib/data-model/types.ts` is hand-written in the shape `supabase gen types typescript` emits and
types the shared client (`createClient<Database>`). Once #2 lands it can be replaced by generated
output without touching call sites.

## Consequences

- Tests: `pnpm test` runs Vitest. `supabase/tests/schema.test.ts` applies the migrations to an
  in-process PGlite database with a stub of Supabase's `auth` schema and roles, and asserts
  constraints, cascades and RLS. No live database is touched.
- The migration has **not** been applied to any Supabase project. Applying it is part of #2.
- Charging sessions are manual entries for now. Automated import from BYD telemetry is gated on
  the privacy audit in [#10](https://github.com/deanjstone/atto1/issues/10) and would add a
  `source` column rather than a new table.
- Odometer is captured per event rather than in its own table; a dedicated odometer log can be
  added later if trip-level distance tracking is needed.
