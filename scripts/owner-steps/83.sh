#!/usr/bin/env bash
# Owner steps for atto1/83: turn the BYD collector on, steps 1-3 of docs/byd-collector.md
# "Turning it on". ADR-006.
#
# Run on WSL2, from an approval thread or a terminal, as ONE approved command, from a
# checkout at the merged commit:
#   bash scripts/owner-steps/83.sh --dry-run     # read state, print every action, change nothing
#   bash scripts/owner-steps/83.sh
#
# What it changes, and only when the state is not already as wanted (idempotent):
#   1. Creates the Access service token `atto1-ingest` (one year) unless one exists. If one
#      exists but its Client Secret is not in Secrets Manager (the secret is shown once), it
#      rotates that token instead of making a second one.
#   2. Writes `atto1-ingest-client-id` and `atto1-ingest-client-secret` into Bitwarden Secrets
#      Manager, and `atto1-byd-username` / `atto1-byd-password` from the Bitwarden item
#      `atto1 BYD second account`. An existing secret is left as is.
#   3. Adds the Access policy `ingest` (Service Auth, include service token `atto1-ingest`) to
#      the `atto1` application. The owner's Allow policy is not touched.
# It creates one short-lived Cloudflare API token (2 hours, Access service tokens and
# Access apps and policies only), minted from CLOUDFLARE-TOKEN-ADMIN the way
# homelab's cf-expose.sh does, and revoked with CLOUDFLARE-TOKEN-ADMIN on every exit path
# (a token cannot revoke itself). The pre-flight reads with CLOUDFLARE-TOKEN-ACCESS, which
# cannot list Access service tokens: it answers success with an empty list (atto1/91). The
# pre-flight therefore fails when that list is empty but a policy names a token, and a real
# run re-reads the service tokens, and does its verify, with the minted token, which can.
# --dry-run mints nothing.
#
# Secrets: read inside this script from Secrets Manager and Bitwarden, never printed, logged
# or put in a curl argument (curl takes its Authorization header from stdin). `bws` 2.1.0
# has no stdin form for a value, so a value being stored is in that one `bws` process's
# arguments for a moment, visible only to this user on this host. If a secret cannot be
# stored the token just created is deleted, so a re-run starts clean.
# It prints only non-secret results: the token's Client ID, ids it created, the owner's
# Access user id. It never runs promote.sh, never pushes `deploy`, never starts a workflow.
set -euo pipefail

API="${CF_API_BASE:-https://api.cloudflare.com/client/v4}"
APP_DOMAIN="atto1.myargus.cc"
TOKEN_NAME="atto1-ingest"
TOKEN_DURATION="8760h"
POLICY_NAME="ingest"
BW_ITEM="atto1 BYD second account"
PROJECT_NAME="${ATTO1_BWS_PROJECT:-personal-machine-secrets}"
BW_HELPER="${ATTO1_BW_HELPER:-$HOME/repos/argus-config/envs/wsl2/bashrc.d/bitwarden.sh}"
VERIFY_WAIT="${ATTO1_VERIFY_WAIT:-5}"
KEY_ID="atto1-ingest-client-id"
KEY_SECRET="atto1-ingest-client-secret"
KEY_USER="atto1-byd-username"
KEY_PASSWORD="atto1-byd-password"

# Cloudflare permission group ids (account scope), from GET /user/tokens/permission_groups.
PG_APPS_WRITE="1e13c5124ca64b72b1969a67e8829049"   # Access: Apps and Policies Write
PG_APPS_READ="7ea222f6d5064cfa89ea366d7c1fee89"    # Access: Apps and Policies Read
PG_TOKENS_WRITE="a1c0fec57cf94af79479a6d827fa518c" # Access: Service Tokens Write
PG_TOKENS_READ="91f7ce32fa614d73b7e1fc8f0e78582b"  # Access: Service Tokens Read

DRY_RUN=0
case "${1:-}" in
  "") ;;
  --dry-run) DRY_RUN=1 ;;
  *) echo "usage: $0 [--dry-run]" >&2; exit 2 ;;
esac
[ "$#" -le 1 ] || { echo "usage: $0 [--dry-run]" >&2; exit 2; }

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
warn() { printf 'warning: %s\n' "$*" >&2; }
plan() { if [ "$DRY_RUN" -eq 1 ]; then echo "[dry-run] $*"; else echo "+ $*"; fi; }

