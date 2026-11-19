#!/usr/bin/env bash
# Refuse a manual production deploy unless this checkout is exactly what the deploy
# branch holds (argus-config#519, #603). Production moves by promotion
# (scripts/promote.sh); a manual path ships only what that promotion shipped.
#
#   bash scripts/require-deploy-checkout.sh
#
# Every package.json script that runs a remote `wrangler` write (deploy, d1 migrations
# apply --remote) calls this first. It asks origin
# directly (`git ls-remote`), not a possibly stale local ref, and fails closed:
# no deploy branch, an unreachable origin, a different HEAD or uncommitted changes
# to tracked files all stop the deploy with exit 1.
#
# A rollback (the ops hub's "Roll back" card: a workflow_dispatch of deploy.yml at a release
# tag, argus#1178) sets DEPLOY_ROLLBACK_TAG=vX.Y.Z. `deploy` has moved on from that release,
# so HEAD cannot equal it; the guard instead requires HEAD to be exactly the commit of that
# tag on origin, and that commit to be one `deploy` already held (an ancestor of origin/deploy).
# A rollback still ships only what a promotion shipped, never an unpromoted commit.
set -euo pipefail

REMOTE="${DEPLOY_REMOTE:-origin}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! repo_root="$(git -C "$here" rev-parse --show-toplevel 2> /dev/null)"; then
  echo "Refusing to deploy: $here is not inside a git checkout." >&2
  exit 1
fi

# Per-host deploy lock (argus-config#1156, map #1048). One lock file for every deploy on
# this host, shared by every repo's copy of this guard, so two deploys never run together:
# the homelab runner takes two jobs at once, each `deploy`-push workflow has its own
# concurrency group, and a break-glass deploy.sh is in no group. The guard is a child
# process, so a plain flock would drop when it exits. A small holder keeps the lock until
# the guard's parent (the deploy.sh or script shell, or the shell running a package.json
# chain) exits. A guard call under that same parent, or under a child of it, goes straight
# through. Waits at most ARGUS_DEPLOY_LOCK_WAIT seconds (default 3600), then refuses with
# exit 1. The lock is taken before the checks, so a deploy that waited checks the checkout
# as it is after the deploy ahead of it. A holder gives up after ARGUS_DEPLOY_LOCK_MAX_HOLD
# seconds (default 7200) even if its parent lives. ARGUS_DEPLOY_LOCK=off skips the lock
# (a wedged one; say so in the Resolution). ARGUS_DEPLOY_LOCK_FILE moves the lock file.
lock_file="${ARGUS_DEPLOY_LOCK_FILE:-${XDG_CACHE_HOME:-$HOME/.cache}/argus-deploy.lock}"
lock_wait="${ARGUS_DEPLOY_LOCK_WAIT:-3600}"
lock_max_hold="${ARGUS_DEPLOY_LOCK_MAX_HOLD:-7200}"
lock_owner_file="$lock_file.owner"
lock_holder_pid=""

lock_is_held() { (exec 7>> "$lock_file" && ! flock -n 7); }

# A zombie (exited, not yet reaped by its own parent) is not running a deploy.
owner_is_alive() { kill -0 "$1" 2> /dev/null && [[ "$(ps -o stat= -p "$1" 2> /dev/null)" != Z* ]]; }

# Is $1 this process or one of its ancestors?
is_self_or_ancestor() {
  local pid=$$
  while [[ -n "$pid" && "$pid" -gt 1 ]]; do
    [[ "$pid" == "$1" ]] && return 0
    pid="$(ps -o ppid= -p "$pid" 2> /dev/null | tr -d '[:space:]')"
  done
  return 1
}

describe_lock_owner() {
  local pid started args
  { read -r pid; read -r started; read -r args; } < "$lock_owner_file" 2> /dev/null || true
  if [[ -n "${pid:-}" ]]; then
    echo "pid $pid (${args:-unknown command}), since $(date -d "@${started:-0}" +%H:%M:%S 2> /dev/null || echo unknown)"
  else
    echo "an unknown process"
  fi
}

release_lock_on_failure() {
  local exit_code=$?
  if ((exit_code != 0)) && [[ -n "$lock_holder_pid" ]]; then
    rm -f "$lock_owner_file"
    kill "$lock_holder_pid" 2> /dev/null || true
  fi
}

