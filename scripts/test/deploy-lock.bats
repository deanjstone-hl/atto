#!/usr/bin/env bats
# The per-host deploy lock in scripts/require-deploy-checkout.sh (argus-config#1156, map
# #1048). Every repo's copy of the guard takes one lock file per host before its checks, so
# two deploys on a host never run together. The guard is a child process, so a small holder
# keeps the lock until the guard's parent exits.
# Run: bats scripts/test/deploy-lock.bats

REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd -P)"

setup() {
  export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.invalid
  export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.invalid
  export GIT_CONFIG_NOSYSTEM=1
  unset GITHUB_ACTIONS
  WORK="$BATS_TEST_TMPDIR"
  export ARGUS_DEPLOY_LOCK_FILE="$WORK/argus-deploy.lock"
  CHECKOUT="$WORK/checkout"
  mkdir -p "$CHECKOUT/scripts"
  git init -q -b main "$CHECKOUT"
  cp "$REPO_ROOT/scripts/require-deploy-checkout.sh" "$CHECKOUT/scripts/"
  git -C "$CHECKOUT" add scripts
  git -C "$CHECKOUT" commit -q -m guard
  git init -q --bare -b main "$WORK/origin.git"
  git -C "$CHECKOUT" remote add origin "$WORK/origin.git"
  git -C "$CHECKOUT" push -q origin HEAD:main HEAD:deploy
  GUARD="$CHECKOUT/scripts/require-deploy-checkout.sh"
  OWNER_PID=""
}

teardown() {
  [[ -z "$OWNER_PID" ]] || kill "$OWNER_PID" 2> /dev/null || true
}

# start_owner SECONDS: a deploy that passes the guard, then keeps running. Returns once the
# guard has passed, so the lock is held.
start_owner() {
  rm -f "$WORK/owner-passed"
  bash -c 'bash "$1" && touch "$2" && sleep "$3"' _ "$GUARD" "$WORK/owner-passed" "$1" > /dev/null 2>&1 &
  OWNER_PID=$!
  local deadline=$((SECONDS + 15))
  until [[ -e "$WORK/owner-passed" ]]; do
    [[ "$SECONDS" -lt "$deadline" ]] || return 1
    sleep 0.05
  done
}

lock_is_free() {
  local deadline=$((SECONDS + 10))
  until flock -n "$ARGUS_DEPLOY_LOCK_FILE" true 2> /dev/null; do
    [[ "$SECONDS" -lt "$deadline" ]] || return 1
    sleep 0.1
  done
}

@test "a lone guard passes and frees the lock once its parent exits" {
  run bash "$GUARD"
  [ "$status" -eq 0 ]
  lock_is_free
}

@test "a second deploy is refused with a clear error when the lock is held past the wait" {
  start_owner 30
  ARGUS_DEPLOY_LOCK_WAIT=1 run bash "$GUARD"
  [ "$status" -eq 1 ]
  [[ "$output" == *"another deploy holds"* ]]
  [[ "$output" == *"pid $OWNER_PID"* ]]
  [[ "$output" == *"1s"* ]]
}

@test "a second deploy waits for the holder, then goes through" {
  start_owner 2
  local start=$SECONDS
  ARGUS_DEPLOY_LOCK_WAIT=20 run bash "$GUARD"
  [ "$status" -eq 0 ]
  [ $((SECONDS - start)) -ge 1 ]
  [[ "$output" == *"waiting for the deploy lock"* ]]
}

@test "the lock is released when the holder's parent is killed" {
  start_owner 60
  kill "$OWNER_PID"
  ARGUS_DEPLOY_LOCK_WAIT=10 run bash "$GUARD"
  [ "$status" -eq 0 ]
}

@test "two guard calls under one parent do not wait on themselves" {
  run timeout 20 bash -c 'bash "$1" && bash "$1"' _ "$GUARD"
  [ "$status" -eq 0 ]
}

@test "a child of the holder's parent goes straight through" {
  printf '#!/usr/bin/env bash\nbash "$1"\n' > "$WORK/child.sh"
  ARGUS_DEPLOY_LOCK_WAIT=2 run timeout 20 bash -c 'bash "$1" && bash "$2" "$1"' _ "$GUARD" "$WORK/child.sh"
  [ "$status" -eq 0 ]
}

@test "a refused guard frees the lock at once" {
  git -C "$CHECKOUT" commit -q --allow-empty -m unpromoted
  run bash "$GUARD"
  [ "$status" -eq 1 ]
  [[ "$output" == *"Refusing"* ]]
  lock_is_free
}

@test "the lock is taken before the checks, so a stale HEAD waits instead of racing a deploy" {
  start_owner 30
  git -C "$CHECKOUT" commit -q --allow-empty -m unpromoted
  ARGUS_DEPLOY_LOCK_WAIT=1 run bash "$GUARD"
  [ "$status" -eq 1 ]
  [[ "$output" == *"another deploy holds"* ]]
}

@test "ARGUS_DEPLOY_LOCK=off skips the lock and says so" {
  start_owner 30
  ARGUS_DEPLOY_LOCK=off run bash "$GUARD"
  [ "$status" -eq 0 ]
  [[ "$output" == *"ARGUS_DEPLOY_LOCK=off"* ]]
}

@test "a non-numeric wait is refused" {
  ARGUS_DEPLOY_LOCK_WAIT=soon run bash "$GUARD"
  [ "$status" -eq 1 ]
  [[ "$output" == *"ARGUS_DEPLOY_LOCK_WAIT"* ]]
}

@test "the holder does not keep the caller's pipe open" {
  run timeout 10 bash -c 'bash "$1" 2>&1 | cat' _ "$GUARD"
  [ "$status" -eq 0 ]
}

@test "a host without flock is refused with a clear error, not a false wait" {
  local lean="$WORK/lean" tool
  mkdir -p "$lean"
  for tool in bash env dirname mkdir git id ps tr sed date mktemp mv rm sleep cat head; do
    ln -s "$(command -v "$tool")" "$lean/$tool"
  done
  PATH="$lean" run bash "$GUARD"
  [ "$status" -eq 1 ]
  [[ "$output" == *"needs flock"* ]]
}
