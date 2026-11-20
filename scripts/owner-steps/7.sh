#!/usr/bin/env bash
# Owner steps for atto/7: everything the CarPlay trigger needs before the promotion
# (steps 1 and 2 of docs/carplay-shortcut.md). ADR-006, Amendment 1.
#
# Run on WSL2, from an approval thread or a terminal, as ONE approved command, from a
# checkout at the merged commit:
#   bash scripts/owner-steps/7.sh --dry-run     # read state, print every action, change nothing
#   bash scripts/owner-steps/7.sh
#
# What it changes, and only when the state is not already as wanted (idempotent):
#   1. Adds the Access policy `carplay-trigger` (Service Auth, include the existing service
#      token `atto1-carplay-phone`) to the `atto1.myargus.cc` application, beside `ingest`. It
#      is the whole-hostname application on purpose: each Access application has its own
#      audience tag and the Worker checks the one ACCESS_AUD, so a token issued through a
#      path-specific application would be refused as "wrong audience". The Worker's role check
#      is what limits the phone token to POST /api/collect/trigger.
#   2. Reads that token's Client ID from the Bitwarden item `atto1 CarPlay trigger (Access
#      service token)` (its login username; the password is the Client Secret and is never
#      read) and writes it to the Actions secret ATTO_TRIGGER_CLIENT_ID on deanjstone/atto
#      (`gh secret set`, value on stdin) and to Secrets Manager under the same name, created
#      or edited. deploy.yml stops, changing nothing, on a promotion while the Actions secret
#      is missing. GitHub cannot return an Actions secret's value, so it is set on every run
#      (the same value from the same source, harmless).
#   3. Reads back and prints OK or FAILED for: the policy is on the application and names the
#      token, the Actions secret is listed, the Secrets Manager key exists. No value is shown.
# It never creates, rotates or deletes the service token, and stops if it is missing or its
# Client ID differs from the Bitwarden item's.
#
# It creates one short-lived Cloudflare API token (2 hours; Access apps and policies read
# and write, Access service tokens READ only), minted from CLOUDFLARE-TOKEN-ADMIN the way
# 83.sh does, and revoked with CLOUDFLARE-TOKEN-ADMIN on every exit path. The pre-flight
# reads with CLOUDFLARE-TOKEN-ACCESS, which cannot list Access service tokens (it answers
# success with an empty list, atto1/91), so the token itself is read only in a real run.
# --dry-run mints nothing and writes nothing.
#
# Secrets: read inside this script, never printed, logged or put in a curl or gh argument
# (curl takes its Authorization header from stdin; gh takes the value on stdin). `bws` 2.1.0
# has no stdin form for a value, so the Client ID, an identifier and not a credential, is in
# that one `bws` process's arguments for a moment, as in 83.sh.
# It never runs promote.sh, never pushes `deploy`, never starts a workflow.
set -euo pipefail

API="${CF_API_BASE:-https://api.cloudflare.com/client/v4}"
APP_DOMAIN="atto1.myargus.cc"
TOKEN_NAME="atto1-carplay-phone"
POLICY_NAME="carplay-trigger"
BW_ITEM="atto1 CarPlay trigger (Access service token)"
REPO="${ATTO1_GH_REPO:-deanjstone/atto}"
SECRET_KEY="ATTO_TRIGGER_CLIENT_ID"
PROJECT_NAME="${ATTO1_BWS_PROJECT:-personal-machine-secrets}"
BW_HELPER="${ATTO1_BW_HELPER:-$HOME/repos/argus-config/envs/wsl2/bashrc.d/bitwarden.sh}"

