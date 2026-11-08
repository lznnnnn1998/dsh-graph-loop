# Terminal-Bench harness

The only official benchmark in this repo is the **Terminal-Bench 4.0 product20** suite
([`subsets/product20.json`](subsets/product20.json)). The hard stress subset and NL2Repo material
were removed; they are not current gates.

## Status

No aggregate; the full product20 run is **pending, not blocked**. Readiness (2026-11-09): 20/20 env
and 20/20 verifier images including `formal-crypto`, Colima 8 vCPU / 20 GiB / 150 GiB, the
`tb-dsh-base` overlay on every env image, product20 sidecars pulled, tarball `f7a961a797ca5e17…`,
smoke 1.0 / 1.0 / 1.0 — see
[`results/2026-11-09-product20-prep`](results/2026-11-09-product20-prep/README.md) and
[`results/2026-11-09-smoke-prep`](results/2026-11-09-smoke-prep/README.md). The four-task pre-run
diagnostic in [`automation/evaluator.md`](../../automation/evaluator.md) is the gate before the full
run; it is a readiness check, not a new score.

The tracked [`results/2026-11-08-product20-partial`](results/2026-11-08-product20-partial/README.md)
run is **historical**: it was taken on the pre-repair instrument, attempted 19/20 tasks, produced 11
graph / 3 stock valid trials and 2 paired-valid tasks, and every valid score is 0.0. A three-task
[`oracle control`](results/2026-11-08-oracle-control/README.md) scores 1.0 on three of those tasks,
so the task image/verifier path can pass; it does not validate the DSH arm. Do not report the
partial rows as accuracy, parity or cost.

The 2026-11-08 evaluator/readiness records
([`results/2026-11-08-eval-1525`](results/2026-11-08-eval-1525/README.md)) are historical too: 20/20
env but 19/20 verifier images, on the old 4-CPU VM. The benchmark tarball is now
`f7a961a797ca5e17…` (223,458 B) and `npm pack` reproduces it from HEAD, so verify the sha — no repack
is required.

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
`results/<date>-<name>/` with a `README.md`, plus `rows.jsonl`, `summary.json` and `raw/` copies of
Harbor results where the run produced them; `jobs/` stays git-ignored. Keep `rows.jsonl` as
canonical; a row with `n_trials: 0` is an infrastructure error, not a score.

## Adapter

[`terminal-bench/dsh_agent.py`](terminal-bench/dsh_agent.py) installs DSH in the task container (or
uses a prebaked image), installs the packed graph plugin, runs one headless turn, and downloads the
session logs. `DSH_STOCK=1` selects the stock-arm control. The runner exports the task's
`[agent].timeout_sec` as `DSH_AGENT_TIMEOUT_SEC`; `DSH_AGENT_TIMEOUT_CAP` overrides it. A timeout is
a failure, not a score.

Contract notes: [`adapter-contract.md`](adapter-contract.md).
