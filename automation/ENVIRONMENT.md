# Benchmark environment (stable facts)

Current run/lock/PID/tarball state is **not** here. Run `bash scripts/cycle-state.sh` and read the
latest result directory. This file records only facts that change rarely.

## Host / Docker

- Colima: 8 vCPU, 20 GiB RAM, 150 GiB disk; keep roughly 40 GB free.
- Docker daemon runs inside Colima. The daemon proxy is configured in
  `/etc/systemd/system/docker.service.d/http-proxy.conf`; it must point at the host LAN IP on port
  8899. Re-derive the IP with `ipconfig getifaddr en0` (currently `192.168.196.127` is the known
  value, not a permanent constant). The full network contract — package mirrors, build args and
  container env — lives in
  [`bench/README.md#network-setup-mirrors--proxy`](../bench/README.md#network-setup-mirrors--proxy);
  do not duplicate mirror URLs or proxy variable names here.
  `bash bench/official/terminal-bench/network-doctor.sh` prints and checks the resolved config.
- For a task build, export `HTTP_PROXY`/`HTTPS_PROXY=http://<host-ip>:8899`; the build script passes
  them as build args and `apply-mirrors.py` applies the package mirrors from `network.sh`. Direct
  daemon egress does not work.
- Prune dangling images only; never `docker system prune -a` while task images or a run exist.

## Images

- 20/20 `tb-arm64-<task>-env:latest` and 20/20 `tb-arm64-<task>-verifier:latest`.
- `tb-dsh-base:latest` with `/opt/node` and `/opt/dsh` overlay; `formal-crypto` has the SageMath
  verifier environment.
- `tb-arm64-medical-claims-sidecar:latest` is the arm64-native Playwright MCP sidecar
  (`mcr.microsoft.com/playwright:v1.56.0-noble` + `@playwright/mcp@0.0.64`). Do not replace it with
  the vendor amd64 image.
- The vpp env/verifier images were patched locally (legacy-builder heredoc repair; both arms 4/5).
  Do **not** rebuild or reset vpp or medical task directories from the legacy builder script; it
  reproduces the defect. Task source dirs live in `/tmp/tb-arm-dsh` (20 from
  `bench/official/subsets/product20.json`; an extra non-manifest task dir is harmless).

## Plugin tarball

The benchmark installs `dist/dsh-graph-loop-bench.tgz` into the task image. The default is only
valid when its sha256 equals a fresh `npm pack` from current HEAD and the extracted
`package/lib/index.js` contains the current routing/effect code (`toolSucceeded`, shared
`mutationObserved`, etc.). When no run is live, repack with `npm run build` and `npm pack` in
`packages/loop`, replace `dist/`, record the new size/sha in the current result README and the docs
that assert it, and verify the extracted bundle. Never repack while a benchmark is live.

## Smoke / diagnostic

- Smoke: `bash bench/official/terminal-bench/run-smoke.sh`; only when no product20 is live, and only
  with a tarball that matches HEAD.
- Bounded post-HEAD gate: a small `run-subset.sh` invocation with a shell-write/routing task
  (`html-js-filter` or `music-harmony`) plus at least one verifier-heavy task, new `OUT_DIR`, and
  row-level validity checks. Its rows are readiness evidence, not a product20 aggregate.
- A full product20 is 40 rows (20 tasks x 2 arms) and has no resume; see
  `automation/evaluator.md` and `docs/EVALUATION.md`.

## Known task caveats

- `medical-claims-processing`: DSH has no native SSE MCP client; the arm64 sidecar makes the trial
  valid, but the expected reward can still be 0. 0.0 with `n_trials: 1` is a valid near-miss, not
  infrastructure.
- `vpp-loss-divergence`: verifier must have a populated `/opt/verifier_pristine`; a
  `RewardFileNotFoundError` means the verifier image is broken, not the agent.
- Writes outside `/app` are allowed by the shared `sandbox-policy: danger-full-access` patch on both
  arms. A sandbox-denial quote or `Current DSH file policy: workspace-write` is an instrument
  failure.
- The `write_capped` / artifact-writable field is still deferred; grep trial sessions for the
  policy/denial evidence when a task's declared artifact is missing.