# Cloudflare permission group ids (account scope), from GET /user/tokens/permission_groups.
PG_APPS_WRITE="1e13c5124ca64b72b1969a67e8829049"   # Access: Apps and Policies Write
PG_APPS_READ="7ea222f6d5064cfa89ea366d7c1fee89"    # Access: Apps and Policies Read
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
app_id="" policies_json="" tokens_json=""
token_id="" token_client_id="" policy_id="" client_id=""

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
  for tool in curl jq bws bw gh base64; do command -v "$tool" || return 1; done
}
gh_signed_in() { gh auth status; }
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
discover() {
  local apps
  apps=$(cf "$read_token" GET "$acct_path/access/apps") || return 1
  app_id=$(jq -r --arg d "$APP_DOMAIN" '[.result[]? | select(.domain == $d)][0].id // empty' <<< "$apps")
  [ -n "$app_id" ] || return 1
  policies_json=$(cf "$read_token" GET "$acct_path/access/apps/$app_id/policies") || return 1
  policy_id=$(jq -r --arg n "$POLICY_NAME" '[.result[]? | select(.name == $n)][0].id // empty' <<< "$policies_json")
}
# The Client ID is the login username of the Bitwarden item. The password (the Client Secret)
# is never read.
bitwarden_client_id() {
  local session
  # shellcheck source=/dev/null
  . "$BW_HELPER"
  session=$(bitwarden-session) || return 1
  bw sync --session "$session" --nointeraction || return 1
  client_id=$(bw get username "$BW_ITEM" --session "$session" --nointeraction) || return 1
  [ -n "$client_id" ]
}
# read_phone_token <token>: sets tokens_json, token_id and token_client_id from the service
# tokens that token can see.
read_phone_token() {
  tokens_json=$(cf "$1" GET "$acct_path/access/service_tokens") || return 1
  token_id=$(jq -r --arg n "$TOKEN_NAME" '[.result[]? | select(.name == $n)][0].id // empty' <<< "$tokens_json")
  token_client_id=$(jq -r --arg n "$TOKEN_NAME" '[.result[]? | select(.name == $n)][0].client_id // empty' <<< "$tokens_json")
}
policy_names_token() {
  jq -e --arg n "$POLICY_NAME" --arg t "$token_id" \
    '[.result[]? | select(.name == $n) | .include[]?.service_token.token_id] | index($t) != null' <<< "$policies_json"
}
actions_secret_listed() {
  gh secret list -R "$REPO" --json name | jq -e --arg k "$SECRET_KEY" 'map(.name) | index($k) != null'
}

preflight_need "curl, jq, bws, bw, gh and base64 are installed" have_tools
preflight_need "gh is signed in (it sets the Actions secret on $REPO)" gh_signed_in
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
  preflight_need "$BW_HELPER exists (headless Bitwarden unlock)" test -f "$BW_HELPER"
  preflight_need "$HOME/.bw_master exists" test -f "$HOME/.bw_master"
  if [ "$preflight_failed" -eq 0 ]; then
    preflight_need "the Bitwarden item '$BW_ITEM' has a username (the token's Client ID)" bitwarden_client_id
  fi
fi
[ "$preflight_failed" -eq 0 ] || { echo "stopping: nothing was changed" >&2; exit 1; }

# ---- plan ----------------------------------------------------------------------------------

if [ -z "$policy_id" ]; then
  plan "Access policy $POLICY_NAME (Service Auth, include service token $TOKEN_NAME) on application atto1: add"
else
  echo "Access policy $POLICY_NAME: present on application atto1, left as is"
fi
plan "GitHub Actions secret $SECRET_KEY on $REPO: set from the Bitwarden item's username (its value cannot be read back, so it is set on every run)"
if ! secret_set "$SECRET_KEY"; then
  plan "Secrets Manager $SECRET_KEY: create in project $PROJECT_NAME"
elif [ "$(secret_value "$SECRET_KEY")" != "$client_id" ]; then
  plan "Secrets Manager $SECRET_KEY: exists with another value, edit"
else
  echo "Secrets Manager $SECRET_KEY: already set, left as is"
fi

if [ "$DRY_RUN" -eq 1 ]; then
  plan "a real run first mints a temporary Cloudflare token to read the service token (the read token cannot list them), stops if $TOKEN_NAME is missing or its Client ID is not the Bitwarden item's, and never creates or rotates it"
  plan "verify: the policy is on the application and names the token, the Actions secret is listed, the Secrets Manager key exists"
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

