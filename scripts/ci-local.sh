#!/usr/bin/env bash
# Local release gate — the same commands a CI provider would run, with no
# external services, network installs, Docker or model calls.
#
#   bash scripts/ci-local.sh               # cheap gate; bench check runs only if bench/ exists
#   bash scripts/ci-local.sh --with-bench  # require the local benchmark network check
#   bash scripts/ci-local.sh --no-bench    # skip benchmark checks
#   WITH_BENCH=1 bash scripts/ci-local.sh  # same as --with-bench
#
# Steps:
#   1. typecheck (tsc --noEmit over packages/** + test/**)
#   2. unit tests  (node --test, no model)
#   3. bundle build (packages/*/lib)
#   4. reproducibility check (fresh build byte-equals packages/*/lib)
#   5. benchmark network config (offline; bench/ is local-only, so this step is
#      skipped with a notice on a fresh checkout)
#   6. fork surface guard (diff-upstream.sh --check; skips without a DSH checkout)
#
# Exit code 0 only when every step passes. Keep it dependency-free so any
# runner can execute it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# bench/ is local-only and never published. Run its offline check when the local
# tree exists, skip it on a fresh checkout; --with-bench / WITH_BENCH=1 makes the
# step required (fails clearly when the tree is absent).
BENCH_REQUEST=0
for arg in "$@"; do
  case "$arg" in
    --with-bench) BENCH_REQUEST=1 ;;
    --no-bench) BENCH_REQUEST=-1 ;;
    -h|--help)
      sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *)
      echo "ci-local: unknown argument: $arg (try --help)" >&2
      exit 2 ;;
  esac
done
if [ "${WITH_BENCH:-0}" = 1 ]; then BENCH_REQUEST=1; fi
BENCH_TREE="$ROOT/bench/official/terminal-bench"
if [ "$BENCH_REQUEST" -gt 0 ]; then
  [ -d "$BENCH_TREE" ] || {
    echo 'ci-local: --with-bench requested but bench/ is absent (local-only tree)' >&2
    exit 1
  }
  WANT_BENCH=1
elif [ "$BENCH_REQUEST" -lt 0 ]; then
  WANT_BENCH=0
elif [ -d "$BENCH_TREE" ]; then
  WANT_BENCH=1
else
  WANT_BENCH=0
fi

step() {
  printf '\n=== %s ===\n' "$1"
}

step 'typecheck'
npm run typecheck

step 'unit tests'
npm test

step 'build'
npm run build

step 'build:check'
npm run build:check

step 'benchmark network config'
if [ "$WANT_BENCH" -eq 1 ]; then
  bash "$BENCH_TREE/check-network.sh"
else
  echo 'skipped: bench/ is local-only and absent (use --with-bench to require it)'
fi

step 'fork surface guard'
bash scripts/diff-upstream.sh --check

printf '\nlocal CI: all steps passed\n'
