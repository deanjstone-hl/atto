#!/usr/bin/env bash
# Owner steps for atto/10: move atto's deploy values to the `actions` project of Bitwarden
# Secrets Manager, so deploy.yml reads them through bitwarden/sm-action (the pilot of
# argus-config/1418), then, after a green deploy, delete the Actions secrets it replaced.
#
# Run on WSL2, from an approval thread or a terminal, as ONE approved command each, from a
# checkout at the merged commit:
#
#   1. Before the promotion:
#        bash scripts/owner-steps/10.sh --dry-run     # read state, print every action, change nothing
#        bash scripts/owner-steps/10.sh
#      Optionally name the vault item holding the `actions-read` token, to prove that token reads
#      the `actions` project and nothing else:
#        ATTO_ACTIONS_READ_BW_ITEM='<item name>' bash scripts/owner-steps/10.sh
#
#   2. After the owner's Approve on the promotion has run `deploy.yml` green on the new path:
#        bash scripts/owner-steps/10.sh --delete-actions-secrets --dry-run
#        bash scripts/owner-steps/10.sh --delete-actions-secrets
#
# What step 1 changes, and only when the state is not already as wanted (idempotent):
#   - Moves each secret whose id deploy.yml maps (the six ATTO_* Worker values) from the project
#     `personal-machine-secrets` to `actions`, with `bws secret edit --project-id`. The id and the
#     value stay the same, so anything reading the id keeps working.
#   - Creates `ATTO_CLOUDFLARE_API_TOKEN` (from `ci-deploy-atto1`) and `ATTO_CLOUDFLARE_ACCOUNT_ID`
#     (from `ARGUS_CLOUDFLARE_ACCOUNT_ID`) in `actions`, copying the existing values. They are
#     copies, not moves: a hand deploy still reads `ci-deploy-atto1`, and the account id belongs
#     to argus too. It prints their new ids; the workflow change that moves the two Cloudflare
#     credentials onto sm-action needs them (sm-action looks a secret up by id).
#   - Verifies: each id in deploy.yml is now a secret of that name in `actions`, the two
#     Cloudflare keys are there, and, when ATTO_ACTIONS_READ_BW_ITEM is set, that the
#     `actions-read` token reads each of them by id and sees no key outside `actions`.
# What step 2 changes: deletes the Actions secrets of the repository that the Deploy workflow, at
# the head of its latest successful run on `deploy`, no longer reads (the six ATTO_* values now,
# the Cloudflare pair once a later workflow change moves it). It refuses unless that run is green,
# its deploy.yml uses sm-action, and BWS_ACCESS_TOKEN is set. It never deletes BWS_ACCESS_TOKEN.
#
# Secrets: read inside this script, never printed, logged or put in a curl argument. `bws` 2.1.0 has
# no stdin form for a value, so a value being copied is in that one `bws` process's arguments for a
# moment, visible only to this user on this host. It prints key names and ids, never a value. It never
# runs promote.sh, never pushes `deploy`, never starts a workflow.
set -euo pipefail

REPO="${ATTO_REPO:-deanjstone/atto}"
SOURCE_PROJECT="${ATTO_BWS_SOURCE_PROJECT:-personal-machine-secrets}"
DEST_PROJECT="${ATTO_BWS_PROJECT:-actions}"
BW_HELPER="${ATTO_BW_HELPER:-$HOME/repos/argus-config/envs/wsl2/bashrc.d/bitwarden.sh}"
READ_BW_ITEM="${ATTO_ACTIONS_READ_BW_ITEM:-}"
WORKFLOW="${ATTO_WORKFLOW:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/.github/workflows/deploy.yml}"

# The two Cloudflare credentials: destination key in `actions`, then the key to copy from.
CF_KEYS=(ATTO_CLOUDFLARE_API_TOKEN ATTO_CLOUDFLARE_ACCOUNT_ID)
CF_SOURCES=(ci-deploy-atto1 ARGUS_CLOUDFLARE_ACCOUNT_ID)
# Every Actions secret the old deploy.yml read; step 2 considers exactly these.
OLD_ACTIONS_SECRETS=(ATTO_D1_DATABASE_ID ATTO_ACCESS_TEAM_DOMAIN ATTO_ACCESS_AUD ATTO_INGEST_CLIENT_ID ATTO_INGEST_OWNER_SUBJECT ATTO_TRIGGER_CLIENT_ID CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID)

usage() { echo "usage: $0 [--dry-run] | $0 --delete-actions-secrets [--dry-run]" >&2; exit 2; }
DRY_RUN=0 DELETE_MODE=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --delete-actions-secrets) DELETE_MODE=1 ;;
    *) usage ;;
  esac