secrets="" project_id="" account_id="" acct_path=""
admin_token="" read_token="" work_token="" work_token_id=""
app_id="" policies_json="" tokens_json="" users_json='{"result":[]}'
token_id="" token_client_id="" policy_id="" byd_user="" byd_password=""

# cf <token> <METHOD> <path> [json-body]: prints the response, returns 1 unless success is
# true. The token goes to curl on stdin, not argv.
cf() {
  local token="$1" method="$2" path="$3" body="${4:-}" response
  local -a args=(-sS -K - -X "$method" "${API}${path}")
  if [ -n "$body" ]; then args+=(-H "Content-Type: application/json" -d "$body"); fi
  response=$(curl "${args[@]}" <<< "header = \"Authorization: Bearer ${token}\"") || return 1
  if [ "$(jq -r '.success' <<< "$response")" != "true" ]; then
    printf 'cloudflare: %s %s failed: %s\n' "$method" "$path" "$(jq -c '[.errors[]?.message]' <<< "$response")" >&2
    return 1
  fi
  printf '%s' "$response"
}

secret_value() { jq -r --arg k "$1" '[.[] | select(.key == $k)][0].value // empty' <<< "$secrets"; }
secret_id() { jq -r --arg k "$1" '[.[] | select(.key == $k)][0].id // empty' <<< "$secrets"; }
secret_set() { [ -n "$(secret_id "$1")" ]; }

# ---- pre-flight: read-only, also under --dry-run -------------------------------------------

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

have_tools() {
  local tool
  for tool in curl jq bws bw base64; do command -v "$tool" || return 1; done
}
load_secrets() {
  # The file is a bare BWS_ACCESS_TOKEN=... line: export it for the bws processes below.
  set -a; . "$HOME/.bws_token"; set +a
  secrets=$(bws secret list -o json) || return 1
  jq -e 'type == "array"' <<< "$secrets"
}
have_cloudflare_secrets() {
  local blob
  admin_token=$(secret_value CLOUDFLARE-TOKEN-ADMIN)
  read_token=$(secret_value CLOUDFLARE-TOKEN-ACCESS)
  blob=$(secret_value homelab-cloudflared-tunnel-token)
  [ -n "$admin_token" ] && [ -n "$read_token" ] && [ -n "$blob" ] || return 1
  account_id=$(base64 -d <<< "$blob" | jq -r '.a // empty') || return 1
  [ -n "$account_id" ] || return 1
  acct_path="/accounts/$account_id"
}
resolve_project() {
  local listing
  listing=$(bws project list -o json) || return 1
  project_id=$(jq -r --arg n "$PROJECT_NAME" '[.[] | select(.name == $n)][0].id // empty' <<< "$listing")
  [ -n "$project_id" ]
}
# read_service_tokens <token>: sets tokens_json, token_id and token_client_id from the
# service tokens that token can see.
read_service_tokens() {
  tokens_json=$(cf "$1" GET "$acct_path/access/service_tokens") || return 1
  token_id=$(jq -r --arg n "$TOKEN_NAME" '[.result[]? | select(.name == $n)][0].id // empty' <<< "$tokens_json")
  token_client_id=$(jq -r --arg n "$TOKEN_NAME" '[.result[]? | select(.name == $n)][0].client_id // empty' <<< "$tokens_json")
}
discover() {
  local apps
  apps=$(cf "$read_token" GET "$acct_path/access/apps") || return 1
  app_id=$(jq -r --arg d "$APP_DOMAIN" '[.result[]? | select(.domain == $d)][0].id // empty' <<< "$apps")
  [ -n "$app_id" ] || return 1
  policies_json=$(cf "$read_token" GET "$acct_path/access/apps/$app_id/policies") || return 1
  read_service_tokens "$read_token" || return 1
  users_json=$(cf "$read_token" GET "$acct_path/access/users") || users_json='{"result":[]}'
  policy_id=$(jq -r --arg n "$POLICY_NAME" '[.result[]? | select(.name == $n)][0].id // empty' <<< "$policies_json")
}
# A policy names a service token, so the account has at least one: an empty list means the
# token that read it cannot list them, not that there are none.
service_tokens_listable() {
  jq -e '(.result // []) | length > 0' > /dev/null <<< "$tokens_json" && return 0
  ! jq -e '[.result[]? | .include[]?.service_token.token_id | select(. != null)] | length > 0' > /dev/null <<< "$policies_json"
}
policy_consistent() {
  [ -z "$policy_id" ] && return 0
  [ -n "$token_id" ] || return 1
  policy_includes_token "$policies_json" "$token_id"
}
policy_includes_token() {
  jq -e --arg n "$POLICY_NAME" --arg t "$2" \
    '[.result[]? | select(.name == $n) | .include[]?.service_token.token_id] | index($t) != null' <<< "$1"
}
byd_item_readable() {
  local session
  # shellcheck source=/dev/null
  . "$BW_HELPER"
  session=$(bitwarden-session) || return 1
  bw sync --session "$session" --nointeraction || return 1
  byd_user=$(bw get username "$BW_ITEM" --session "$session" --nointeraction) || return 1
  byd_password=$(bw get password "$BW_ITEM" --session "$session" --nointeraction) || return 1
  [ -n "$byd_user" ] && [ -n "$byd_password" ]
}

