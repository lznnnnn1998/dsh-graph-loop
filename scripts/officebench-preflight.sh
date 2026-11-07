#!/usr/bin/env bash
# OfficeBench probe preflight.
#
# Checks the external benchmark checkout, pinned commit, task files and Docker
# before the 5-task probe. This script does not run the benchmark; it only fails
# loudly when the environment is not ready.
#
# Usage:
#   OFFICEBENCH_DIR=/path/to/OfficeBench bash scripts/officebench-preflight.sh
#
# Pinned version: b978b808667c32b52ce19a67ce1def1de9ae02b7 (2026-03-31).
set -euo pipefail

PINNED_COMMIT="b978b808667c32b52ce19a67ce1def1de9ae02b7"
DIR="${OFFICEBENCH_DIR:-$HOME/OfficeBench}"
TASKS=(1-15 1-16 1-9 1-11 1-19)
failures=0

check() {
  local label="$1"; shift
  if "$@" >/dev/null 2>&1; then
    printf 'ok   %s\n' "$label"
  else
    printf 'FAIL %s\n' "$label"
    failures=$((failures + 1))
  fi
}

printf 'OfficeBench preflight\n'
printf '  dir: %s\n' "$DIR"

check "docker CLI" command -v docker
check "docker daemon" docker info
check "checkout exists" test -d "$DIR"
if [ -d "$DIR/.git" ]; then
  actual="$(git -C "$DIR" rev-parse HEAD 2>/dev/null || true)"
  if [ "$actual" = "$PINNED_COMMIT" ]; then
    printf 'ok   pinned commit\n'
  else
    printf 'FAIL pinned commit (expected %s, got %s)\n' "$PINNED_COMMIT" "${actual:-none}"
    failures=$((failures + 1))
  fi
else
  printf 'FAIL git checkout (%s is not a git repository)\n' "$DIR"
  failures=$((failures + 1))
fi
check "evaluator" test -f "$DIR/evaluation.py"
check "dockerfile" test -f "$DIR/docker/Dockerfile"
for task in "${TASKS[@]}"; do
  check "task $task/subtasks/0.json" test -f "$DIR/tasks/$task/subtasks/0.json"
  check "task $task/testbed" test -d "$DIR/tasks/$task/testbed"
done

echo
if [ "$failures" -ne 0 ]; then
  printf 'NOT READY: %d check(s) failed. See bench/officebench/README.md.\n' "$failures"
  exit 1
fi
printf 'READY: OfficeBench checkout and Docker look usable for the 5-task probe.\n'
