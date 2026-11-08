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
#
# TASKS defaults to the fixed product20 manifest; do not carry a mutable ad-hoc
# default. Pass a space-separated TASKS env var only for a declared diagnostic.
# OUT_DIR defaults to the product20 results directory.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MANIFEST="$ROOT/bench/official/subsets/product20.json"
TASKS_DIR="${1:-${TASKS_DIR:-/tmp/tb-arm-dsh}}"
OUT_DIR="${2:-${OUT_DIR:-$ROOT/bench/official/results/terminal-bench-product20}}"
JOBS_DIR="$OUT_DIR/jobs"
RAW_DIR="$OUT_DIR/raw"
mkdir -p "$JOBS_DIR" "$RAW_DIR"
export PATH="$HOME/.local/bin:$PATH"
export PYTHONPATH="$ROOT/bench/official/terminal-bench${PYTHONPATH:+:$PYTHONPATH}"
export DSH_PLUGIN_TARBALL="${DSH_PLUGIN_TARBALL:-$ROOT/dist/dsh-graph-loop-bench.tgz}"
export TASKS_DIR OUT_DIR JOBS_DIR
export GIT_COMMIT="$(git -C "$ROOT" rev-parse HEAD)"

TASKS="${TASKS:-$(python3 - "$MANIFEST" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
print(' '.join(t['task'] for t in d['easy'] + d['medium']))
PY
)}"

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
  # Honor the task's [agent].timeout_sec. DSH_AGENT_TIMEOUT_CAP is an operator
  # fail-fast override; it is the only way to shorten the task budget. A
  # timeout is an infrastructure failure, not a score.
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
    python3 - "$JOBS_DIR/$job/result.json" "$task" "$arm" "$status" "$ROWS" "$task_dir" "$RAW_DIR/$job.json" <<'PY'
import json, os, shutil, sys, tomllib
from pathlib import Path
from criteria import extract_criteria
result_path, task, arm, status, rows, task_dir, raw_path = sys.argv[1:]
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
images = {}
toml_path = Path(task_dir) / 'task.toml'
if toml_path.exists():
    data = tomllib.loads(toml_path.read_text())
    images = {
        'image_env': (data.get('environment') or {}).get('docker_image'),
        'image_verifier': (data.get('verifier', {}).get('environment') or {}).get('docker_image'),
    }
durable = raw_path
if Path(result_path).exists():
    shutil.copyfile(result_path, raw_path)
# Reward is binary; keep the verifier's per-criterion/per-test result so a
# near-miss is distinguishable from a no-op.
criteria = extract_criteria(Path(result_path).parent) if Path(result_path).exists() else {
    'criteria_passed': None, 'criteria_total': None, 'criteria_failed': [], 'criteria_source': 'unavailable',
}
row = {
    'task': task,
    'arm': arm,
    'score': score,
    'n_trials': trials,
    'n_errors': errors,
    'exit': int(status),
    'commit': os.environ.get('GIT_COMMIT'),
    'model': 'deepseek/deepseek-flash',
    'agent_timeout_sec': int(os.environ.get('DSH_AGENT_TIMEOUT_SEC', '0')),
    'agent_setup_timeout_multiplier': 5,
    'image_env': images.get('image_env'),
    'image_verifier': images.get('image_verifier'),
    'result': durable,
    'criteria': criteria,
}
with open(rows, 'a') as fh:
    fh.write(json.dumps(row) + '\n')
print(f"{arm:5} {task:28} score={score} trials={trials} errors={errors} exit={status} "
      f"criteria={criteria.get('criteria_passed')}/{criteria.get('criteria_total')} ({criteria.get('criteria_source')})")
PY
  done
done

python3 - "$ROWS" "$OUT_DIR/summary.json" <<'PY'
import json, os, statistics, sys
from pathlib import Path
rows = [json.loads(line) for line in Path(sys.argv[1]).read_text().splitlines() if line.strip()]
summary = {}
for arm in ('stock', 'graph'):
    arm_rows = [r for r in rows if r['arm'] == arm and r['score'] is not None]
    scores = [r['score'] for r in arm_rows]
    criteria_rows = [
        r for r in arm_rows
        if isinstance(r.get('criteria'), dict) and r['criteria'].get('criteria_total')
    ]
    criteria_passed = sum(int(r['criteria']['criteria_passed']) for r in criteria_rows)
    criteria_total = sum(int(r['criteria']['criteria_total']) for r in criteria_rows)
    summary[arm] = {
        'n': len(arm_rows),
        'mean': statistics.mean(scores) if scores else None,
        'scores': {r['task']: r['score'] for r in arm_rows},
        'criteria': {
            'tasks_with_criteria': len(criteria_rows),
            'passed': criteria_passed,
            'total': criteria_total,
            'micro_rate': (criteria_passed / criteria_total) if criteria_total else None,
        },
    }
meta = {
    'commit': os.environ.get('GIT_COMMIT'),
    'model': 'deepseek/deepseek-flash',
    'agent_setup_timeout_multiplier': 5,
    'timeout_policy': "per-task [agent].timeout_sec; DSH_AGENT_TIMEOUT_CAP overrides; a timeout is an infrastructure failure, not a score",
}
Path(sys.argv[2]).write_text(json.dumps({'meta': meta, 'rows': rows, 'summary': summary}, indent=2) + '\n')
print(json.dumps(summary, indent=2))
PY
echo "PASS subset finished: $OUT_DIR"
