#!/usr/bin/env bash
# Validate the harness + DSH adapter on a trivial task before a benchmark subset.
# Oracle, graph, and stock must all score 1.0.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
export PATH="$HOME/.local/bin:$PATH"
export PYTHONPATH="$HERE${PYTHONPATH:+:$PYTHONPATH}"
export DSH_PLUGIN_TARBALL="${DSH_PLUGIN_TARBALL:-$ROOT/dist/dsh-graph-loop-bench.tgz}"
OUT="${OUT:-$ROOT/bench/official/results/smoke-answer-42}"
JOBS="$OUT/jobs"; mkdir -p "$JOBS"
TASK="$HERE/smoke-task"
KEY="$(python3 - <<'PY'
import os,yaml
print(yaml.safe_load(open(os.path.expanduser('~/.dsh/.credentials.yaml')))['refs']['DEEPSEEK_API_KEY'])
PY
)"
run() {
  local arm="$1" job="smoke-$1-$(date +%H%M%S)"
  echo "== $arm"
  local stock=0; [ "$arm" = stock ] && stock=1
  ( cd "$ROOT" && DSH_STOCK="$stock" harbor run --path "$TASK" --agent "${2}" \
      --model deepseek/deepseek-flash --ae DEEPSEEK_API_KEY="$KEY" --env docker \
      --n-concurrent 1 --jobs-dir "$JOBS" --job-name "$job" --yes \
      > "$OUT/$arm.log" 2>&1 ) || true
  python3 - "$JOBS/$job/result.json" "$arm" <<'PY'
import json,sys
from pathlib import Path
p=Path(sys.argv[1]); score=None
if p.exists():
 d=json.loads(p.read_text()); ev=d.get('stats',{}).get('evals',{})
 if ev:
  m=(next(iter(ev.values())).get('metrics') or [])
  if m: score=m[0].get('mean')
print(f"{sys.argv[2]}: score={score}")
if score != 1.0: raise SystemExit(1)
PY
}
run oracle oracle
run graph dsh_agent:DshAgent
run stock dsh_agent:DshAgent
echo "PASS smoke: oracle, graph and stock all 1.0"
