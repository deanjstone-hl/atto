#!/usr/bin/env bash
# The CI gate, run locally before every push to main (argus-config#1176, #1180).
# `pnpm run check` is what workers run and paste the last line of; CI runs this same
# command on every push to main, and Release runs it again on the promoted SHA, so the
# three cannot drift.
#
# Steps, in order:
#   1. bats on scripts/test/deploy-lock.bats (the release scripts are vendored from
#      argus-config, which tests them; scripts/ci/release-scripts-check.sh guards the copy)
#   2. pnpm run lint
#   3. pnpm run build   (tsc -b && vite build: this is the typecheck too)
#   4. pnpm run test    (NODE_ENV=test: a JIT runner job inherits production from the
#                        dispatcher unit, homelab#371, and React drops `act` there)
#
# On success prints one line: `check: pass <short sha>`. Any failure exits non-zero and
# names the failing step.
set -euo pipefail

# The root comes from this script's own path, never the caller's cwd: another repo's
# pre-push gate runs it from its own checkout (atto1#103).
cd "$(dirname "${BASH_SOURCE[0]}")/.."

fail() {
  echo "check: FAIL at step $1 ($2)" >&2
  exit 1
}

echo "check: step 1/4 bats" >&2
# The homelab runners have bats from apt; elsewhere, fetch the same version.
if command -v bats > /dev/null; then
  bats scripts/test/deploy-lock.bats || fail "1/4" "bats"
else
  pnpm dlx bats@1.10.0 scripts/test/deploy-lock.bats || fail "1/4" "bats"
fi

echo "check: step 2/4 pnpm run lint" >&2
pnpm run lint || fail "2/4" "pnpm run lint"

echo "check: step 3/4 pnpm run build" >&2
pnpm run build || fail "3/4" "pnpm run build"

echo "check: step 4/4 pnpm run test" >&2
NODE_ENV=test pnpm run test || fail "4/4" "pnpm run test"

if [ -n "$(git status --porcelain)" ]; then
  echo "check: note: the working tree has uncommitted changes; this result is not for HEAD alone" >&2
fi
echo "check: pass $(git rev-parse --short HEAD)"