preflight_need "curl, jq, bws, bw and base64 are installed" have_tools
preflight_need "$HOME/.bws_token exists (Secrets Manager access)" test -f "$HOME/.bws_token"
if [ "$preflight_failed" -eq 0 ]; then
  preflight_need "Secrets Manager answers (bws secret list)" load_secrets
fi
if [ "$preflight_failed" -eq 0 ]; then
  preflight_need "Secrets Manager holds CLOUDFLARE-TOKEN-ADMIN, CLOUDFLARE-TOKEN-ACCESS and homelab-cloudflared-tunnel-token" have_cloudflare_secrets
  preflight_need "Secrets Manager project $PROJECT_NAME exists" resolve_project
fi
if [ "$preflight_failed" -eq 0 ]; then
  preflight_need "the Access application $APP_DOMAIN is readable" discover
  if service_tokens_listable; then
    preflight_need "an existing $POLICY_NAME policy names the $TOKEN_NAME token (else delete it in Zero Trust and re-run)" policy_consistent
  else
    preflight_need "CLOUDFLARE-TOKEN-ACCESS cannot list Access service tokens: the list is empty but a policy on $APP_DOMAIN names a token, so \"$TOKEN_NAME absent\" cannot be trusted (grant that token Access: Service Tokens Read, then re-run)" false
  fi
  if ! secret_set "$KEY_USER" || ! secret_set "$KEY_PASSWORD"; then
    preflight_need "$BW_HELPER exists (headless Bitwarden unlock)" test -f "$BW_HELPER"
    preflight_need "$HOME/.bw_master exists" test -f "$HOME/.bw_master"
    if [ "$preflight_failed" -eq 0 ]; then
      preflight_need "the Bitwarden item '$BW_ITEM' has a username and a password" byd_item_readable
    fi
  fi
fi
[ "$preflight_failed" -eq 0 ] || { echo "stopping: nothing was changed" >&2; exit 1; }

# ---- plan ----------------------------------------------------------------------------------

action_token="none"
if [ -z "$token_id" ]; then
  action_token="create"
elif ! secret_set "$KEY_ID" || ! secret_set "$KEY_SECRET"; then
  action_token="rotate"
fi

need_write=0
case "$action_token" in
  create) plan "service token $TOKEN_NAME: absent, would create (valid $TOKEN_DURATION)"; need_write=1 ;;
  rotate) plan "service token $TOKEN_NAME: exists but its Client Secret is not in Secrets Manager, would rotate it"; need_write=1 ;;
  none) echo "service token $TOKEN_NAME: exists and its secrets are stored" ;;
esac
for key in "$KEY_ID" "$KEY_SECRET"; do
  if [ "$action_token" = none ]; then echo "Secrets Manager $key: already set, left as is"
  else plan "Secrets Manager $key: write to project $PROJECT_NAME"; fi
done
for key in "$KEY_USER" "$KEY_PASSWORD"; do
  if secret_set "$key"; then echo "Secrets Manager $key: already set, left as is"
  else plan "Secrets Manager $key: write to project $PROJECT_NAME from the Bitwarden item '$BW_ITEM'"; need_write=1; fi
done
if [ -z "$policy_id" ]; then
  plan "Access policy $POLICY_NAME (Service Auth, include service token $TOKEN_NAME) on application atto1: add"
  need_write=1
else
  echo "Access policy $POLICY_NAME: present on application atto1, left as is"
fi
[ "$need_write" -eq 1 ] || echo "nothing to change"

owner_email=$(jq -r '[.result[]? | select(.decision == "allow") | .include[]?.email.email][0] // empty' <<< "$policies_json")
owner_uid=$(jq -r --arg e "$owner_email" '[.result[]? | select(.email == $e)][0].uid // empty' <<< "$users_json")

