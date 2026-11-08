# Readiness + gate — cycle `20261108-1055` (2026-11-08)

Fresh evaluator pass on HEAD `fb08b8d` (working tree clean). Host: Colima aarch64,
Docker 29.5.2 (no `buildx` plugin → BuildKit unavailable, legacy builder only),
VM **4 vCPU / 8,307,163,136 B RAM**, Harbor 0.25.0.

Writes: this directory only (`bench/official/results/2026-11-08-readiness/`) plus the
sibling smoke run (`../2026-11-08-smoke/`). No product source touched, no push.

## Readiness

| Item | State |
|---|---|
| 20 env images `tb-arm64-<task>-env:latest` | **20/20 present**, all `linux/arm64`; every prepared `/tmp/tb-arm-dsh/<task>/task.toml` points at the local tags |
| 20 verifier images `tb-arm64-<task>-verifier:latest` | **19/20**; `formal-crypto` missing (build retried, blocked — below) |
| `tb-dsh-base:latest` | present, 2.15 GB, `linux/arm64` |
| `dist/dsh-graph-loop-bench.tgz` | present, 213,558 B, sha256 `de483a673e4ee5f0cbb8df3fc2be0c10db95e13b04c7dabd1ceea73b945f2278` |
| Node/DSH overlay | verified in **19/20** env images (`/opt/node/bin/node` v24.9.0 and `/opt/dsh/bin/dsh` on PATH). **`shadow-relay` env lacks both** — the adapter would bootstrap Node+DSH over the network at trial start (by-design fallback, slower and network-dependent) |
| Docker proxy | **not configured.** No proxy in `~/.docker/config.json` or the daemon; `192.168.1.5:8899` still accepts TCP but **aborts CONNECT** (`curl: (56)`, ~17 s). Direct egress works: `registry-1.docker.io/v2/` 401 in 2.9 s |
| Disk | 99 G total, **84 G used, 11 G free (90 %)**. `docker image prune -f` reclaimed 72 MB (my aborted build layer) and 0 B before that; the remaining 4 dangling images (5.3 GB) are held by four **stopped builder containers from earlier cycles** (6.2 GB total reclaimable). Not removed: the role permits pruning dangling images only |

### Hard blocker: two tasks request 8 CPUs on a 4-CPU VM

`docker run --cpus 8 …` → `range of CPUs is from 0.01 to 4.00, as there are only 4 CPUs available`.
`task.toml` `[environment]`/`[verifier.environment]` `cpus = 8` for **`formal-crypto`** and
**`shadow-relay`**, and 4 for `interleaved-vigenere`, `pretrain-shard-corruption`,
`protein-autointerp-disulfide` (exactly at the cap, fine). Neither 8-CPU task can start an env *or*
verifier container until the VM is enlarged or the per-task request drops to ≤4 — images are
irrelevant to this. This is the exact error class the 2026-11-08 partial run recorded for
`shadow-relay` (16 log hits); it is not a compose CPU request.

Memory is over-committed rather than rejected: `medical-claims-processing` asks 16,384 MB and
`html-js-filter`, `pretrain-shard-corruption`, `protein-autointerp-disulfide`, `vpp-loss-divergence`,
`intrastat-meldung`, `legacy-utility-triage` ask 8,192 MB against a 7.7 GiB VM. Docker allows it
(overcommit / OOM risk only); `html-js-filter` passed an oracle at 1.0 earlier, so this is a risk, not
a block.

### `formal-crypto` verifier build attempt (blocked, no image produced)

Command: `docker build --platform linux/arm64 -t tb-arm64-formal-crypto-verifier:latest
/tmp/fc-verifier-build` (build context = the source task's `tests/`, with digest-stripping,
`UV_HTTP_TIMEOUT=300` and `curl --retry` edits). Log: `formal-crypto-verifier-build.log`.

- Aborted at **step 6/15** after ~22 min: the in-container download of
  `Miniforge3-26.1.1-3-Linux-aarch64.sh` ran at **26–85 KB/s** (34 → 49 MB), i.e. the ~110 MB
  installer alone needs ~70 min; `conda create -n sageenv` then pulls a multi-GB SageMath 10.7 env
  (~640 KB/s measured from the host to conda-forge). ETA **60–90 min** plus ~5–8 GB peak against
  11 GB free.
