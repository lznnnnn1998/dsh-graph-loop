#!/usr/bin/env bash
# Local release gate — the same commands a CI provider would run, with no
# external services, network installs, Docker or model calls.
#
#   bash scripts/ci-local.sh
#
# Steps:
#   1. typecheck (tsc --noEmit over packages/** + test/**)
#   2. unit tests  (node --test, no model)
#   3. bundle build (packages/*/lib)
#   4. reproducibility check (fresh build byte-equals packages/*/lib)
#   5. benchmark network config (offline: network.sh + apply-mirrors.py)
#   6. fork surface guard (diff-upstream.sh --check; skips without a DSH checkout)
#
# Exit code 0 only when every step passes. This script is referenced by
# docs/STATUS.md; keep it dependency-free so any runner can execute it.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

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
bash bench/official/terminal-bench/check-network.sh

step 'fork surface guard'
bash scripts/diff-upstream.sh --check

printf '\nlocal CI: all steps passed\n'