if [ "$DRY_RUN" -eq 1 ]; then
  plan "service token presence above is read with CLOUDFLARE-TOKEN-ACCESS, which cannot list them; a real run re-reads them with its temporary token before it creates or rotates anything"
  plan "verify: token and policy present, the four secrets stored with a matching Client ID, an unauthenticated request to https://$APP_DOMAIN/api/me goes to the Access login, a request with the service token does not"
  exit 0
fi

# ---- changes -------------------------------------------------------------------------------

revoke() {
  [ -n "$work_token_id" ] || return 0
  local id="$work_token_id"
  work_token_id=""
  cf "$admin_token" DELETE "/user/tokens/$id" > /dev/null \
    || warn "could not revoke the temporary Cloudflare token $id; it expires $expires, or revoke it in the Cloudflare dashboard (My Profile > API Tokens)"
  unset admin_token
}

store_secret() {
  # store_secret <key> <value>: edit it if it exists with another value, create it if not.
  # Callers use it in an `if`, where set -e is off, so every failure returns explicitly.
  local key="$1" value="$2" id
  id=$(secret_id "$key")
  if [ -n "$id" ]; then
    [ "$(secret_value "$key")" = "$value" ] && return 0
    bws secret edit --value "$value" -o none "$id" || return 1
  else
    bws secret create --note "atto1 BYD collector (atto1/83)" -o none "$key" "$value" "$project_id" || return 1
  fi
  plan "wrote Secrets Manager secret $key"
}

if [ "$need_write" -eq 1 ]; then
  expires=$(date -u -d '+2 hours' +%Y-%m-%dT%H:%M:%SZ)
  mint_body=$(jq -cn --arg exp "$expires" --arg a "com.cloudflare.api.account.${account_id}" --arg n "tmp-atto1-83-$(date +%s)" \
    --arg aw "$PG_APPS_WRITE" --arg ar "$PG_APPS_READ" --arg tw "$PG_TOKENS_WRITE" --arg tr "$PG_TOKENS_READ" '{
      name: $n, expires_on: $exp,
      policies: [{effect: "allow", resources: {($a): "*"}, permission_groups: [{id: $aw}, {id: $ar}, {id: $tw}, {id: $tr}]}]}')
  minted=$(cf "$admin_token" POST /user/tokens "$mint_body") || die "could not mint the temporary Cloudflare token"
  work_token=$(jq -r '.result.value' <<< "$minted")
  work_token_id=$(jq -r '.result.id' <<< "$minted")
  unset minted
  trap revoke EXIT
  plan "minted a temporary Cloudflare token for this run (revoked on exit)"

  # The read token may have been blind to the service tokens: read them again as the minted
  # token, which can list them, and plan from that, so an existing token is rotated, not duplicated.
  planned_action="$action_token"
  read_service_tokens "$work_token" || die "could not read the service tokens with the temporary token"
  if [ -z "$token_id" ]; then
    action_token="create"
  elif ! secret_set "$KEY_ID" || ! secret_set "$KEY_SECRET"; then
    action_token="rotate"
  else
    action_token="none"
  fi
  if [ "$action_token" != "$planned_action" ]; then
    seen="absent"; [ -z "$token_id" ] || seen="present (id $token_id)"
    plan "re-read with the temporary token: service token $TOKEN_NAME is $seen, so $action_token, not $planned_action"
  fi
  policy_consistent || die "the $POLICY_NAME policy names a service token that is not in the account; delete the policy in Zero Trust and re-run"

  if [ "$action_token" != none ]; then
    if [ "$action_token" = create ]; then
      response=$(cf "$work_token" POST "$acct_path/access/service_tokens" \
        "$(jq -cn --arg n "$TOKEN_NAME" --arg d "$TOKEN_DURATION" '{name: $n, duration: $d}')") || die "could not create the service token"
      token_id=$(jq -r '.result.id' <<< "$response")
      plan "created service token $TOKEN_NAME (id $token_id)"
    else
      response=$(cf "$work_token" POST "$acct_path/access/service_tokens/$token_id/rotate") || die "could not rotate the service token"
      plan "rotated service token $TOKEN_NAME (id $token_id)"
    fi
    token_client_id=$(jq -r '.result.client_id' <<< "$response")
    client_secret=$(jq -r '.result.client_secret' <<< "$response")
    unset response
    if ! store_secret "$KEY_ID" "$token_client_id" || ! store_secret "$KEY_SECRET" "$client_secret"; then
      unset client_secret
      if [ "$action_token" = create ]; then
        cf "$work_token" DELETE "$acct_path/access/service_tokens/$token_id" > /dev/null \
          || warn "could not delete the service token $token_id; delete it in Zero Trust before re-running"
        die "could not store the Client ID and Secret; deleted the service token just created, so a re-run starts clean"
      fi
      die "could not store the rotated Client Secret; re-run to rotate again"
    fi
    unset client_secret
  fi

  if ! secret_set "$KEY_USER" || ! secret_set "$KEY_PASSWORD"; then
    store_secret "$KEY_USER" "$byd_user" || die "could not store $KEY_USER"
    store_secret "$KEY_PASSWORD" "$byd_password" || die "could not store $KEY_PASSWORD"
    unset byd_user byd_password
  fi

  if [ -z "$policy_id" ]; then
    response=$(cf "$work_token" POST "$acct_path/access/apps/$app_id/policies" \
      "$(jq -cn --arg n "$POLICY_NAME" --arg t "$token_id" '{name: $n, decision: "non_identity", include: [{service_token: {token_id: $t}}]}')") \
      || die "could not add the $POLICY_NAME policy"
    plan "added Access policy $POLICY_NAME (id $(jq -r '.result.id' <<< "$response")) to application atto1"
  fi
