#!/usr/bin/env bash
# Run the fixed Terminal-Bench 4.0 subset with stock and graph arms.
#
# Prerequisites:
#   - Docker + Harbor installed
#   - native arm64 task copies under $TASKS_DIR (see build-arm64-task.sh)
#   - DSH_PLUGIN_TARBALL points at the packed graph plugin
#   - DEEPSEEK_API_KEY in the DSH credential store
#
# Usage: bash bench/official/terminal-bench/run-subset.sh [tasks-dir] [out-dir]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TASKS_DIR="${1:-${TASKS_DIR:-/tmp/tb-arm-dsh}}"
OUT_DIR="${2:-${OUT_DIR:-$ROOT/bench/official/results/terminal-bench-subset}}"
JOBS_DIR="$OUT_DIR/jobs"
mkdir -p "$JOBS_DIR"
export PATH="$HOME/.local/bin:$PATH"
export PYTHONPATH="$ROOT/bench/official/terminal-bench${PYTHONPATH:+:$PYTHONPATH}"
export DSH_PLUGIN_TARBALL="${DSH_PLUGIN_TARBALL:-$ROOT/dist/dsh-graph-loop-bench.tgz}"
export DSH_AGENT_TIMEOUT_SEC="${DSH_AGENT_TIMEOUT_SEC:-900}"
export TASKS_DIR OUT_DIR JOBS_DIR

TASKS="${TASKS:-bun-sourcemap-leak foodstuff-beta-activity interleaved-vigenere medical-claims-processing music-harmony payments-pipeline-fix protein-autointerp-disulfide}"

if [ "${SKIP_SMOKE:-0}" != "1" ]; then
  echo "== smoke gate (set SKIP_SMOKE=1 to bypass)"
  bash "$ROOT/bench/official/terminal-bench/run-smoke.sh"
fi

KEY="$(python3 - <<'PY'
import os, yaml
path = os.path.expanduser('~/.dsh/.credentials.yaml')
print(yaml.safe_load(open(path))['refs']['DEEPSEEK_API_KEY'])
PY
)"

ROWS="$OUT_DIR/rows.jsonl"
: > "$ROWS"
for task in $TASKS; do
  task_dir="$TASKS_DIR/$task"
  [ -f "$task_dir/task.toml" ] || { echo "SKIP $task (no task dir)"; continue; }
  TASK_TIMEOUT=$(python3 - "$task_dir/task.toml" <<'PY'
import sys, tomllib
with open(sys.argv[1], 'rb') as fh:
    data = tomllib.load(fh)
print(int(float(data.get('agent', {}).get('timeout_sec', 900))))
PY
)
  export DSH_AGENT_TIMEOUT_SEC="${DSH_AGENT_TIMEOUT_CAP:-$TASK_TIMEOUT}"
  echo "agent timeout: ${DSH_AGENT_TIMEOUT_SEC}s"
  for arm in graph stock; do
    job="tb-${arm}-${task}-$(date +%H%M%S)"
    echo "===== $arm $task ====="
    if [ "$arm" = stock ]; then export DSH_STOCK=1; else unset DSH_STOCK; fi
    set +e
    harbor run --path "$task_dir" --agent dsh_agent:DshAgent \
      --model deepseek/deepseek-flash \
      --ae DEEPSEEK_API_KEY="$KEY" \
      --env docker --n-concurrent 1 \
      --jobs-dir "$JOBS_DIR" --job-name "$job" \
      --agent-setup-timeout-multiplier 5 --yes > "$OUT_DIR/${arm}-${task}.log" 2>&1
    status=$?
    set -e
    python3 - "$JOBS_DIR/$job/result.json" "$task" "$arm" "$status" "$ROWS" <<'PY'
import json, sys
from pathlib import Path
result_path, task, arm, status, rows = sys.argv[1:]
score = None
trials = 0
errors = 0
if Path(result_path).exists():
    data = json.loads(Path(result_path).read_text())
    stats = data.get('stats', {})
    evals = stats.get('evals', {})
    if evals:
        first = next(iter(evals.values()))
        metrics = first.get('metrics') or []
        if metrics:
            score = metrics[0].get('mean')
        trials = first.get('n_trials', 0)
        errors = first.get('n_errors', 0)
row = {'task': task, 'arm': arm, 'score': score, 'n_trials': trials, 'n_errors': errors, 'exit': int(status), 'result': result_path}
with open(rows, 'a') as fh:
    fh.write(json.dumps(row) + '\n')
print(f"{arm:5} {task:28} score={score} trials={trials} errors={errors} exit={status}")
PY
  done
done

python3 - "$ROWS" "$OUT_DIR/summary.json" <<'PY'
import json, statistics, sys
from pathlib import Path
rows = [json.loads(line) for line in Path(sys.argv[1]).read_text().splitlines() if line.strip()]
summary = {}
for arm in ('stock', 'graph'):
    arm_rows = [r for r in rows if r['arm'] == arm and r['score'] is not None]
    scores = [r['score'] for r in arm_rows]
    summary[arm] = {
        'n': len(arm_rows),
        'mean': statistics.mean(scores) if scores else None,
        'scores': {r['task']: r['score'] for r in arm_rows},
    }
Path(sys.argv[2]).write_text(json.dumps({'rows': rows, 'summary': summary}, indent=2) + '\n')
print(json.dumps(summary, indent=2))
PY
echo "PASS subset finished: $OUT_DIR"
