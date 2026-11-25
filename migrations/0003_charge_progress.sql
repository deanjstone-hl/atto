-- atto/19: show the charge in progress on the dashboard, before it ends.
--
--   * charge_progress: one row per collector poll while a charge is open, sent as
--     `open_charging_session` on `POST /api/ingest/byd`. Insert-only, like every other table:
--     a poll is a row, and the dashboard reads the newest row of the vehicle.
--
-- The trade-off, written down. The other way was a nullable `charging_sessions.ended_at`, one
-- row per charge written when it opens and filled in when it closes. That is an update, which
-- nothing in this database does; it would also make the finished session's exactly-once
-- insert (keyed on started_at) collide with the open row's, and `energy_kwh > 0` and
-- `end_soc_pct >= start_soc_pct` would have to bend for a charge not yet worked out. A separate
-- table keeps `charging_sessions` finished sessions only, so every existing read, total and
-- trip is unchanged. The price is one small row every 30 minutes for the length of a charge
-- (about 20 for a 10-hour charge); they are never read once the session lands, and are cheap
-- to prune later if that ever matters. Nothing here reads or deletes them.
--
-- `energy_kwh` is null when the collector has no battery capacity configured. A row belongs to
-- a vehicle through (vehicle_id, user_id), as every child table does.

create table charge_progress (
  id text primary key not null default (
    lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) ||
    substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))
  ),
  user_id text not null check (length(user_id) between 1 and 200),
  vehicle_id text not null,
  started_at text not null check (julianday(started_at) is not null),
  observed_at text not null check (julianday(observed_at) is not null and julianday(observed_at) >= julianday(started_at)),
  start_soc_pct integer not null check (start_soc_pct between 0 and 100),
  soc_pct integer not null check (soc_pct between 0 and 100 and soc_pct >= start_soc_pct),
  energy_kwh real check (energy_kwh >= 0),
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) check (julianday(created_at) is not null),
  unique (vehicle_id, started_at, observed_at),
  foreign key (vehicle_id, user_id) references vehicles (id, user_id) on delete cascade
) strict;

create index charge_progress_vehicle_observed_idx on charge_progress (vehicle_id, observed_at desc);
create index charge_progress_user_id_idx on charge_progress (user_id);