fi

# ---- verify --------------------------------------------------------------------------------

verify_failed=0
verify_check() {
  # verify_check <description> <test command...>
  local description="$1"; shift
  if "$@" >/dev/null 2>&1; then echo "verify ok: $description"; else echo "verify FAILED: $description" >&2; verify_failed=1; fi
}

secrets=$(bws secret list -o json) || die "could not re-read Secrets Manager"
# The minted token can list service tokens; the read token cannot (atto1/91). With no minted
# token nothing was written, the pre-flight already read the list, and the read token saw it.
verify_token="${work_token:-$read_token}"
read_service_tokens "$verify_token" || die "could not re-read the service tokens"
policies_json=$(cf "$verify_token" GET "$acct_path/access/apps/$app_id/policies") || die "could not re-read the policies"

all_secrets_set() { secret_set "$KEY_ID" && secret_set "$KEY_SECRET" && secret_set "$KEY_USER" && secret_set "$KEY_PASSWORD"; }
stored_client_id_matches() { [ -n "$token_client_id" ] && [ "$(secret_value "$KEY_ID")" = "$token_client_id" ]; }
policy_names_token() { [ -n "$token_id" ] && policy_includes_token "$policies_json" "$token_id"; }
unauthenticated_goes_to_login() {
  local result
  result=$(curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' "https://$APP_DOMAIN/api/me") || return 1
  [[ "$result" == 302\ https://*cloudflareaccess.com* ]]
}
service_token_passes_access() {
  # Access policy changes can take a few seconds to reach the edge: retry while it still redirects.
  local attempt code
  for attempt in 1 2 3 4 5 6; do
    code=$(curl -sS -o /dev/null -w '%{http_code}' -K - "https://$APP_DOMAIN/api/me" <<< "header = \"CF-Access-Client-Id: $(secret_value "$KEY_ID")\"
header = \"CF-Access-Client-Secret: $(secret_value "$KEY_SECRET")\"") || return 1
    [ "$code" != 302 ] && [ "$code" != 000 ] && return 0
    sleep "$VERIFY_WAIT"
  done
  return 1
}

verify_check "service token $TOKEN_NAME exists" test -n "$token_id"
verify_check "the four secrets are in Secrets Manager" all_secrets_set
verify_check "the stored Client ID is the token's Client ID" stored_client_id_matches
verify_check "the $POLICY_NAME policy includes the $TOKEN_NAME token" policy_names_token
verify_check "an unauthenticated request to https://$APP_DOMAIN/api/me goes to the Access login" unauthenticated_goes_to_login
verify_check "a request with the service token is not sent to the Access login (the Worker still refuses it until INGEST_* are promoted)" service_token_passes_access

echo
echo "Results (none is a secret):"
echo "  service token $TOKEN_NAME: id $token_id, Client ID $token_client_id"
echo "  owner's Access user id (expected INGEST_OWNER_SUBJECT; the Worker's /api/me subject confirms it): ${owner_uid:-not found}"
echo "Next: a worker puts the Client ID and that user id into wrangler.jsonc INGEST_CLIENT_ID / INGEST_OWNER_SUBJECT in a PR (atto1/83); the promotion Approve then makes them live."
[ "$verify_failed" -eq 0 ] || exit 1