expires=$(date -u -d '+2 hours' +%Y-%m-%dT%H:%M:%SZ)
mint_body=$(jq -cn --arg exp "$expires" --arg a "com.cloudflare.api.account.${account_id}" --arg n "tmp-atto-7-$(date +%s)" \
  --arg aw "$PG_APPS_WRITE" --arg ar "$PG_APPS_READ" --arg tr "$PG_TOKENS_READ" '{
    name: $n, expires_on: $exp,
    policies: [{effect: "allow", resources: {($a): "*"}, permission_groups: [{id: $aw}, {id: $ar}, {id: $tr}]}]}')
minted=$(cf "$admin_token" POST /user/tokens "$mint_body") || die "could not mint the temporary Cloudflare token"
work_token=$(jq -r '.result.value' <<< "$minted")
work_token_id=$(jq -r '.result.id' <<< "$minted")
unset minted
trap revoke EXIT
plan "minted a temporary Cloudflare token for this run (revoked on exit)"

# The read token is blind to service tokens: read the phone token as the minted one.
read_phone_token "$work_token" || die "could not read the service tokens with the temporary token"
[ -n "$token_id" ] || die "the service token $TOKEN_NAME is not in the account; this script never creates it (create it in Zero Trust > Access > Service credentials, store it in the Bitwarden item '$BW_ITEM', and re-run)"
[ "$token_client_id" = "$client_id" ] \
  || die "the Client ID of $TOKEN_NAME does not match the username of the Bitwarden item '$BW_ITEM'; nothing was stored (the item is stale, or it belongs to another token)"
echo "service token $TOKEN_NAME: present, its Client ID matches the Bitwarden item"

if [ -z "$policy_id" ]; then
  response=$(cf "$work_token" POST "$acct_path/access/apps/$app_id/policies" \
    "$(jq -cn --arg n "$POLICY_NAME" --arg t "$token_id" '{name: $n, decision: "non_identity", include: [{service_token: {token_id: $t}}]}')") \
    || die "could not add the $POLICY_NAME policy"
  plan "added Access policy $POLICY_NAME (id $(jq -r '.result.id' <<< "$response")) to application atto1"
else
  policy_names_token || die "the existing $POLICY_NAME policy does not name the $TOKEN_NAME token; delete the policy in Zero Trust and re-run"
fi

# The value goes to gh on stdin, from a process substitution so its exit status is gh's own.
gh secret set "$SECRET_KEY" -R "$REPO" < <(printf '%s' "$client_id") || die "could not set the Actions secret $SECRET_KEY on $REPO"
plan "set GitHub Actions secret $SECRET_KEY on $REPO"

existing_id=$(secret_id "$SECRET_KEY")
if [ -z "$existing_id" ]; then
  bws secret create --note "atto CarPlay trigger (atto/7)" -o none "$SECRET_KEY" "$client_id" "$project_id" || die "could not create Secrets Manager secret $SECRET_KEY"
  plan "wrote Secrets Manager secret $SECRET_KEY"
elif [ "$(secret_value "$SECRET_KEY")" != "$client_id" ]; then
  bws secret edit --value "$client_id" -o none "$existing_id" || die "could not edit Secrets Manager secret $SECRET_KEY"
  plan "wrote Secrets Manager secret $SECRET_KEY"
fi

# ---- verify --------------------------------------------------------------------------------

verify_failed=0
verify_check() {
  # verify_check <description> <test command...>
  local description="$1"; shift
  if "$@" >/dev/null 2>&1; then echo "verify ok: $description"; else echo "verify FAILED: $description" >&2; verify_failed=1; fi
}

secrets=$(bws secret list -o json) || die "could not re-read Secrets Manager"
policies_json=$(cf "$work_token" GET "$acct_path/access/apps/$app_id/policies") || die "could not re-read the policies"
read_phone_token "$work_token" || die "could not re-read the service tokens"

verify_check "the $POLICY_NAME policy is on the atto1 application and names the $TOKEN_NAME token" policy_names_token
verify_check "the Actions secret $SECRET_KEY is listed on $REPO" actions_secret_listed
verify_check "the Secrets Manager key $SECRET_KEY exists" secret_set "$SECRET_KEY"

echo
echo "Next: promote main (the Approve on the ops-hub card), then run scripts/owner-steps/6.sh on the homelab, then build the two Shortcuts (docs/carplay-shortcut.md)."
[ "$verify_failed" -eq 0 ] || exit 1
