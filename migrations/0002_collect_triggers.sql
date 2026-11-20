-- atto/6: trigger a collector run when the phone connects to or leaves CarPlay.
--
--   * collect_triggers: one row per request, added by `POST /api/collect/trigger` (the
--     phone's Access service token). Insert-only, like every other table.
--   * collect_acks: one row per trigger the collector has picked up, added by
--     `POST /api/collect/ack` (the collector's token). A trigger with no ack is pending.
--     Nothing is ever updated or deleted, so a trigger's state is "has an ack row".
--   * range_observations.trigger_event: the event the reading was taken for, null for a
--     timer reading. The trips view pairs a connect reading with the next disconnect.
--   * range_observations.latitude, longitude: the car's position, only on a reading that
--     carries a trigger_event (ADR-006's amendment). A timer reading never has one.
--
-- The event list is not a CHECK ... IN (...): SQLite cannot widen a CHECK without rebuilding
-- the table, and atto/8 adds charge_start and charge_stop. The Worker holds the list
-- (worker/collect.ts); the database only checks the shape of the name.

create table collect_triggers (
  id text primary key not null default (
    lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) ||
    substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))
  ),
  user_id text not null check (length(user_id) between 1 and 200),
  event text not null check (length(event) between 1 and 40 and event not glob '*[^a-z_]*'),
  requested_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) check (julianday(requested_at) is not null),
  unique (id, user_id)
) strict;

create index collect_triggers_user_requested_idx on collect_triggers (user_id, requested_at);

create table collect_acks (
  trigger_id text primary key not null,
  user_id text not null check (length(user_id) between 1 and 200),
  acked_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) check (julianday(acked_at) is not null),
  foreign key (trigger_id, user_id) references collect_triggers (id, user_id)
) strict;

alter table range_observations add column trigger_event text
  check (trigger_event is null or (length(trigger_event) between 1 and 40 and trigger_event not glob '*[^a-z_]*'));

alter table range_observations add column latitude real check (latitude between -90 and 90);

-- Both or neither, and only with a trigger_event.
alter table range_observations add column longitude real
  check (longitude between -180 and 180 and (longitude is null) = (latitude is null) and (longitude is null or trigger_event is not null));
