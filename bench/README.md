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
- Status: **the corrected full product20 was aborted at 5/40 on 2026-11-09 19:44 +08; no aggregate
  yet.** The graph arm hit the stage-routing bug fixed at `4561008`, so the five rows are not citable
  ([`ABORTED.md`](official/results/2026-11-09-product20b/ABORTED.md)); the marker
  `/tmp/product20-shard-full.log` ends `_EXIT`, PID `61129` is dead, both
  `official/results/*/runner.pid` PIDs are dead, and no Harbor `__env` container is running. The run
  executed `da3d598` with the pre-fix tarball `f7a961a797ca5e17…`. No benchmark is live. A rerun is
  blocked on repacking `dist/dsh-graph-loop-bench.tgz` from HEAD and passing a bounded post-HEAD
  real-model pre-run (audit `20261109-1319` P0-2/P0-3). Canonical state:
  [`docs/STATUS.md`](../docs/STATUS.md#current-benchmark-state). The earlier 04:18:32 run (PID `38616`,
  OUT_DIR `official/results/2026-11-09-product20/`) was **stopped at 31/40 and is NOT CITABLE**
  ([`INVALID.md`](official/results/2026-11-09-product20/INVALID.md)). **A run is citable only when
  every trial is valid** — `n_trials >= 1`, a healthy agent terminal, and writable declared artifact
  paths ([trial validity](../docs/EVALUATION.md#trial-validity)); the `workspace-write` cap behind the
  last clause was fixed at `da3d598` for both arms, and `GRAPH_FAILED` rows are reported separately
  after `4561008`.
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
benchmark tarball in `dist/` is the **pre-`4561008`** bundle: `f7a961a797ca5e17…` (223,458 B), while a
pack from HEAD is 225,595 B / `45de8539…` and contains `toolSucceeded`. **Repack from HEAD before any
rerun** — verifying the old sha is not enough, and the smoke/diagnostic above installed the old
plugin.

The four-task pre-run diagnostic first **failed** on two infrastructure faults
([`2026-11-09-prediag-0122`](official/results/2026-11-09-prediag-0122/README.md)):
`intrastat-meldung` (graph 0/47, stock 42/47 criteria) and `heat-pump-warranty` (graph 1/21, stock
16/21) were valid 0.0 near-misses, while `vpp-loss-divergence` and `medical-claims-processing` were
`n_trials: 0` on both arms. Both faults were repaired and the four tasks reran
([`2026-11-09-prediag-fixes`](official/results/2026-11-09-prediag-fixes/README.md)): vpp 4/5 both
arms, medical 2/27 graph / 22/27 stock, all eight rows `n_trials: 1` / `n_errors: 0`; the gate
passed (pre-HEAD, so it does not cover `4561008`). The repairs are **local**: `build-arm64-task.sh`
still uses
Docker's legacy builder (a canonical vpp rebuild reproduces the heredoc defect), and medical's compose
points at the local `tb-arm64-medical-claims-sidecar:latest` tag (a task-dir reset loses it). A
**separate** instrument defect capped these numbers when they were measured: DSH ran each trial under
the default `workspace-write` policy rooted at `/app`, so neither arm could write `intrastat`'s
`/workspace/out/reconciliation.json` or vpp's installed `site-packages` — intrastat's 0/47 / 42/47 and
vpp's 4/5 are **ceilings**, not near-misses (and `roy-polymorph-cn`/`freight-dispatch-shift` were
capped the same way). That defect is **fixed at `da3d598`** for both arms
(`sandbox-policy: danger-full-access`), so re-measure those tasks from a future completed run rather
than citing the pre-fix ceilings. The runner is stopped, but do not rebuild or reset either before the
builder/compose fixes land; the vpp/medical code fixes remain deferred. The per-trial `write_capped`
probe is still deferred
(see [instrument defects](../docs/EVALUATION.md#instrument-defects-open)). The 2026-11-08 readiness
records
([`2026-11-08-eval-1525`](official/results/2026-11-08-eval-1525/README.md),
[`2026-11-08-smoke-1525`](official/results/2026-11-08-smoke-1525/README.md)) are historical.

## Run

```sh
# prerequisites: Docker (arm64), Harbor, DSH credentials, network (see below)
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
- applies the network config from `network.sh` (next section) to the copied task tree before
  building;
- passes `HTTP_PROXY/HTTPS_PROXY/NO_PROXY` as build args when exported.

Prebake Node + DSH + pnpm once and overlay `/opt/node` and `/opt/dsh` into each task env image to
avoid reinstalling DSH in every trial. Build the base image with
`bash official/terminal-bench/build-dsh-base.sh` so it uses the same network config; the benchmark
adapter skips `npm install` when `dsh` is on `PATH`.

## Network setup (mirrors + proxy)

Every benchmark script reads its network settings from one file,
[`official/terminal-bench/network.sh`](official/terminal-bench/network.sh). Do not re-declare a
package index, a Node download URL or a proxy variable name in a script, Dockerfile or the Python
adapter; add it to `network.sh` and let the consumers read it.

### Package mirrors

One switch selects the package sources:

```sh
source bench/official/terminal-bench/network.sh                  # DSH_MIRRORS=cn (default)
DSH_MIRRORS=off source bench/official/terminal-bench/network.sh  # upstream sources
```

In `cn` mode the same resolved values reach every layer:

- **task image builds** — `build-arm64-task.sh` runs `apply-mirrors.py` on the copied task tree: it
  sets pip/uv/npm env, rewrites explicit pypi / files.pythonhosted / registry.npmjs.org /
  nodejs.org URLs, points Debian/Ubuntu apt sources at the apt mirror (only in stages that run apt)
  and rewrites `uv.lock` registry URLs. The task source tree is never modified.
- **the reusable base image** — `build-dsh-base.sh` applies the same rewrite before `docker build`.
- **the Harbor process and task containers** — `run-smoke.sh`/`run-subset.sh` source `network.sh`;
  `dsh_agent.py` forwards the resolved mirror variables and proxy variables into the container's
  setup and run steps. Node downloads use the Node mirror; pip/uv/npm use theirs.

Each value can be overridden before sourcing (`PIP_INDEX_URL`, `PIP_TRUSTED_HOST`,
`UV_DEFAULT_INDEX`, `NPM_CONFIG_REGISTRY`, `DSH_NODE_MIRROR`, `DSH_APT_MIRROR`); `DSH_NODE_MIRROR`
is a base URL without a version. Run `bash official/terminal-bench/network.sh` to print the
resolved configuration, and `bash official/terminal-bench/check-network.sh` for the offline
regression check. Use `DSH_MIRRORS=off` for a canonical/upstream run; the mode is recorded in each
run row and in `summary.json`.

### Proxy

Docker containers do not inherit the host environment. If the host uses a TUN proxy, run an HTTP
CONNECT proxy reachable from the Colima VM and configure all three consumers:

1. **Docker daemon** (image pulls): set it inside the Colima VM — not on macOS — in
   `/etc/systemd/system/docker.service.d/http-proxy.conf`, pointing at the host LAN IP on port
   8899. Re-derive the IP with `ipconfig getifaddr en0`; it changes with the network. The repo does
   not manage this file.
2. **Image builds**: export `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`; the build scripts pass them as
   `--build-arg`.
3. **Harness and task container**: the same variables are inherited by `harbor` and injected into
   the container by `dsh_agent.py` (the model API call needs them).

`bash official/terminal-bench/network-doctor.sh` prints the resolved mirror/proxy configuration,
the host LAN IP and the Docker daemon proxy, and warns when the daemon proxy still points at an old
IP.

## Adapter

[`official/terminal-bench/dsh_agent.py`](official/terminal-bench/dsh_agent.py) installs DSH in the
task container (or uses a prebaked image), installs the packed plugin, runs one headless turn and
downloads session logs. `DSH_STOCK=1` selects the control arm. The adapter honors
`DSH_AGENT_TIMEOUT_SEC`; `run-subset.sh` sets it from each task's `[agent].timeout_sec`, with
`DSH_AGENT_TIMEOUT_CAP` as an operator override. A timeout is a failure, not a score.
