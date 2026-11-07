# Terminal-Bench product subsets

Product-line replacement for the old local 20-task suite:

| file | tier | rule |
|---|---|---|
| [`easy10.json`](easy10.json) | easy | expert estimate ≤ 2.0 h; no GPU tasks |
| [`medium10.json`](medium10.json) | medium | expert estimate 2.5–4.0 h |
| [`product20.json`](product20.json) | combined | 10 easy + 10 medium |

Selection is **fixed before running**; do not swap tasks after seeing scores. Terminal-Bench product suite is removed
from the repository. Terminal-Bench is still the same harness; this product suite is separate from
the hard stress subset.

## Run

```sh
# 1. smoke first
bash bench/official/terminal-bench/run-smoke.sh

# 2. build native arm64 task dirs (one per task; repeat)
bash bench/official/terminal-bench/build-arm64-task.sh \
  "$HOME/.cache/harbor/tasks/packages/terminal-bench/<task>/<hash>" /tmp/tb-arm-dsh/<task>

# 3. run stock vs graph; reads product20.json
TASKS="$(python3 -c 'import json;print(" ".join(t["task"] for t in json.load(open("bench/official/subsets/product20.json"))["easy"]+json.load(open("bench/official/subsets/product20.json"))["medium"]))')" \
OUT_DIR="$PWD/bench/official/results/terminal-bench-product20" \
bash bench/official/terminal-bench/run-subset.sh /tmp/tb-arm-dsh
```

Known build constraints: some tasks have amd64-only sidecars or desktop dependencies; those are
recorded as build blockers, not silently replaced. The suite is fixed; if a task cannot build, the
result is an infrastructure gap for that task, not a substitution.
