#!/usr/bin/env bash
# Owner steps for atto/5: merge the duplicate vehicle the collector made into the vehicle
# the owner added by hand, so the dashboard and the readings agree again.
#
# Before the fix in this repo, `POST /api/ingest/byd` made a new vehicle (nicknamed
# "ATTO 1", carrying the VIN) because the owner's hand-made vehicle ("Toothless") had no
# VIN, so every collector reading landed on that second row while the dashboard showed the
# oldest one. The owner's decision (09:21 AEDT, 21 Nov 2026): one vehicle, nicknamed as the
# hand-made one, with the VIN and every reading. The VIN is unique per user and is not in
# this repo, so SQL cannot copy it between rows: the row that carries it survives. It takes
# the hand-made row's nickname, creation time and any field it lacks, the hand-made row's
# readings, charging sessions, features, maintenance records and notes move onto it, and
# then the hand-made row is deleted.
#
# Run on WSL2 as ONE approved command, from a checkout at the promoted commit, after the
# promotion that carries the fix (atto/5), with `wrangler` logged in. It reads the D1
# database id from Secrets Manager (ATTO_D1_DATABASE_ID, via ~/.bws_token), writes it only to
# a temporary wrangler config that is deleted on exit, and never prints it:
#   bash scripts/owner-steps/5.sh --dry-run   # read-only: print the vehicles and what it would do
#   bash scripts/owner-steps/5.sh             # check, merge, check again
#
# It reads the vehicles first (read-only), and writes only when they are exactly: two
# vehicles of one user, the older without a VIN and the newer with one. Any other shape
# (one vehicle already, two users, more vehicles) changes nothing and says why. It checks
# again after writing and fails unless the survivor is the one vehicle, with the VIN, the
# nickname and every reading and session. Re-running it after a merge changes nothing, and
# re-running it after a failed merge finishes it. It never runs promote.sh and never pushes
# `deploy`.
set -euo pipefail

DB="${ATTO1_D1_DATABASE:-atto1}"
WRANGLER="${ATTO1_WRANGLER:-wrangler}"
DRY_RUN=0

case "${1:-}" in
  "") ;;
  --dry-run) DRY_RUN=1 ;;
  *) echo "usage: $0 [--dry-run]" >&2; exit 2 ;;
esac
[ "$#" -le 1 ] || { echo "usage: $0 [--dry-run]" >&2; exit 2; }

die() { printf 'error: %s\n' "$*" >&2; exit 1; }

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

for tool in jq bws column "$WRANGLER"; do command -v "$tool" > /dev/null || die "$tool is not installed"; done

# The database id is private (wrangler.jsonc holds a placeholder): read it by name from
# Secrets Manager into a throwaway config, as render-wrangler.ts does at deploy time.
[ -f "$HOME/.bws_token" ] || die "$HOME/.bws_token is missing (Secrets Manager access)"
set -a
# shellcheck source=/dev/null
. "$HOME/.bws_token"
set +a
secrets=$(bws secret list -o json) || die "Secrets Manager did not answer"
database_id=$(jq -r '[.[] | select(.key == "ATTO_D1_DATABASE_ID")][0].value // empty' <<< "$secrets")
unset secrets
[ -n "$database_id" ] || die "Secrets Manager has no ATTO_D1_DATABASE_ID"
jq -n --arg name "$DB" --arg id "$database_id" \
  '{name: "atto1", d1_databases: [{binding: "DB", database_name: $name, database_id: $id}]}' > "$scratch/wrangler.jsonc"
unset database_id
wrangler_d1() { "$WRANGLER" d1 execute "$DB" --remote --config "$scratch/wrangler.jsonc" "$@"; }

# d1_rows <sql>: the rows of one read-only query, as a JSON array.
d1_rows() {
  wrangler_d1 --json --command "$1" > "$scratch/out.json" || die "the D1 query failed"
  jq -c '.[0].results' < "$scratch/out.json"
}

VEHICLES_SQL="select v.id, v.user_id, (v.vin is not null) as has_vin, v.nickname, v.created_at,
  (select count(*) from range_observations r where r.vehicle_id = v.id) as obs,
  (select max(r.observed_at) from range_observations r where r.vehicle_id = v.id) as last_obs,
  (select r2.odometer_km from range_observations r2 where r2.vehicle_id = v.id order by r2.observed_at desc limit 1) as last_odo,
  (select count(*) from charging_sessions s where s.vehicle_id = v.id) as sessions
  from vehicles v order by v.created_at"

