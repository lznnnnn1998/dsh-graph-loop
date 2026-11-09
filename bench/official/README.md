# Terminal-Bench harness

The only official benchmark in this repo is the **Terminal-Bench 4.0 product20** suite
([`subsets/product20.json`](subsets/product20.json)). The hard stress subset and NL2Repo material
were removed; they are not current gates.

## Status

The **corrected full product20 is live (2026-11-09); no aggregate exists yet.** PID `61129`, started
17:19 +08, OUT_DIR `results/2026-11-09-product20b/` (`runner.pid`, `rows.jsonl` growing per trial), log
`/tmp/product20b-2026-11-09.log`, marker `/tmp/product20-shard-full.log` without `_EXIT`; run commit
`da3d598` (rows carry it; `b3e9af7` is the README-only wrapper committed after start), tarball
`f7a961a797ca5e17…`. Do not start a second run and do not run the smoke gate while
it is live; canonical state: [`docs/STATUS.md`](../../docs/STATUS.md#current-benchmark-state). The
earlier 04:18:32 run (PID `38616`, OUT_DIR `results/2026-11-09-product20/`) was **stopped at 31/40 and
is NOT CITABLE** ([`INVALID.md`](results/2026-11-09-product20/INVALID.md)). Readiness (2026-11-09):
20/20 env and 20/20 verifier images including `formal-crypto`, Colima 8 vCPU / 20 GiB / 150 GiB, the
`tb-dsh-base` overlay on every env image, product20 sidecars pulled, tarball
`f7a961a797ca5e17…`, smoke 1.0 / 1.0 / 1.0 — see
[`results/2026-11-09-product20-prep`](results/2026-11-09-product20-prep/README.md) (historical
snapshot) and [`results/2026-11-09-smoke-prep`](results/2026-11-09-smoke-prep/README.md).

The four-task pre-run diagnostic first **failed**
([`results/2026-11-09-prediag-0122`](results/2026-11-09-prediag-0122/README.md)):
`intrastat-meldung` (graph 0/47, stock 42/47 criteria) and `heat-pump-warranty` (graph 1/21, stock
16/21) produced Harbor-valid trials, while `vpp-loss-divergence` (`/opt/verifier_pristine` emptied by
the legacy builder's heredoc drop) and `medical-claims-processing` (amd64 `playwright-mcp` sidecar
never healthy under qemu) were `n_trials: 0` on both arms. Both faults were repaired and the four
tasks reran ([`results/2026-11-09-prediag-fixes`](results/2026-11-09-prediag-fixes/README.md)): vpp
4/5 both arms, medical 2/27 graph / 22/27 stock, all eight rows `n_trials: 1` / `n_errors: 0`; the
gate passes and the corrected run is live. The repairs are local-only: `build-arm64-task.sh` still
invokes Docker's legacy builder, so a canonical vpp rebuild reproduces the defect, and the medical
compose image tag is a local edit. **A third defect capped the numbers above when they were measured:**
DSH ran each trial under the default `workspace-write` policy rooted at `/app`, so neither arm could
write intrastat's `/workspace/out/reconciliation.json` or vpp's installed `site-packages`; intrastat's
0/47 / 42/47 and vpp's 4/5 are **ceilings, not capability near-misses** (`roy-polymorph-cn` and the
not-yet-run `freight-dispatch-shift` were capped the same way). That defect is **fixed at `da3d598`**
for both arms (`sandbox-policy: danger-full-access`); re-measure those tasks from the corrected run.
Do not rebuild or reset either while the run is live; the vpp/medical code fixes remain deferred, and
the per-trial `write_capped` probe is still open (see
[`docs/EVALUATION.md`](../../docs/EVALUATION.md#instrument-defects-open)).

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
canonical; a row with `n_trials: 0` is an infrastructure error, not a score. **`n_trials >= 1` is
not by itself validity** — also require a healthy agent terminal (no `TRANSPORT`; `GRAPH_FAILED` is
valid) and every declared artifact path writable, and treat transport-failed/write-capped trials as
an infrastructure re-run into a new `OUT_DIR`
([trial validity](../../docs/EVALUATION.md#trial-validity)).

## Adapter

[`terminal-bench/dsh_agent.py`](terminal-bench/dsh_agent.py) installs DSH in the task container (or
uses a prebaked image), installs the packed graph plugin, runs one headless turn, and downloads the
session logs. `DSH_STOCK=1` selects the stock-arm control. The runner exports the task's
`[agent].timeout_sec` as `DSH_AGENT_TIMEOUT_SEC`; `DSH_AGENT_TIMEOUT_CAP` overrides it. A timeout is
a failure, not a score.

Contract notes: [`adapter-contract.md`](adapter-contract.md).
