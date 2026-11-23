#!/usr/bin/env bash
# Owner steps for atto/8: install the BYD push listener on the host that runs the BYD
# collector (the homelab), so the collector runs when the car starts or stops charging.
# docs/byd-collector.md, ADR-006 Amendment 2.
#
# Run on that host, from an approval thread or a terminal, as ONE approved command, after
# the promotion that carries atto/8 (the Worker must accept the charge tags first) and after
# scripts/owner-steps/77.sh has installed the collector:
#   bash scripts/owner-steps/8.sh
# Preview with no change:
#   bash scripts/owner-steps/8.sh --dry-run
#
# What it changes (all under $HOME, nothing as root):
#   1. Links atto1-collector-push.service from ~/repos/atto/collector/systemd into
#      ~/.config/systemd/user.
#   2. Copies the collector's drop-in (the reader's Python and the battery capacity, written
#      by 77.sh) to atto1-collector-push.service.d/collector.conf, so the listener signs in with
#      the same venv and a triggered run reads the car exactly as a timer run does.
#   3. Reloads the user manager and enables and starts atto1-collector-push.service. It signs in
#      to BYD as the second account and holds one push connection; it reads the car only when a
#      charge starts or stops, and never twice in two minutes.
# It handles no secret. It does not run the collector. Idempotent. It never runs promote.sh
# and never pushes `deploy`.
set -euo pipefail

REPO="${ATTO1_REPO:-$HOME/repos/atto}"
UNIT_DIR="$HOME/.config/systemd/user"
COLLECTOR_DROPIN="$UNIT_DIR/atto1-collector.service.d/collector.conf"
PUSH_DROPIN_DIR="$UNIT_DIR/atto1-collector-push.service.d"
NODE="$HOME/.local/share/fnm/aliases/default/bin/node"
DRY_RUN=0

case "${1:-}" in
  "") ;;
  --dry-run) DRY_RUN=1 ;;
  *) echo "usage: $0 [--dry-run]" >&2; exit 2 ;;
esac
[ "$#" -le 1 ] || { echo "usage: $0 [--dry-run]" >&2; exit 2; }

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
holds_push_files() {
  [ -f "$REPO/collector/systemd/atto1-collector-push.service" ] && [ -f "$REPO/collector/push.ts" ] && [ -f "$REPO/collector/listen-byd.py" ]
}
node_strips_types() {
  "$NODE" -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 18) ? 0 : 1)'
}

preflight_need "$REPO is at origin/deploy (symlinks and installs run only from deploy)" at_origin_deploy
preflight_need "$REPO holds collector/systemd/atto1-collector-push.service, push.ts and listen-byd.py (promote atto/8 first)" holds_push_files
preflight_need "the collector's drop-in $COLLECTOR_DROPIN exists (scripts/owner-steps/77.sh installs it)" test -f "$COLLECTOR_DROPIN"
preflight_need "flock is on the PATH (push.ts takes the shared lock around each run with it)" command -v flock
preflight_need "node 22.18 or newer at $NODE (runs collector/push.ts without a build)" node_strips_types
preflight_need "$HOME/.bws_token exists (the unit sources it for BWS_ACCESS_TOKEN)" test -f "$HOME/.bws_token"
[ "$preflight_failed" -eq 0 ] || { echo "stopping: nothing was changed" >&2; exit 1; }

run() {
  if [ "$DRY_RUN" -eq 1 ]; then echo "[dry-run] $*"; else echo "+ $*"; "$@"; fi
}

run mkdir -p "$UNIT_DIR" "$PUSH_DROPIN_DIR"
run ln -sfn "$REPO/collector/systemd/atto1-collector-push.service" "$UNIT_DIR/atto1-collector-push.service"
run cp "$COLLECTOR_DROPIN" "$PUSH_DROPIN_DIR/collector.conf"
run systemctl --user daemon-reload
run systemctl --user enable --now atto1-collector-push.service

if [ "$DRY_RUN" -eq 0 ]; then
  systemctl --user is-enabled atto1-collector-push.service
  systemctl --user is-active atto1-collector-push.service
fi