# show <label> <rows>: the table, with the user id cut to its first six characters.
show() {
  echo "$1"
  jq -r '(["user","id","vin","nickname","created_at","obs","last_obs","last_odo_km","sessions"] | @tsv),
    (.[] | [(.user_id[0:6] + "..."), .id, (if .has_vin == 1 then "yes" else "no" end), .nickname, .created_at, .obs, (.last_obs // "-"), (.last_odo // "-"), .sessions] | @tsv)' <<< "$2" | column -t -s $'\t'
}

before=$(d1_rows "$VEHICLES_SQL")
show "Vehicles now:" "$before"

count=$(jq 'length' <<< "$before")
if [ "$count" -lt 2 ]; then
  echo "Nothing to merge: $count vehicle(s)."
  exit 0
fi

users=$(jq '[.[].user_id] | unique | length' <<< "$before")
if [ "$count" -eq 2 ] && [ "$users" -eq 2 ]; then
  cat >&2 <<'MESSAGE'

The two vehicles belong to different users: ingest writes as another user than the one the
dashboard reads. This script does not guess across users. Nothing was changed. Fix:
  1. Read the dashboard user's id:
       wrangler d1 execute atto1 --remote --command "select user_id from vehicles where vin is null"
  2. Set the GitHub Actions secret ATTO_INGEST_OWNER_SUBJECT (docs/public-cutover.md) to it.
  3. Promote, then re-run the collector once (docs/byd-collector.md, step 6).
The readings already stored under the other user then need moving by hand.
MESSAGE
  exit 3
fi

pair=$(jq -c 'if length == 2 and ([.[].user_id] | unique | length) == 1
    and .[0].has_vin == 0 and .[1].has_vin == 1 then {keeper: .[0], donor: .[1]} else empty end' <<< "$before")
if [ -z "$pair" ]; then
  echo "Unexpected shape: $count vehicles across $users user(s), not 'older without a VIN, newer with one'. Nothing was changed." >&2
  exit 3
fi

# keeper: the hand-made vehicle, deleted at the end. donor: the one with the VIN, which survives.
keeper=$(jq -r '.keeper.id' <<< "$pair")
donor=$(jq -r '.donor.id' <<< "$pair")
for id in "$keeper" "$donor"; do
  [[ "$id" =~ ^[A-Za-z0-9-]{1,64}$ ]] || die "unexpected vehicle id '$id'"
done
keeper_nickname=$(jq -r '.keeper.nickname' <<< "$pair")
keeper_obs=$(jq -r '.keeper.obs' <<< "$pair")
donor_obs=$(jq -r '.donor.obs' <<< "$pair")
keeper_sessions=$(jq -r '.keeper.sessions' <<< "$pair")
donor_sessions=$(jq -r '.donor.sessions' <<< "$pair")

guard="exists (select 1 from vehicles k, vehicles d where k.id = '$keeper' and d.id = '$donor' and k.user_id = d.user_id and k.vin is null and d.vin is not null)"
cat > "$scratch/merge.sql" <<SQL
update range_observations set vehicle_id = '$donor' where vehicle_id = '$keeper' and $guard;
update charging_sessions set vehicle_id = '$donor' where vehicle_id = '$keeper' and $guard;
update or ignore vehicle_features set vehicle_id = '$donor' where vehicle_id = '$keeper' and $guard;
update maintenance_records set vehicle_id = '$donor' where vehicle_id = '$keeper' and $guard;
update notes set vehicle_id = '$donor' where vehicle_id = '$keeper' and $guard;
update vehicles set
  nickname = (select nickname from vehicles where id = '$keeper'),
  created_at = (select created_at from vehicles where id = '$keeper'),
  model_year = coalesce(model_year, (select model_year from vehicles where id = '$keeper')),
  variant = coalesce(variant, (select variant from vehicles where id = '$keeper')),
  battery_capacity_kwh = coalesce(battery_capacity_kwh, (select battery_capacity_kwh from vehicles where id = '$keeper')),
  purchased_on = coalesce(purchased_on, (select purchased_on from vehicles where id = '$keeper'))
  where id = '$donor' and $guard;
delete from vehicles where id = '$keeper' and $guard;
SQL

echo
echo "Merge: vehicle $keeper ('$keeper_nickname', $keeper_obs readings, $keeper_sessions sessions) into $donor ($donor_obs readings, $donor_sessions sessions, carries the VIN)."
echo "The survivor $donor is named '$keeper_nickname'; $keeper is deleted."
if [ "$DRY_RUN" -eq 1 ]; then
  echo "[dry-run] would run, with wrangler d1 execute --remote --file:"
  cat "$scratch/merge.sql"
  exit 0
fi

wrangler_d1 --yes --file "$scratch/merge.sql" || die "the merge failed; re-run this script to finish it"

after=$(d1_rows "$VEHICLES_SQL")
echo
show "Vehicles after:" "$after"

verify_failed=0
check() {
  if [ "$2" = "$3" ]; then echo "verify ok: $1"; else echo "verify FAILED: $1 (wanted $3, found $2)" >&2; verify_failed=1; fi
}
check "one vehicle is left" "$(jq 'length' <<< "$after")" 1
check "it is the one that carries the VIN" "$(jq -r '.[0].id' <<< "$after")" "$donor"
check "it has the VIN" "$(jq -r '.[0].has_vin' <<< "$after")" 1
check "it is named '$keeper_nickname'" "$(jq -r '.[0].nickname' <<< "$after")" "$keeper_nickname"
check "it holds every reading" "$(jq -r '.[0].obs' <<< "$after")" "$((keeper_obs + donor_obs))"
check "it holds every charging session" "$(jq -r '.[0].sessions' <<< "$after")" "$((keeper_sessions + donor_sessions))"
[ "$verify_failed" -eq 0 ] || exit 1
echo "Done. Reload the dashboard: it should show the latest reading."
