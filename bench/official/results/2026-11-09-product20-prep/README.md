# product20 readiness — 2026-11-09

**Status: instrument ready; the full run is pending the pre-run diagnostic.** This note records the
environment repair after the 2026-11-08/09 audits; it is not a product result. No product20 rows
exist for this tree yet.

## Resource changes

| Resource | Before | Now |
|---|---|---|
| Colima vCPU | 4 | **8** (`colima start --cpu 8 --memory 20 --disk 150`) |
| Colima memory | 8 GiB | **20 GiB** |
| Colima disk | 99 GiB | **150 GiB** (47 GiB free after the formal-crypto build) |
| Docker daemon proxy | `192.168.1.5:8899` (dead host IP) | **`192.168.196.127:8899`**, the current host LAN IP; host proxy process is alive |
| Shadow-relay env | no `/opt/node`, no `/opt/dsh` | overlaid from `tb-dsh-base`: Node v24.9.0 + DSH 0.2.2-rc.1 |
| `formal-crypto` verifier | missing | built: `tb-arm64-formal-crypto-verifier:latest`, image ID `30f250a3ca65`, 9.73 GB; the build log ends `Successfully built 30f250a3ca65` and lists `sage 10.7` / `python 3.12.14` |
| heat-pump sidecars | missing / TLS failures | 6 sidecar images pulled |
| medical-claims sidecars | missing | 2 sidecar images pulled |

Direct Docker daemon egress failed even though host `curl` worked (the VM has no host TUN route), so
the daemon still needs the host CONNECT proxy. The proxy lives on the host at port 8899; the daemon
config is `/etc/systemd/system/docker.service.d/http-proxy.conf` **inside Colima**, not on macOS.

## Images

- env images: **20/20** `tb-arm64-<task>-env:latest`
- verifier images: **20/20** `tb-arm64-<task>-verifier:latest`
- `tb-dsh-base:latest` present
- plugin tarball: `dist/dsh-graph-loop-bench.tgz`, **223,458 B**, sha256
  `f7a961a797ca5e17fdd68d52c0bd6dfeec50ec4151f42d84bbd7405069b12064` (packed from the current
  plugin code; `lib` matches `npm run build:check`)

## Smoke

`OUT=bench/official/results/2026-11-09-smoke-prep bash bench/official/terminal-bench/run-smoke.sh`

```
oracle 1.0
graph  1.0
stock  1.0
```

## MCP limitation

`medical-claims-processing` declares a Playwright MCP server over **SSE**
(`http://playwright-mcp:3080/sse`). DSH has no SSE MCP client, so the adapter:

- declares `AgentCapabilities(mcp_servers=True)` so Harbor runs the task instead of rejecting it as
  an infrastructure error;
- exposes the server name/transport/URL in the prompt;
- does **not** register the server's tools as native tools.

This task should be reported as a known DSH limitation with an **expected** 0.0, not as a harness
failure, and it stays in the aggregate. It is a valid trial with criteria whatever it scores, not an
`n_trials: 0` row.

## Run policy

The full product20 is **pending, not blocked**: run the bounded four-task diagnostic from
[`automation/evaluator.md`](../../../../automation/evaluator.md) first
(`vpp-loss-divergence`, `intrastat-meldung`, `heat-pump-warranty`, `medical-claims-processing`, with
`DSH_AGENT_TIMEOUT_CAP=3600`), plus the direct `formal-crypto` verifier `--cpus 8` check, and record
`n_trials`/criteria for each. A diagnostic row with `n_trials: 0` is a real infrastructure failure to
fix or block on, not a score.

Keep the runner's per-task `[agent].timeout_sec` (28800 s) for the full run, or set a deliberate
`DSH_AGENT_TIMEOUT_CAP` for a bounded diagnostic; a timeout remains an infrastructure failure. The
recurring four-role cycle should skip its own product20 while this one runs (Harbor `__env`
containers are the live signal); a long run in the background is expected and is not a reason to hold
the cycle lock.

## Still untested

- `vpp-loss-divergence` reward-file path, `intrastat-meldung` in-container npm, and the full
  sidecar/compose path under Harbor (only images/smoke were verified here). These are exactly the
  paths the pre-run diagnostic exercises.
- No direct `formal-crypto` verifier `--cpus 8` run is recorded (`/private/tmp/formal-verifier-build.log`
  is the build log, not a runtime check); the diagnostic records one.
- No product aggregate; no accuracy/parity/token/cost claim.
