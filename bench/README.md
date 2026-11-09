# Benchmarks

Only the current Terminal-Bench product suite is kept. Old local 20-task and stress-only material
was removed.

## Product suite: Terminal-Bench easy10 + medium10

- Manifest: [`official/subsets/product20.json`](official/subsets/product20.json) — fixed before
  running, 10 easy + 10 medium.
- Arms: `stock` (stock `agent-loop`) vs `graph` (this bundle), same model/tools/timeouts.
- Gate: smoke task 1.0, then the four-task pre-run diagnostic (passed 2026-11-09 after the
  vpp/medical fixes; see [`automation/evaluator.md`](../automation/evaluator.md)), then all 20 tasks;
  report accuracy, prompt tokens, billed cost and steps.
- Status: **the corrected full product20 is live (2026-11-09); no aggregate yet.** PID `61129`,
  started 17:19 +08, OUT_DIR `official/results/2026-11-09-product20b/` (`runner.pid`, `rows.jsonl`
  growing per trial), log `/tmp/product20b-2026-11-09.log`, marker `/tmp/product20-shard-full.log`
  without `_EXIT`; executed run commit `da3d598` (rows carry it; `b3e9af7` is the README-only
  wrapper committed after start), tarball `f7a961a797ca5e17…`. Do not start a second run and
  do not run the smoke gate while it is live. Canonical state:
  [`docs/STATUS.md`](../docs/STATUS.md#current-benchmark-state). The earlier 04:18:32 run (PID `38616`,
  OUT_DIR `official/results/2026-11-09-product20/`) was **stopped at 31/40 and is NOT CITABLE**
  ([`INVALID.md`](official/results/2026-11-09-product20/INVALID.md)). **A run is citable only when
  every trial is valid** — `n_trials >= 1`, a healthy agent terminal, and writable declared artifact
  paths ([trial validity](../docs/EVALUATION.md#trial-validity)); the `workspace-write` cap behind the
  last clause was fixed at `da3d598` for both arms, so no number from the stopped run is citable.
- The **historical** tracked
  [`2026-11-08-product20-partial`](official/results/2026-11-08-product20-partial/README.md) run was
  taken on the pre-repair instrument and attempted 19/20 tasks (`formal-crypto` had no verifier
  image): 11 graph / 3 stock valid, only 2 paired-valid (`bun-sourcemap-leak`,
  `cargo-flight-dispatch`), all 0.0. The
  [`2026-11-08-oracle-control`](official/results/2026-11-08-oracle-control/README.md) passes 1.0 on
  `html-js-filter`, `cargo-flight-dispatch` and `music-harmony`, so a 0.0 is not by itself a product
  result. Never quote the partial rows as accuracy, parity or cost.

Readiness (2026-11-09): **20/20 env and 20/20 verifier** images including `formal-crypto`, Colima
**8 vCPU / 20 GiB / 150 GiB**, the `tb-dsh-base` overlay (Node 24.9.0 + DSH 0.2.2-rc.1) on every env
image, product20 sidecars pulled, `ci-local.sh` and the smoke gate passing (1.0 / 1.0 / 1.0). The
benchmark tarball is `f7a961a797ca5e17…` (223,458 B) and reproduces from HEAD, so verifying the sha
is enough — no repack is required.

The four-task pre-run diagnostic first **failed** on two infrastructure faults
([`2026-11-09-prediag-0122`](official/results/2026-11-09-prediag-0122/README.md)):
`intrastat-meldung` (graph 0/47, stock 42/47 criteria) and `heat-pump-warranty` (graph 1/21, stock
16/21) were valid 0.0 near-misses, while `vpp-loss-divergence` and `medical-claims-processing` were
`n_trials: 0` on both arms. Both faults were repaired and the four tasks reran
([`2026-11-09-prediag-fixes`](official/results/2026-11-09-prediag-fixes/README.md)): vpp 4/5 both
arms, medical 2/27 graph / 22/27 stock, all eight rows `n_trials: 1` / `n_errors: 0`; the gate
passes and the corrected run is live. The repairs are **local**: `build-arm64-task.sh` still uses
Docker's legacy builder (a canonical vpp rebuild reproduces the heredoc defect), and medical's compose
points at the local `tb-arm64-medical-claims-sidecar:latest` tag (a task-dir reset loses it). A
**separate** instrument defect capped these numbers when they were measured: DSH ran each trial under
the default `workspace-write` policy rooted at `/app`, so neither arm could write `intrastat`'s
`/workspace/out/reconciliation.json` or vpp's installed `site-packages` — intrastat's 0/47 / 42/47 and
vpp's 4/5 are **ceilings**, not near-misses (and `roy-polymorph-cn`/`freight-dispatch-shift` were
capped the same way). That defect is **fixed at `da3d598`** for both arms
(`sandbox-policy: danger-full-access`), so re-measure those tasks from the corrected run rather than
citing the pre-fix ceilings. Do not rebuild or reset either while the run is live; the vpp/medical
code fixes remain deferred until after `_EXIT`. The per-trial `write_capped` probe is still deferred
(see [instrument defects](../docs/EVALUATION.md#instrument-defects-open)). The 2026-11-08 readiness
records
([`2026-11-08-eval-1525`](official/results/2026-11-08-eval-1525/README.md),
[`2026-11-08-smoke-1525`](official/results/2026-11-08-smoke-1525/README.md)) are historical.

## Run

```sh
# prerequisites: Docker (arm64), Harbor, DSH credentials, proxy if needed
bash official/terminal-bench/preflight.sh
bash official/terminal-bench/run-smoke.sh
TASKS_DIR=/tmp/tb-arm-dsh bash official/subsets/run-product20.sh
```

`run-subset.sh` defaults `TASKS` to the product20 manifest and `OUT_DIR` to
`official/results/terminal-bench-product20/`. Tracked evidence lives under
`official/results/<date>-<name>/` (commit the run `README.md`; add `rows.jsonl`, `summary.json` and
`raw/` where the run produced them; Harbor `jobs/` is git-ignored).

## Native arm64 images

Terminal-Bench publishes amd64 images; DSH's Node crashes under qemu on Apple Silicon. Build each
task natively:

```sh
# source task dir from Harbor's cache, output dir, unique env/verifier tags
bash official/terminal-bench/build-arm64-task.sh \
  "$HOME/.cache/harbor/tasks/packages/terminal-bench/<task>/<hash>" \
  "/tmp/tb-arm-dsh/<task>" "tb-arm64-<task>-env:latest" "tb-arm64-<task>-verifier:latest"
```

The build script:
- strips base-image digests so local arm64 tags are used;
- rewrites the compose `main` service image to the local arm64 env tag (sidecars stay vendor images);
- sets `UV_HTTP_TIMEOUT=300` for verifier dependency installs;
- passes `HTTP_PROXY/HTTPS_PROXY/NO_PROXY` as build args when exported.

Prebake Node + DSH + pnpm once and overlay `/opt/node` and `/opt/dsh` into each task env image to
avoid reinstalling DSH in every trial. The benchmark adapter skips `npm install` when `dsh` is on
`PATH`.

## Proxy

Docker containers do not inherit the host network. If the host uses a TUN proxy, run an HTTP
CONNECT proxy reachable from the Colima VM and configure:

- the Docker daemon (`/etc/systemd/system/docker.service.d/http-proxy.conf` in the VM);
- `HTTP_PROXY`/`HTTPS_PROXY` for builds (the build script passes them);
- `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` in the harness process (the adapter injects them into
  setup and run commands).

## Adapter

[`official/terminal-bench/dsh_agent.py`](official/terminal-bench/dsh_agent.py) installs DSH in the
task container (or uses a prebaked image), installs the packed plugin, runs one headless turn and
downloads session logs. `DSH_STOCK=1` selects the control arm. The adapter honors
`DSH_AGENT_TIMEOUT_SEC`; `run-subset.sh` sets it from each task's `[agent].timeout_sec`, with
`DSH_AGENT_TIMEOUT_CAP` as an operator override. A timeout is a failure, not a score.
