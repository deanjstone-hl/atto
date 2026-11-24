#!/usr/bin/env bash
# Put the promoted collector code and its systemd units live on the homelab (atto/18).
#
# Run by .github/workflows/install-homelab.yml on the homelab runner when `deploy` moves, from
# the runner's checkout of the pushed SHA:
#   bash scripts/install-homelab.sh
# Preview with no change (the pre-flight still runs):
#   bash scripts/install-homelab.sh --dry-run
#
# The collector units (collector/systemd) run collector/*.ts from the checkout ~/repos/atto, not
# from the runner's workspace, so a promotion that changes them is not live until that checkout
# moves and the units are installed. Before atto/18 both were owner steps run by hand after each
# promotion (a `git switch --detach origin/deploy`, scripts/owner-steps/6.sh and 8.sh), and a
# promotion reported success while the homelab kept running the old code.
#
# What it changes (all under $HOME, nothing as root):
#   1. Moves $ATTO1_REPO (default ~/repos/atto) to the promoted SHA, detached, and fails unless
#      its HEAD is that SHA afterwards.
#   2. Links every .service and .timer in collector/systemd into ~/.config/systemd/user, so a
#      unit added to that directory is installed with no per-unit step. Each service but the
#      collector's own gets a copy of the collector's drop-in (the reader's Python and the battery
#      capacity, written once by scripts/owner-steps/77.sh).
#   3. Reloads the user manager and enables every unit that has an [Install] section: timers are
#      enabled and started; the long-running listener is started when it is stopped and restarted
#      when collector code changed, so it runs the promoted code. A one-shot service is never
#      started here: its timer starts it, and a run reads the car.
# A listener that is `failed` is left as it is and reported: BYD can refuse a login, and the owner
# decides when to `reset-failed` (docs/byd-collector.md). It handles no secret, runs no collector,
# never runs promote.sh and never pushes `deploy`. Idempotent.
#
# It starts with scripts/require-deploy-checkout.sh: that takes the per-host deploy lock and
# refuses unless the runner's checkout is exactly what origin/deploy holds, so a run that waited
# behind a newer promotion stops and the newer run installs.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
workspace="$(cd "$here/.." && pwd)"
REPO="${ATTO1_REPO:-$HOME/repos/atto}"
UNIT_DIR="$HOME/.config/systemd/user"
BASE_SERVICE="atto1-collector.service"
COLLECTOR_DROPIN="$UNIT_DIR/$BASE_SERVICE.d/collector.conf"
NODE="$HOME/.local/share/fnm/aliases/default/bin/node"
DRY_RUN=0

case "${1:-}" in
  "") ;;
  --dry-run) DRY_RUN=1 ;;
  *) echo "usage: $0 [--dry-run]" >&2; exit 2 ;;
esac
[ "$#" -le 1 ] || { echo "usage: $0 [--dry-run]" >&2; exit 2; }

# The homelab runner is a system service with no login shell, so it has no XDG_RUNTIME_DIR and
# `systemctl --user` cannot find the user manager. Point it at the manager's socket directory.
if [ -z "${XDG_RUNTIME_DIR:-}" ] && [ -d "/run/user/$(id -u)" ]; then
  export XDG_RUNTIME_DIR="/run/user/$(id -u)"
fi

bash "$here/require-deploy-checkout.sh"
sha="$(git -C "$workspace" rev-parse HEAD)"
units_src="$workspace/collector/systemd"

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

is_checkout() { git -C "$REPO" rev-parse --git-dir; }
is_clean() { [ -z "$(git -C "$REPO" status --porcelain --untracked-files=no)" ]; }
has_units() { compgen -G "$units_src/*.service" || compgen -G "$units_src/*.timer"; }
node_strips_types() {
  "$NODE" -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 18) ? 0 : 1)'
}

preflight_need "$REPO is a git checkout" is_checkout
preflight_need "$REPO has no uncommitted changes to tracked files (a hand edit would be lost or block the switch)" is_clean
preflight_need "$units_src holds units" has_units
preflight_need "the collector's drop-in $COLLECTOR_DROPIN exists (scripts/owner-steps/77.sh installs it)" test -f "$COLLECTOR_DROPIN"
preflight_need "flock is on the PATH (the units take the shared lock with it)" command -v flock
preflight_need "node 22.18 or newer at $NODE (runs collector/*.ts without a build)" node_strips_types
preflight_need "$HOME/.bws_token exists (the units source it for BWS_ACCESS_TOKEN)" test -f "$HOME/.bws_token"
[ "$preflight_failed" -eq 0 ] || { echo "stopping: nothing was changed" >&2; exit 1; }

