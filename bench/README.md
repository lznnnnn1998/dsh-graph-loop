# Benchmarks

Only the current Terminal-Bench product suite is kept. Old local 20-task and stress-only material
was removed.

## Product suite: Terminal-Bench easy10 + medium10

- Manifest: [`official/subsets/product20.json`](official/subsets/product20.json) — fixed before
  running, 10 easy + 10 medium.
- Arms: `stock` (stock `agent-loop`) vs `graph` (this bundle), same model/tools/timeouts.
- Gate: smoke task 1.0, then all 20 tasks; report accuracy, prompt tokens, billed cost and steps.
- Status: **no aggregate; instrument unvalidated.** The tracked
  [`2026-11-08-product20-partial`](official/results/2026-11-08-product20-partial/README.md) run
  attempted 19/20 tasks (`formal-crypto` has no verifier image): 11 graph / 3 stock valid, only 2
  paired-valid (`bun-sourcemap-leak`, `cargo-flight-dispatch`), all 0.0. The
  [`2026-11-08-oracle-control`](official/results/2026-11-08-oracle-control/README.md) passes 1.0 on
  `html-js-filter`, `cargo-flight-dispatch` and `music-harmony`, so a 0.0 is not by itself a product
  result. Never quote the partial rows as accuracy, parity or cost.

## Run

```sh
# prerequisites: Docker (arm64), Harbor, DSH credentials, proxy if needed
bash official/terminal-bench/preflight.sh
bash official/terminal-bench/run-smoke.sh
TASKS_DIR=/tmp/tb-arm-dsh bash official/subsets/run-product20.sh
```

`run-subset.sh` defaults `TASKS` to the product20 manifest and `OUT_DIR` to
`official/results/terminal-bench-product20/`. Tracked evidence lives under
`official/results/<date>-<name>/` (only `rows.jsonl`, `summary.json` and `raw/` should be committed;
Harbor `jobs/` is git-ignored).

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
