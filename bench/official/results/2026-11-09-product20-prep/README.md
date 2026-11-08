# product20 readiness — 2026-11-09

**Status: instrument ready for a full run.** This note records the environment repair after the
2026-11-08/09 audits; it is not a product result. No product20 rows exist for this tree yet.

## Resource changes

| Resource | Before | Now |
|---|---|---|
| Colima vCPU | 4 | **8** (`colima start --cpu 8 --memory 20 --disk 150`) |
| Colima memory | 8 GiB | **20 GiB** |
| Colima disk | 99 GiB | **150 GiB** (47 GiB free after the formal-crypto build) |
| Docker daemon proxy | `192.168.1.5:8899` (dead host IP) | **`192.168.196.127:8899`**, the current host LAN IP; host proxy process is alive |
| Shadow-relay env | no `/opt/node`, no `/opt/dsh` | overlaid from `tb-dsh-base`: Node v24.9.0 + DSH 0.2.2-rc.1 |
| `formal-crypto` verifier | missing | built: `tb-arm64-formal-crypto-verifier:latest`, 9.73 GB, SageMath 10.7 / Python 3.12 verified at `--cpus 8` |
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

This task should be reported as a known DSH limitation (likely 0), not as a harness failure. It is
still a valid trial with criteria, not an `n_trials: 0` row.

## Run policy

Full product20 can now start. Keep the runner's per-task `[agent].timeout_sec` (28800 s) or set a
deliberate `DSH_AGENT_TIMEOUT_CAP` for a bounded diagnostic; a timeout remains an infrastructure
failure. The recurring four-role cycle should skip its own product20 while this one runs (Harbor
`__env` containers are the live signal).

## Still untested

- `vpp-loss-divergence` reward-file path, `intrastat-meldung` in-container npm, and the full
  sidecar/compose path under Harbor (only images/smoke were verified here).
- No product aggregate; no accuracy/parity/token/cost claim.