done

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
plan() { if [ "$DRY_RUN" -eq 1 ]; then echo "[dry-run] $*"; else echo "+ $*"; fi; }

preflight_failed=0
preflight_need() {
  # preflight_need <description> <test command...>
  local description="$1"; shift
  if "$@" >/dev/null 2>&1; then
    echo "pre-flight ok: $description"
  else
    echo "pre-flight FAILED: $description" >&2
    preflight_failed=1
  fi
}
verify_failed=0
verify_check() {
  # verify_check <description> <test command...>
  local description="$1"; shift
  if "$@" >/dev/null 2>&1; then echo "verify ok: $description"; else echo "verify FAILED: $description" >&2; verify_failed=1; fi
}

# The ids deploy.yml hands to sm-action: lines of `<uuid> > <ENV_NAME>`, one place for the map.
workflow_map() {
  sed -nE 's/^[[:space:]]+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) > ([A-Z][A-Z0-9_]+)[[:space:]]*$/\1 \2/p' "$1"
}
# Non-comment text of a workflow, to look for what it still reads.
workflow_code() { grep -vE '^[[:space:]]*#' "$1"; }

# =============================================================================================
# Step 2: delete the Actions secrets the green deploy no longer reads
# =============================================================================================

if [ "$DELETE_MODE" -eq 1 ]; then
  run_json="" green_sha="" green_workflow="" listed=""
  have_tools_delete() { command -v gh && command -v jq; }
  latest_deploy_green() {
    run_json=$(gh run list -R "$REPO" --workflow deploy.yml --branch deploy --limit 1 --json conclusion,headSha,databaseId) || return 1
    [ "$(jq -r '.[0].conclusion // empty' <<< "$run_json")" = success ] || return 1
    green_sha=$(jq -r '.[0].headSha // empty' <<< "$run_json")
    [ -n "$green_sha" ]
  }
  green_workflow_uses_sm_action() {
    green_workflow=$(mktemp)
    gh api -H "Accept: application/vnd.github.raw" "repos/$REPO/contents/.github/workflows/deploy.yml?ref=$green_sha" > "$green_workflow" || return 1
    workflow_code "$green_workflow" | grep -Eq 'uses:[[:space:]]*bitwarden/sm-action@'
  }
  list_actions_secrets() { listed=$(gh secret list -R "$REPO" --json name --jq '.[].name'); }
  listed_has() { grep -qx "$1" <<< "$listed"; }
  trap '[ -z "${green_workflow:-}" ] || rm -f "$green_workflow"' EXIT

  preflight_need "gh and jq are installed" have_tools_delete
  if [ "$preflight_failed" -eq 0 ]; then
    preflight_need "the latest Deploy run on deploy succeeded" latest_deploy_green
  fi
  if [ "$preflight_failed" -eq 0 ]; then
    preflight_need "that run's deploy.yml (at $green_sha) reads its secrets through bitwarden/sm-action" green_workflow_uses_sm_action
    preflight_need "the Actions secrets of $REPO can be listed" list_actions_secrets
  fi
  if [ "$preflight_failed" -eq 0 ]; then
    preflight_need "the Actions secret BWS_ACCESS_TOKEN is set, which the green deploy needed" listed_has BWS_ACCESS_TOKEN
  fi
  [ "$preflight_failed" -eq 0 ] || { echo "stopping: nothing was changed" >&2; exit 1; }

  to_delete=()
  for name in "${OLD_ACTIONS_SECRETS[@]}"; do
    listed_has "$name" || continue
    if workflow_code "$green_workflow" | grep -Eq "secrets\.${name}\b"; then
      echo "keep $name: the green workflow still reads it"
    else
      plan "delete Actions secret $name"
      to_delete+=("$name")
    fi
  done
  if [ "${#to_delete[@]}" -eq 0 ]; then echo "nothing to delete"; exit 0; fi
  [ "$DRY_RUN" -eq 0 ] || exit 0

  for name in "${to_delete[@]}"; do
    gh secret delete "$name" -R "$REPO" > /dev/null || die "could not delete the Actions secret $name"
  done

  list_actions_secrets || die "could not re-list the Actions secrets"
  not_listed() { ! listed_has "$1"; }
  for name in "${to_delete[@]}"; do verify_check "Actions secret $name is gone" not_listed "$name"; done
  verify_check "BWS_ACCESS_TOKEN is still set" listed_has BWS_ACCESS_TOKEN
  [ "$verify_failed" -eq 0 ] || exit 1
  exit 0