- The earlier attempt (`/tmp/build-formal-crypto-verifier-retry.log`, 15:57–16:08) did get through
  step 12 and died exporting the SageMath layer:
  `failed to export layer: CreateDiff: mount callback failed … rename
  …/io.containerd.content.v1.content/ingest/…/data …/blobs/sha256/…: no such file or directory`
  — a containerd ingest/export failure on the largest layer, on a disk at 90 %.
- No proxy could be used: the prescribed `192.168.1.5:8899` CONNECT path is broken (above), and
  Docker does not inherit host networking.
- Even on success the image is unusable this cycle: `formal-crypto` is CPU-capped at 8 > 4.

Cleanup: build container gone, aborted layer pruned, disk back to 11 G free. No repo or `/tmp`
source files changed beyond the throwaway build context.

## Gate — PASS

`bash scripts/ci-local.sh` exit 0 (log: `ci-local.log`): typecheck pass; **168/168 tests, 0 fail**;
bundle build; `build:check` → “lib matches a fresh build”; fork guard pinned at `22ddee3792`
(patch surface matches expectations, 10 local files).

## Smoke — PASS

`OUT=bench/official/results/2026-11-08-smoke bash bench/official/terminal-bench/run-smoke.sh`
on `smoke/answer-42` (`tb-smoke-dsh:arm64`, model `deepseek/deepseek-flash`, commit `fb08b8d`):

| arm | score |
|---|---|
| oracle | **1.0** |
| graph (`dsh_agent:DshAgent`) | **1.0** |
| stock (`DSH_STOCK=1`) | **1.0** |

Evidence: `../2026-11-08-smoke/` (`README.md`, per-arm logs, `jobs/*/result.json`).

## product20 — NOT run

No product20 result was produced this cycle. The suite is not ready: 19/20 images, and two of the
19 are unrunnable on this VM (above). Per `automation/evaluator.md`, a full run also stays closed
while the MCP decision, CPU/image blockers and old-Node images remain open. Existing evidence is
unchanged: `../2026-11-08-product20-partial/` (invalid as an aggregate: 19/20 tasks, 11 graph /
3 stock valid, 2 paired-valid, all 0.0) and `../2026-11-08-oracle-control/` (3/3 real tasks at 1.0).

Do not cite any accuracy/parity/cost number from the partial run.

## Blockers

1. **CPU cap (hard)** — `formal-crypto` and `shadow-relay` need 8 CPUs; VM has 4. Fix: raise the
   Colima VM to ≥8 CPUs or lower those two tasks' `[environment].cpus`/`[verifier.environment].cpus`
   to ≤4 and record the change before scoring.
2. **`formal-crypto` verifier image** — build blocked by network throughput + disk headroom + the
   containerd layer-export failure; needs either a working proxy, a pre-warmed conda/uv cache, or
   more free disk (see 4) before a retry is worth the hour.
3. **Docker proxy** — prescribed `192.168.1.5:8899` aborts CONNECT; no daemon proxy configured.
   Builds rely on direct egress, which works but is throttled.
4. **Disk headroom** — 11 GB free (90 % used). 6.2 GB sits in stopped builder containers and 5.3 GB
   in the dangling images they hold; reclaiming it needs a prune beyond “dangling images only”
   (cleaner role).
5. **`shadow-relay` env overlay** — `/opt/node` + `/opt/dsh` absent, so the adapter must install
   Node + DSH from npm at trial start (needs in-container network; the 2026-11-08 run already hit an
   npm connect timeout on `intrastat-meldung`).
6. **MCP capability** — still undeclared/unimplemented; `medical-claims-processing` cannot run
   honestly.
7. **`heat-pump-warranty` sidecars** — sidecar images / Docker Hub TLS still unresolved (the arm64
   rewrite only covers the compose `main` service).
8. **Old-Node image** — `freight-dispatch-shift` still ships `/usr/bin/node` v20.19.2, but the
   overlay puts `/opt/node/bin/node` v24.9.0 first on PATH and npm prefix is `/opt/node`, so plain
   `node` invocations are likely mitigated. End-to-end unverified; treat as open until a real trial
   exercises the task.

**Readiness verdict:** gate and smoke pass, 19/20 images, but the suite is **not runnable end to
end**; no valid product20 aggregate exists and none was attempted.
