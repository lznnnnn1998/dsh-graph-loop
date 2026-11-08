# Terminal-Bench harness

The only official benchmark in this repo is the **Terminal-Bench 4.0 product20** suite
([`subsets/product20.json`](subsets/product20.json)). The hard stress subset and NL2Repo material
were removed; they are not current gates.

## Prerequisites

- Docker (arm64 on Apple Silicon), Harbor, DSH credentials.
- Native arm64 task images built with
  [`terminal-bench/build-arm64-task.sh`](terminal-bench/build-arm64-task.sh); see
  [`../README.md`](../README.md).

## Order

```sh
# 1. harness + adapter preflight
bash terminal-bench/preflight.sh

# 2. smoke: oracle/graph/stock must all be 1.0
bash terminal-bench/run-smoke.sh

# 3. product20: graph and stock for every task
TASKS_DIR=/tmp/tb-arm-dsh bash subsets/run-product20.sh
```

Results are written under `results/terminal-bench-product20/` (generated, not tracked). Keep
`rows.jsonl` as canonical; a row with `n_trials: 0` is an infrastructure error, not a score.

## Adapter

[`terminal-bench/dsh_agent.py`](terminal-bench/dsh_agent.py) installs DSH in the task container (or
uses a prebaked image), installs the packed graph plugin, runs one headless turn, and downloads the
session logs. `DSH_STOCK=1` selects the stock-arm control.

Contract notes: [`adapter-contract.md`](adapter-contract.md).
