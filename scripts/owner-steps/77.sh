#!/usr/bin/env bash
# Owner steps for atto1/77: install the BYD collector's timer on the host that runs it
# (the homelab). ADR-006, docs/byd-collector.md.
#
# Run on that host, from an approval thread or a terminal, as ONE approved command, with
# the battery capacity in kWh of the ATTO 1 pack (see the car's spec sheet):
#   ATTO1_BATTERY_KWH=30 bash scripts/owner-steps/77.sh
# Preview with no change:
#   ATTO1_BATTERY_KWH=30 bash scripts/owner-steps/77.sh --dry-run
#
# What it changes (all under $HOME, nothing as root):
#   1. Makes ~/.local/share/atto1-collector/venv with uv (~/.local/bin/uv, no ensurepip or
#      python3-venv needed) and installs pybyd==0.0.80 into it. `uv venv --clear` replaces
#      whatever is at that path, so a re-run over a venv a failed run left behind is safe.
#   2. Links the service and timer from ~/repos/atto/collector/systemd into
#      ~/.config/systemd/user, and writes a drop-in with ATTO1_PYTHON and ATTO1_BATTERY_KWH.
#   3. Reloads the user manager and enables atto1-collector.timer (every 30 minutes).
# It handles no secret. Do these first, in the web UIs (docs/byd-collector.md, steps 1-3):
# the Access service token, the four Bitwarden Secrets Manager secrets, and the
# INGEST_* values in wrangler.jsonc promoted to production.
# It does not start a run: step 4 of the runbook does that once, and reads the result.
# Idempotent (a re-run rebuilds the venv). It never runs promote.sh and never pushes `deploy`.
set -euo pipefail

REPO="${ATTO1_REPO:-$HOME/repos/atto}"
VENV="$HOME/.local/share/atto1-collector/venv"
UV="$HOME/.local/bin/uv"
UNIT_DIR="$HOME/.config/systemd/user"
DROPIN_DIR="$UNIT_DIR/atto1-collector.service.d"
NODE="$HOME/.local/share/fnm/aliases/default/bin/node"
DRY_RUN=0

case "${1:-}" in
  "") ;;
  --dry-run) DRY_RUN=1 ;;
  *) echo "usage: ATTO1_BATTERY_KWH=<kWh> $0 [--dry-run]" >&2; exit 2 ;;
esac
[ "$#" -le 1 ] || { echo "usage: ATTO1_BATTERY_KWH=<kWh> $0 [--dry-run]" >&2; exit 2; }

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

at_origin_deploy() {
  [ "$(git -C "$REPO" rev-parse HEAD)" = "$(git -C "$REPO" rev-parse origin/deploy)" ]
}
positive_number() {
  awk -v n="${ATTO1_BATTERY_KWH:-}" 'BEGIN { exit !(n ~ /^[0-9]+(\.[0-9]+)?$/ && n + 0 > 0) }'
}
uv_is_executable() {
  [ -f "$UV" ] && [ -x "$UV" ]
}
uv_can_make_venv() {
  # The real first step, in a scratch dir: python3 -c 'import venv' passes on a host
  # without ensurepip (atto1/95), so make a venv and run its python. Nothing is left behind.
  local scratch exit_code=0
  scratch="$(mktemp -d)" || return 1
  { "$UV" venv --clear "$scratch/venv" && "$scratch/venv/bin/python" -c 'import sys'; } || exit_code=$?
  rm -rf "$scratch"
  return "$exit_code"
}
node_strips_types() {
  "$NODE" -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 18) ? 0 : 1)'
}

preflight_need "ATTO1_BATTERY_KWH is a positive number" positive_number
preflight_need "$REPO is at origin/deploy (symlinks and installs run only from deploy)" at_origin_deploy
preflight_need "node 22.18 or newer at $NODE (runs collector/run.ts without a build)" node_strips_types
preflight_need "uv is executable at $UV (no root needed, unlike python3-venv)" uv_is_executable
preflight_need "uv can make a venv (the real step, in a scratch dir)" uv_can_make_venv
preflight_need "$HOME/.bws_token exists (the unit sources it for BWS_ACCESS_TOKEN)" test -f "$HOME/.bws_token"
preflight_need "bws is on PATH" command -v bws
[ "$preflight_failed" -eq 0 ] || { echo "stopping: nothing was changed" >&2; exit 1; }

run() {
  if [ "$DRY_RUN" -eq 1 ]; then echo "[dry-run] $*"; else echo "+ $*"; "$@"; fi
}

run "$UV" venv --clear "$VENV"
run "$UV" pip install --python "$VENV/bin/python" "pybyd==0.0.80"
run mkdir -p "$UNIT_DIR" "$DROPIN_DIR"
run ln -sfn "$REPO/collector/systemd/atto1-collector.service" "$UNIT_DIR/atto1-collector.service"
run ln -sfn "$REPO/collector/systemd/atto1-collector.timer" "$UNIT_DIR/atto1-collector.timer"

dropin="[Service]
Environment=ATTO1_PYTHON=$VENV/bin/python
Environment=ATTO1_BATTERY_KWH=${ATTO1_BATTERY_KWH}"
if [ "$DRY_RUN" -eq 1 ]; then
  echo "[dry-run] write $DROPIN_DIR/collector.conf:"; echo "$dropin"
else
  printf '%s\n' "$dropin" > "$DROPIN_DIR/collector.conf"
  echo "+ wrote $DROPIN_DIR/collector.conf"
fi

run systemctl --user daemon-reload
run systemctl --user enable --now atto1-collector.timer

if [ "$DRY_RUN" -eq 0 ]; then
  systemctl --user is-enabled atto1-collector.timer
  systemctl --user list-timers atto1-collector.timer --no-pager
fi