fi

# =============================================================================================
# Step 1: move the keys to `actions`, copy the Cloudflare pair
# =============================================================================================

secrets="" source_id="" dest_id="" scoped_token=""
pair_ids=() pair_keys=()

secret_field() { jq -r --arg k "$1" --arg f "$2" '[.[] | select(.key == $k)][0][$f] // empty' <<< "$secrets"; }
secret_value() { secret_field "$1" value; }
secret_id_of() { secret_field "$1" id; }
# in_project <key> <project id>: the key exists in that project.
in_project() { jq -e --arg k "$1" --arg p "$2" '[.[] | select(.key == $k and .projectId == $p)] | length > 0' > /dev/null <<< "$secrets"; }
# id_is <id> <key> <project id>: that exact id is a secret of that key in that project.
id_is() { jq -e --arg i "$1" --arg k "$2" --arg p "$3" '[.[] | select(.id == $i and .key == $k and .projectId == $p)] | length > 0' > /dev/null <<< "$secrets"; }
id_in_either() { id_is "$1" "$2" "$source_id" || id_is "$1" "$2" "$dest_id"; }

have_tools() { local tool; for tool in jq bws; do command -v "$tool" || return 1; done; }
load_secrets() {
  # The file is a bare BWS_ACCESS_TOKEN=... line: export it for the bws processes below.
  set -a; . "$HOME/.bws_token"; set +a
  secrets=$(bws secret list -o json) || return 1
  jq -e 'type == "array"' <<< "$secrets"
}
resolve_projects() {
  local listing
  listing=$(bws project list -o json) || return 1
  source_id=$(jq -r --arg n "$SOURCE_PROJECT" '[.[] | select(.name == $n)][0].id // empty' <<< "$listing")
  dest_id=$(jq -r --arg n "$DEST_PROJECT" '[.[] | select(.name == $n)][0].id // empty' <<< "$listing")
  [ -n "$source_id" ] && [ -n "$dest_id" ]
}
read_workflow_map() {
  local id key
  while read -r id key; do pair_ids+=("$id"); pair_keys+=("$key"); done < <(workflow_map "$WORKFLOW")
  [ "${#pair_ids[@]}" -gt 0 ]
}
cf_source_available() {
  # cf_source_available <dest key> <source key>: already in actions, or there is a value to copy.
  in_project "$1" "$dest_id" || in_project "$2" "$source_id"
}

preflight_need "jq and bws are installed" have_tools
preflight_need "$HOME/.bws_token exists (Secrets Manager access)" test -f "$HOME/.bws_token"
if [ "$preflight_failed" -eq 0 ]; then
  preflight_need "Secrets Manager answers (bws secret list)" load_secrets
fi
if [ "$preflight_failed" -eq 0 ]; then
  preflight_need "Secrets Manager projects $SOURCE_PROJECT and $DEST_PROJECT exist" resolve_projects
  preflight_need "$WORKFLOW maps at least one secret id for sm-action" read_workflow_map
fi
if [ "$preflight_failed" -eq 0 ]; then
  for i in "${!pair_ids[@]}"; do
    preflight_need "deploy.yml's id for ${pair_keys[$i]} is a secret of that name in $SOURCE_PROJECT or $DEST_PROJECT" \
      id_in_either "${pair_ids[$i]}" "${pair_keys[$i]}"
  done
  for i in "${!CF_KEYS[@]}"; do
    preflight_need "${CF_KEYS[$i]} is in $DEST_PROJECT, or ${CF_SOURCES[$i]} in $SOURCE_PROJECT can be copied" \
      cf_source_available "${CF_KEYS[$i]}" "${CF_SOURCES[$i]}"
  done
fi
[ "$preflight_failed" -eq 0 ] || { echo "stopping: nothing was changed" >&2; exit 1; }

# ---- plan ----------------------------------------------------------------------------------

moves=() creates=()
for i in "${!pair_ids[@]}"; do
  if id_is "${pair_ids[$i]}" "${pair_keys[$i]}" "$dest_id"; then
    echo "${pair_keys[$i]} (${pair_ids[$i]}): already in $DEST_PROJECT, left as is"
  else
    plan "move ${pair_keys[$i]} (${pair_ids[$i]}) from $SOURCE_PROJECT to $DEST_PROJECT"
    moves+=("$i")
  fi
done
for i in "${!CF_KEYS[@]}"; do
  if in_project "${CF_KEYS[$i]}" "$dest_id"; then
    echo "${CF_KEYS[$i]}: already in $DEST_PROJECT, left as is"
  else
    plan "create ${CF_KEYS[$i]} in $DEST_PROJECT from ${CF_SOURCES[$i]} (the value is copied, never printed)"
    creates+=("$i")
  fi