acquire_deploy_lock() {
  if [[ "${ARGUS_DEPLOY_LOCK:-on}" == off ]]; then
    echo "deploy lock: skipped (ARGUS_DEPLOY_LOCK=off)" >&2
    return 0
  fi
  local name
  for name in lock_wait lock_max_hold; do
    if [[ ! "${!name}" =~ ^[0-9]+$ ]]; then
      echo "Refusing to deploy: ARGUS_DEPLOY_${name^^} must be whole seconds, got '${!name}'." >&2
      exit 1
    fi
  done
  for name in flock ps mktemp; do
    if ! command -v "$name" > /dev/null; then
      echo "Refusing to deploy: the deploy lock needs $name on PATH." >&2
      exit 1
    fi
  done
  mkdir -p "$(dirname "$lock_file")"

  local owner_pid=""
  [[ -r "$lock_owner_file" ]] && owner_pid="$(sed -n 1p "$lock_owner_file")"
  if [[ -n "$owner_pid" ]] && lock_is_held && is_self_or_ancestor "$owner_pid"; then
    return 0
  fi
  if lock_is_held; then
    echo "deploy lock: waiting for the deploy lock held by $(describe_lock_owner) (up to ${lock_wait}s)" >&2
  fi

  local owner=$PPID state_dir waited_from=$SECONDS
  state_dir="$(mktemp -d)"
  (
    exec 9>> "$lock_file"
    if flock -w "$lock_wait" 9; then
      printf '%s\n%s\n%s\n' "$owner" "$(date +%s)" "$(ps -o args= -p "$owner" 2> /dev/null || true)" > "$lock_owner_file.new"
      mv "$lock_owner_file.new" "$lock_owner_file"
      echo held > "$state_dir/result"
      end=$((SECONDS + lock_max_hold))
      while owner_is_alive "$owner" && ((SECONDS < end)); do
        sleep 1 9>&-
      done
      rm -f "$lock_owner_file"
    else
      echo timeout > "$state_dir/result"
    fi
  ) < /dev/null > /dev/null 2>&1 &
  lock_holder_pid=$!
  disown "$lock_holder_pid"

  until [[ -s "$state_dir/result" ]]; do
    if ! kill -0 "$lock_holder_pid" 2> /dev/null && [[ ! -s "$state_dir/result" ]]; then
      echo "Refusing to deploy: the deploy lock holder died before taking $lock_file." >&2
      rm -rf "$state_dir"
      exit 1
    fi
    sleep 0.2
  done
  local result
  result="$(< "$state_dir/result")"
  rm -rf "$state_dir"
  if [[ "$result" != held ]]; then
    lock_holder_pid=""
    echo "Refusing to deploy: another deploy holds $lock_file: $(describe_lock_owner)." >&2
    echo "Waited ${lock_wait}s. Wait for it to finish, or set ARGUS_DEPLOY_LOCK_WAIT higher." >&2
    exit 1
  fi
  trap release_lock_on_failure EXIT
  if ((SECONDS - waited_from > 0)); then
    echo "deploy lock: acquired after $((SECONDS - waited_from))s" >&2
  fi
}

acquire_deploy_lock

listing="$(git -C "$repo_root" ls-remote "$REMOTE" refs/heads/deploy 2> /dev/null || true)"
deploy_sha="${listing%%[[:space:]]*}"
if [[ -z "$deploy_sha" ]]; then
  echo "Refusing to deploy: $REMOTE/deploy does not exist (or $REMOTE is unreachable)." >&2
  echo "Production deploys only from the deploy branch. Promote first: scripts/promote.sh <sha>" >&2
  exit 1
fi

head_sha="$(git -C "$repo_root" rev-parse HEAD)"
rollback_tag="${DEPLOY_ROLLBACK_TAG:-}"
if [[ -n "$rollback_tag" ]]; then
  if [[ ! "$rollback_tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "Refusing to deploy: DEPLOY_ROLLBACK_TAG=$rollback_tag is not a release tag (vX.Y.Z)." >&2
    exit 1
  fi
  # An annotated tag lists twice, the tag object then its peeled commit; the last line is the commit.
  tag_listing="$(git -C "$repo_root" ls-remote "$REMOTE" "refs/tags/$rollback_tag" "refs/tags/$rollback_tag^{}" 2> /dev/null | tail -n 1 || true)"
  tag_sha="${tag_listing%%[[:space:]]*}"
  if [[ -z "$tag_sha" ]]; then
    echo "Refusing to deploy: $REMOTE has no tag $rollback_tag." >&2
    exit 1
  fi
  if [[ "$head_sha" != "$tag_sha" ]]; then
    echo "Refusing to deploy: HEAD is not the commit of tag $rollback_tag ($head_sha, tag at $tag_sha)." >&2
    exit 1
  fi
  if ! git -C "$repo_root" fetch --quiet "$REMOTE" deploy 2> /dev/null; then
    echo "Refusing to deploy: could not fetch $REMOTE/deploy to check that $rollback_tag was promoted." >&2
    exit 1
  fi
  if ! git -C "$repo_root" merge-base --is-ancestor "$head_sha" "$deploy_sha" 2> /dev/null; then
    echo "Refusing to deploy: $rollback_tag ($head_sha) was never promoted: $REMOTE/deploy does not hold it." >&2
    exit 1
  fi
elif [[ "$head_sha" != "$deploy_sha" ]]; then
  echo "Refusing to deploy: HEAD is $head_sha but $REMOTE/deploy is $deploy_sha." >&2
  echo "Promote first (scripts/promote.sh <sha>), then deploy from a checkout of deploy:" >&2
  echo "  git fetch $REMOTE deploy && git switch --detach $REMOTE/deploy" >&2
  exit 1
fi

if [[ -n "$(git -C "$repo_root" status --porcelain --untracked-files=no)" ]]; then
  echo "Refusing to deploy: the checkout has uncommitted changes to tracked files." >&2
  exit 1
fi