run() {
  if [ "$DRY_RUN" -eq 1 ]; then echo "[dry-run] $*"; else echo "+ $*"; "$@"; fi
}

previous="$(git -C "$REPO" rev-parse HEAD)"
collector_changed=0
units_changed=0
run git -C "$REPO" fetch --quiet origin deploy
if [ "$DRY_RUN" -eq 0 ]; then
  [ "$(git -C "$REPO" rev-parse origin/deploy)" = "$sha" ] || {
    echo "Refusing to install: origin/deploy moved on from $sha while this run waited. The newer run installs." >&2
    exit 1
  }
  if [ "$previous" != "$sha" ]; then
    # What the promotion changed in the checkout decides what to restart; a first run on an
    # unknown checkout (no common history) counts as a change.
    git -C "$REPO" diff --quiet "$previous" "$sha" -- collector || collector_changed=1
    git -C "$REPO" diff --quiet "$previous" "$sha" -- collector/systemd || units_changed=1
  fi
else
  # A dry run fetches nothing, so it cannot diff the promotion: it reports the restarts as pending.
  collector_changed=1
  units_changed=1
fi
run git -C "$REPO" switch --quiet --detach "$sha"
if [ "$DRY_RUN" -eq 0 ] && [ "$(git -C "$REPO" rev-parse HEAD)" != "$sha" ]; then
  echo "FAILED: $REPO is not at $sha after the switch (HEAD is $(git -C "$REPO" rev-parse HEAD))." >&2
  exit 1
fi

list_units() { find "$units_src" -maxdepth 1 -type f \( -name '*.service' -o -name '*.timer' \) -printf '%f\n' | sort; }
has_install_section() { grep -q '^\[Install\]' "$units_src/$1"; }

run mkdir -p "$UNIT_DIR"
while IFS= read -r unit; do
  run ln -sfn "$REPO/collector/systemd/$unit" "$UNIT_DIR/$unit"
  if [[ "$unit" == *.service && "$unit" != "$BASE_SERVICE" ]]; then
    run mkdir -p "$UNIT_DIR/$unit.d"
    run cp "$COLLECTOR_DROPIN" "$UNIT_DIR/$unit.d/collector.conf"
  fi
done < <(list_units)

if [ "$DRY_RUN" -eq 1 ]; then
  echo "[dry-run] systemctl --user daemon-reload"
else
  echo "+ systemctl --user daemon-reload"
  systemctl --user daemon-reload
fi

while IFS= read -r unit; do
  has_install_section "$unit" || continue
  if [[ "$unit" == *.timer ]]; then
    run systemctl --user enable --now "$unit"
    [ "$units_changed" -eq 0 ] || run systemctl --user restart "$unit"
    continue
  fi
  run systemctl --user enable "$unit"
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "[dry-run] start $unit if stopped, restart it if collector code changed"
    continue
  fi
  state="$(systemctl --user is-active "$unit" || true)"
  case "$state" in
    active)
      if [ "$collector_changed" -eq 1 ]; then run systemctl --user restart "$unit"; fi
      ;;
    inactive)
      run systemctl --user start "$unit"
      ;;
    failed)
      echo "::warning::$unit is failed and was left as it is: BYD may have refused its login. Owner: systemctl --user reset-failed $unit (docs/byd-collector.md)." >&2
      echo "$unit is failed: left as it is" >&2
      ;;
    *)
      echo "$unit is $state: left as it is"
      ;;
  esac
done < <(list_units)

if [ "$DRY_RUN" -eq 0 ]; then
  while IFS= read -r unit; do
    [ "$(readlink -f "$UNIT_DIR/$unit")" = "$(readlink -f "$REPO/collector/systemd/$unit")" ] || {
      echo "FAILED: $UNIT_DIR/$unit does not point at $REPO/collector/systemd/$unit" >&2
      exit 1
    }
    if has_install_section "$unit"; then
      systemctl --user is-enabled "$unit" >/dev/null || { echo "FAILED: $unit is not enabled" >&2; exit 1; }
    fi
  done < <(list_units)
  echo "installed: $REPO is at $sha, $(list_units | wc -l) collector units linked"
fi
