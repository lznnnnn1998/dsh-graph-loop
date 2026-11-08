# Terminal-Bench harness

The only official benchmark in this repo is the **Terminal-Bench 4.0 product20** suite
([`subsets/product20.json`](subsets/product20.json)). The hard stress subset and NL2Repo material
were removed; they are not current gates.

## Status

No valid aggregate. The tracked
[`results/2026-11-08-product20-partial`](results/2026-11-08-product20-partial/README.md) attempted
19/20 tasks: 11 graph / 3 stock valid, 2 paired-valid, all 0.0; the instrument is unvalidated for the
full suite. A three-task
[`oracle control`](results/2026-11-08-oracle-control/README.md) scores 1.0 on three of those tasks,
so the task image/verifier path can pass; it does not validate the DSH arm. Do not report the partial
rows as accuracy, parity or cost.

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

Results default to `results/terminal-bench-product20/`. Tracked runs are committed under
`results/<date>-<name>/` with `rows.jsonl`, `summary.json` and `raw/` copies of Harbor results;
`jobs/` stays git-ignored. Keep `rows.jsonl` as canonical; a row with `n_trials: 0` is an
infrastructure error, not a score.

## Adapter

[`terminal-bench/dsh_agent.py`](terminal-bench/dsh_agent.py) installs DSH in the task container (or
uses a prebaked image), installs the packed graph plugin, runs one headless turn, and downloads the
session logs. `DSH_STOCK=1` selects the stock-arm control. The runner exports the task's
`[agent].timeout_sec` as `DSH_AGENT_TIMEOUT_SEC`; `DSH_AGENT_TIMEOUT_CAP` overrides it. A timeout is
a failure, not a score.

Contract notes: [`adapter-contract.md`](adapter-contract.md).
