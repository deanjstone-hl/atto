---
title: ADR-006 — Read-only BYD import through a second account
status: accepted
date: 2026-11-07
context: atto1/77 (owner decision, 7 Nov 2026 12:40 AEDT, in Aquila); account set up in atto1/76
summary: "ADR-006: atto1 reads the ATTO 1's state from the BYD cloud with pybyd through a dedicated second account, read-only, from a homelab timer that posts to the Worker as one named Access service token; supersedes the no-import position"
read_when:
  - changing or running the BYD collector (collector/)
  - touching the ingest endpoint or the service-token path in worker/access.ts
  - deciding what BYD data atto1 may read, or which grant the second account needs
  - asking why charging sessions or readings appear without being entered
---

# ADR-006: Read-only BYD import through a second account

## Context

[ADR-003](adr-003-data-model.md) kept charging sessions manual and said an import from BYD
would wait for the privacy audit in [atto1/10](https://github.com/deanjstone/atto1/issues/10).
[docs/byd-telemetry-research.md](../byd-telemetry-research.md) §6 laid out what an import
implies: the only route is the reverse-engineered pybyd client, which logs in with an account
password (no scopes, no OAuth), sends a fabricated device profile, can also lock, unlock and
drive the car, breaches the BYD User Agreement's no-reverse-engineering clause, and can break
whenever BYD changes its app. Its safer alternative was "a read-only second account without a
control PIN, accepting single-session logout".

On 7 Nov 2026 the owner decided to go that way so atto1 can gather data: a second BYD account,
with the car authorised to it (atto1/76). BYD allows one app session per
account, so a login with the second account does not sign the phone app out
(the Minis session's handoff note, §6, kept in the private archive).

## Decision

- **Account.** The collector signs in only as the second account. Its login lives in Bitwarden
  (`atto1 BYD second account`) and, for the unattended run, in Bitwarden Secrets Manager as
  `atto1-byd-username` and `atto1-byd-password`. The owner's main account is never used.
- **Client: pybyd, read-only.** `collector/read-byd.py` calls `get_vehicles` and
  `get_vehicle_realtime` and nothing else. It never calls a command method (`RemoteCommand`,
  lock, unlock, climate, charging, windows, lights), never sets or uses a control PIN, never
  calls the GPS endpoint, and keeps MQTT push off. `collector/read-byd.test.ts` fails if the
  source names any of them. pybyd is pinned (`pybyd==0.0.80`: the first release that declares a guest account, which BYD requires of a shared car's account since 12 Nov 2026, [atto/3](https://github.com/deanjstone/atto/issues/3); the pin never goes below it).
- **Fixed fields.** The reader prints eight values: VIN, model name, online flag, the car's
  timestamp, state of charge, range, odometer and pybyd's charge state. Location, doors,
  tyres and the other 130-odd realtime fields never leave the reader's process, so the privacy
  cost of the import is the three numbers the dashboard shows plus the charge state.
- **Where and how often.** A systemd `--user` timer on the homelab runs
  `collector/run.ts` once every 30 minutes (`collector/systemd/`). Each run is one login and
  one realtime request; the realtime request wakes the car's telematics unit, so the interval
  is a battery trade-off (the hass-byd-vehicle README warns of 12 V drain from frequent
  polling) and is not shortened without a reason. The timer ships in the repo and is enabled
  by the owner ([docs/byd-collector.md](../byd-collector.md)); CI never runs the reader and
  nothing runs it from a Worker.
- **How it authenticates to the Worker.** One Cloudflare Access service token, `atto1-ingest`,
  sent as `CF-Access-Client-Id` and `CF-Access-Client-Secret`. The Access policy admits it
  with a Service Auth rule; the Worker then admits only the token whose client id equals
  `INGEST_CLIENT_ID` (compared in constant time against the JWT's `common_name`), and it acts
  as the owner by `INGEST_OWNER_SUBJECT` (the owner's Access `sub`). Both are plain `vars` in
  `wrangler.jsonc`, empty until the owner fills them; while either is empty, every service
  token is refused, as before. This amends ADR-005's "a token without a `sub` is refused": it
  still is, unless it is that one token.
- **The service token reaches one path.** `POST /api/ingest/byd`, insert-only with one
  exception: it finds the vehicle by (owner, VIN), or takes the owner's only vehicle when
  that has no VIN (a car added by hand first,
  [atto/5](https://github.com/deanjstone/atto/issues/5)) and fills in its VIN, or creates it,
  and adds a reading and, when a charge ended, a session. Filling a missing VIN is the only
  change it ever makes to an existing row (never the nickname or any other field), and it
  never deletes. A repeat of a stored reading or session is reported as
  `duplicate` instead of stored, and every other route (reads, assets, the entity `POST`s)
  answers 403. A signed-in person gets 403 on the ingest path. Rows are owned by
  `INGEST_OWNER_SUBJECT`, never by anything in the body.
- **Mapping into the ADR-005 tables.**

  | BYD realtime field | Table.column |
  |---|---|
  | VIN, model name | `vehicles.vin`, `vehicles.nickname` (configured; default `ATTO 1`), `battery_capacity_kwh` (configured) |
  | `elec_percent` | `range_observations.soc_pct` (rounded) |
  | `endurance_mileage` | `range_observations.displayed_range_km` (rounded) |
  | `total_mileage` | `range_observations.odometer_km` (rounded) |
  | car timestamp | `range_observations.observed_at` (the collector's clock if the car sent none) |
  | `charge_state` | not stored: drives session detection |

  Not mapped: outside temperature (the car reports cabin temperature only) and `climate_on`
  (no field confirmed). Both stay null.
- **Charging sessions are derived, and approximate.** BYD reports state, not sessions. A
  session opens on the first poll with `charge_state` = 1 (pybyd's authoritative charging
  state; value 15, "connected", is documented as unreliable and ignored) and closes on the
  first poll that is not. `started_at` and `ended_at` are poll times; `energy_kwh` is the
  charge gained times the configured battery capacity (no capacity configured: no session is
  recorded); `charger_type` is `dc_fast` above 12 kW average and `ac_home` otherwise, a guess.
  `notes` says so on every such row. A silence of more than six hours closes the session at the
  last poll that saw it. The rules are tested with synthetic polls; no real charge has been
  observed yet, so the first one should be checked against the car's own record.
- **No `source` column.** ADR-003 expected one. Adding it is a migration, which is a live step,
  for little gain: a collected session says so in its `notes`; a reading has no notes field in use, so
  it is not marked. Revisit if manual and collected rows need
  separating in queries.

## Consequences

- **Privacy trade-off, as research §6 states it.** Each poll is another server-side request
  logged against the VIN; BYD already holds the data, so this adds no new disclosure, but it
  adds a stored credential and a device fingerprint BYD never issued. The reverse-engineering
  clause in the User Agreement is breached, as the owner accepted on 7 Nov 2026. BYD can break
  or block the reader without notice; the failure mode is a failed timer run and no new rows,
  never a wrong write.
- **The credential is the risk, and the grant is already at the BYD app's minimum.** The
  account's password is stored in Bitwarden Secrets Manager on the homelab. The account holds
  Keys and control (Basic control), More control (Charging reservation) and Privacy (Vehicle
  location). The owner checked in the BYD app on 7 Nov 2026 (15:49 AEDT) that this is the
  lowest grant the app allows; nobody narrowed it further, and no run measured which grant
  fills which field. The live `read-byd.py --audit` at 15:26 AEDT on 7 Nov 2026 found 87 of
  139 realtime fields populated with this grant, including every field the collector maps
  (`online_state`, `elec_percent`, `endurance_mileage`, `total_mileage`, `charge_state`).
  The collector only reads: it calls `get_vehicles` and `get_vehicle_realtime`, never a
  control method and never the GPS method (a test fails if the source names one). **Residual
  risk:** a leaked password plus Basic control could lock and unlock the car, because the
  grant cannot be lowered below it.
- Remote Control Verification is off on the owner's car, so a command needs no PIN
  (the Minis session's handoff note, §4, kept in the private archive). No PIN is configured for this
  account either, which means a leaked password with a control grant could act on the car.
  That is why the grant is held at the app's minimum and the password stays in Secrets Manager.
- `pybyd` is an alpha, unofficial library; pinning it means a BYD-side change needs an
  explicit bump and a fixture refresh.
- The Worker gains two settings, `INGEST_CLIENT_ID` and `INGEST_OWNER_SUBJECT`, and a path
  that accepts a credential other than a person's sign-in. Both are covered by
  `worker/ingest.test.ts`, which also pins what the token may not do.
- The dashboard needs no change: it already reads `range_observations` and `charging_sessions`.
- Follow-ups: verify session detection against the
  first real charge; consider a `source` column if collected and manual rows need telling apart.