done
if [ "${#moves[@]}" -eq 0 ] && [ "${#creates[@]}" -eq 0 ]; then echo "nothing to change"; fi
if [ "$DRY_RUN" -eq 1 ]; then
  plan "verify: each deploy.yml id is a secret of that name in $DEST_PROJECT, the two Cloudflare keys are there, and (with ATTO_ACTIONS_READ_BW_ITEM) the $DEST_PROJECT-scoped token reads them by id and sees nothing else"
  exit 0
fi

# ---- changes -------------------------------------------------------------------------------

for i in "${moves[@]}"; do
  bws secret edit --project-id "$dest_id" -o none "${pair_ids[$i]}" > /dev/null \
    || die "could not move ${pair_keys[$i]} (${pair_ids[$i]}) to $DEST_PROJECT"
  plan "moved ${pair_keys[$i]} to $DEST_PROJECT"
done
for i in "${creates[@]}"; do
  value=$(secret_value "${CF_SOURCES[$i]}")
  [ -n "$value" ] || die "${CF_SOURCES[$i]} has no value to copy"
  bws secret create --note "atto deploy, copied from ${CF_SOURCES[$i]} (atto/10)" -o none "${CF_KEYS[$i]}" "$value" "$dest_id" > /dev/null \
    || { unset value; die "could not create ${CF_KEYS[$i]} in $DEST_PROJECT"; }
  unset value
  plan "created ${CF_KEYS[$i]} in $DEST_PROJECT"
done

# ---- verify --------------------------------------------------------------------------------

secrets=$(bws secret list -o json) || die "could not re-read Secrets Manager"

six_ids_in_dest() {
  local i
  for i in "${!pair_ids[@]}"; do id_is "${pair_ids[$i]}" "${pair_keys[$i]}" "$dest_id" || return 1; done
}
cf_keys_in_dest() {
  local key
  for key in "${CF_KEYS[@]}"; do in_project "$key" "$dest_id" || return 1; done
}
verify_check "the six deploy.yml ids are in $DEST_PROJECT, each under its own key" six_ids_in_dest
verify_check "${CF_KEYS[0]} and ${CF_KEYS[1]} are in $DEST_PROJECT" cf_keys_in_dest

expected_ids=("${pair_ids[@]}")
for key in "${CF_KEYS[@]}"; do expected_ids+=("$(secret_id_of "$key")"); done

read_scoped_token() {
  local session
  # shellcheck source=/dev/null
  . "$BW_HELPER"
  session=$(bitwarden-session) || return 1
  bw sync --session "$session" --nointeraction || return 1
  scoped_token=$(bw get password "$READ_BW_ITEM" --session "$session" --nointeraction) || return 1
  [ -n "$scoped_token" ]
}
scoped_reads_each_by_id() {
  local id
  for id in "${expected_ids[@]}"; do
    [ -n "$id" ] || return 1
    BWS_ACCESS_TOKEN="$scoped_token" bws secret get -o json "$id" > /dev/null || return 1
  done
}
scoped_sees_only_dest() {
  local listing
  listing=$(BWS_ACCESS_TOKEN="$scoped_token" bws secret list -o json) || return 1
  jq -e --arg p "$dest_id" 'length > 0 and all(.[]; .projectId == $p)' > /dev/null <<< "$listing"
}

if [ -z "$READ_BW_ITEM" ]; then
  echo "verify skipped: the $DEST_PROJECT-scoped read (set ATTO_ACTIONS_READ_BW_ITEM to the vault item holding the actions-read token to check it; the deploy run reads through that token too)"
else
  verify_check "the vault item '$READ_BW_ITEM' can be read" read_scoped_token
  if [ -n "$scoped_token" ]; then
    verify_check "the actions-read token reads all ${#expected_ids[@]} keys of $DEST_PROJECT by id" scoped_reads_each_by_id
    verify_check "the actions-read token sees no key outside $DEST_PROJECT" scoped_sees_only_dest
    unset scoped_token
  fi
fi

echo
echo "Results (ids and key names only, no value):"
for key in "${CF_KEYS[@]}"; do echo "  $(secret_id_of "$key") > $key"; done
echo "Next: the owner approves the promotion; deploy.yml reads the six values through sm-action. A later change maps the two ids above too. Then: bash scripts/owner-steps/10.sh --delete-actions-secrets"
[ "$verify_failed" -eq 0 ] || exit 1
