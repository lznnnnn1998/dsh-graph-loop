#!/usr/bin/env bash
# Run the fixed product suite (10 easy + 10 medium) with stock vs graph.
# Task directories must have been built natively under $TASKS_DIR.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
MANIFEST="$HERE/product20.json"
TASKS="$(python3 - "$MANIFEST" <<'PY'
import json, sys
d=json.load(open(sys.argv[1]))
print(' '.join(t['task'] for t in d['easy']+d['medium']))
PY
)"
OUT_DIR="${OUT_DIR:-$ROOT/bench/official/results/terminal-bench-product20}"
export TASKS OUT_DIR
exec bash "$ROOT/bench/official/terminal-bench/run-subset.sh" "${TASKS_DIR:-/tmp/tb-arm-dsh}"
