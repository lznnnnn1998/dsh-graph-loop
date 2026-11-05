#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPAT="${1:-/tmp/dsh-compat}"
bash "$ROOT/compat/setup.sh" "${DSH_ROOT:-/Users/zhinan/deepseek-harness}" "$COMPAT"
cd "$COMPAT"
echo "== vitest =="
./node_modules/.bin/vitest run --reporter=dot --no-file-parallelism
echo "== coverage (official per-file 100% threshold; expected to fail) =="
set +e
./node_modules/.bin/vitest run --coverage --reporter=dot --no-file-parallelism
echo "coverage gate exit: $?"
set -e
echo "== coverage summary (thresholds disabled for numbers) =="
./node_modules/.bin/vitest run --coverage --reporter=dot --no-file-parallelism \
  --coverage.thresholds.lines=0 --coverage.thresholds.statements=0 \
  --coverage.thresholds.functions=0 --coverage.thresholds.branches=0
