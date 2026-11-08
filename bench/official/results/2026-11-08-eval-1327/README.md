# Evaluation — cycle `20261108-1327` (HEAD `823aa68`)

Fresh evaluator pass on `/Users/zhinan/Documents/dsh_workspace/dsh-graph-loop`, HEAD
`823aa6894e17e5bc65312feddc825b0df05a6773`, working tree clean. No product20 run. Writes are
limited to this directory, the sibling smoke directory
(`../2026-11-08-smoke-1327/`), and a `/tmp` tarball/build; no product source, test or docs were
edited.

Host: Colima aarch64, Docker (legacy builder), VM **4 vCPU / 8,307,163,136 B**. Harbor 0.25.0.
DSH `0.2.2-rc.1` (adapter pin), Node 24.9.0.

## Readiness

| Item | State |
|---|---|
| 20 env images `tb-arm64-<task>-env:latest` | **20/20 present**, `linux/arm64` |
| 20 verifier images `tb-arm64-<task>-verifier:latest` | **19/20**; **`formal-crypto` missing** |
| `tb-dsh-base:latest` | present, `linux/arm64`, 455,806,839 B |
| `dist/dsh-graph-loop-bench.tgz` | **present but stale** (see below) |
| Prepared task dirs `/tmp/tb-arm-dsh` | all **20** suite tasks have `task.toml`; one extra leftover `payments-pipeline-fix` (not in the suite) |
| Disk `colima ssh -- df -h /var/lib/docker` | 99 G total, **84 G used, 11 G free (90 %)**; not pruned |
| Docker proxy | not configured; `192.168.1.5:8899` remains dead (CONNECT aborts). Direct egress works (`registry.npmjs.org` 200 in 3.0 s) |
| Node/DSH overlay | verified in the smoke run; **`shadow-relay` env still lacks** `/opt/node/bin/node` and `/opt/dsh/bin/dsh` (checked with `docker run --rm --entrypoint sh`), so it would bootstrap Node+DSH over the network |

### Tarball is stale for `823aa68`

`dist/dsh-graph-loop-bench.tgz` was packed at 11:00 (+08), before this increment; it is 213,558 B,
sha256 `de483a673e4ee5f0cbb8df3fc2be0c10db95e13b04c7dabd1ceea73b945f2278`, and its
`lib/index.js` is 787,300 B against 798,959 B in `packages/loop/lib/`. `run-subset.sh` and
`run-smoke.sh` default to it with no rebuild step, so a product20 run today would install the
**pre-increment** plugin. For this evaluation I packed `packages/loop` at HEAD into
`/tmp/dsh-bench-tarball/dsh-graph-loop-0.2.0.tgz` (220,087 B, sha256
`499d89acb96471b4d8425e0cb8048a02abc5ec3df1b9a1f7b970e44f075487ff`) and pointed the smoke at it;
the packed `lib/index.js` is byte-identical to the fresh build. **Before any product20, `dist/`
must be repacked from `packages/loop`.**

## Cheap gate — PASS

`bash scripts/ci-local.sh` exit 0 (log: `ci-local.log`):

| Step | Result |
|---|---|
| typecheck | pass |
| unit tests | **204/204 pass**, 0 fail (~0.5 s) |
| build | pass (`packages/{loop,graph-ui,mode}/lib`) |
| build:check | “lib matches a fresh build of the source” |
| fork surface guard | pass, checkout `dsh-v0.2.1-rc.3-1533-g22ddee3792`, pin `22ddee3792`, 10 expected local files |

## Smoke — PASS

`OUT=…/2026-11-08-smoke-1327 DSH_PLUGIN_TARBALL=/tmp/dsh-bench-tarball/dsh-graph-loop-0.2.0.tgz
bash bench/official/terminal-bench/run-smoke.sh`:

| arm | score | runtime |
|---|---|---|
| oracle | **1.0** | 11 s |
| graph (`dsh_agent:DshAgent`) | **1.0** | 1 m 22 s |
| stock (`DSH_STOCK=1`) | **1.0** | 20 s |

Evidence in `../2026-11-08-smoke-1327/` (README, per-arm logs, `jobs/*/result.json`, trial dirs).
The graph arm's `dsh-stdout.log` shows the composed inspect → mutate → verify → answer pipeline
executing live (one bench-retry correction in mutate, verify shell `cmp` exit 0, no repair) and
scoring 1.0 — the cycle's condition/join/verify changes did not break the live path.

## Focus: are the `823aa68` claims real?

**Transition matrix — yes.** `test/unit/transition-matrix.test.ts` (602 lines) runs **18/18
pass** standalone and inside the 204. It covers, against the code actually in this commit:

- same plan/outcome stream through `FrontierTopology` and `KernelTopology` for `artifact`,
  `noArtifact`, `fact` (both outcomes), compared node-by-node;
- diamond fan-in join (`a -> b -> c -> d`, join once) and a research subagent fan-out whose
  `d_answer` join runs once, through the live turn driver;
- composed verify failing **twice** by `[exit code: N]` (a normal result, `ok: true`) then passing,
  through `createGraphTurnDriver` with both `kernel: 'minimal'` and `kernel: 'off'`, asserting
  `n_verify -> n_verify_repair` twice and no boundary replan;
- a non-verify (mutate) stage whose shell exits 1 not being sent to repair;
- third-party author: declared-artifact success, tool failure, no-artifact (no tool), wrong-tool
  (read only) and an earlier stage's run-cumulative `file.text` not satisfying a later author;
- budget at `maxSteps - 1`, `maxSteps - 2`, and the last planned step (kernel adapter reserve
  driven directly and through the driver; frontier hard-stop documented);
- rejection of token/wall budget guards (`P022`), data-edge guards (`P023`) and a model proposal
  with a removed axis.

**Join de-duplication** (`topology.ts`): `enqueue(target, source)` skips a forward edge whose
target is already queued/completed, and allows re-entry only when `target` can reach `source` over
control edges (a cycle). Repair loops are cycles, so they still re-enter; the composed twice-fail
test proves it, and the existing mutation/cycle topology tests stay green. Researched residual
below.

**Verify/step scoping** (`step-facts.ts`, `scheduler.ts`, `compose.ts`): `lastOk` is tool-invocation
semantics again; `[exit code: N]` is folded into a step-scoped `verificationFailed`, written on
every step, and only the composed verify stage consumes it (`verificationFailed=false -> next`,
`=true -> repair`) while the generic `lastOk=false -> repair` edge remains for tool errors.
`producedArtifact` is written on every step (true *and* false), and declared capability artifacts
are credited only when the planned capability's tool (`capability.tool.name`) is among the
successful calls. All three are covered by the matrix.

**Budget reserve** moved from the scheduler into `KernelTopology` (`budgetReserveSteps(plan)` = 1
when the plan has a budget edge); a direct adapter with `plan.budget.maxSteps` now keeps the
budget-routed wrap-up node instead of letting the host run and discard it (tested both directly
and via the driver).

The 18 matrix tests are genuine and the 204-test gate includes them. The cycle's changes did not
break the live smoke.

### Residual observations (not blockers for this cycle)

- Cross-engine parity and the composed verify/repair matrix drive the **minimal** kernel (and the
  frontier). The `langgraph` runtime is covered by the existing `kernel-*.test.ts` suite and by the
  live smoke's success path, but the composed verify-failure/repair path is not run through
  `langgraph` in the matrix. The routing code is shared (`routeKernelPlan`), so this is a coverage
  gap rather than a suspected defect.
- Budget boundary: the kernel now reserves one step (may run one node past the declared budget),
  while the frontier still hard-stops at the plan cap; the matrix asserts these differing
  behaviours explicitly. The runtime bug (node run then discarded) is fixed in the adapter, but
  the audit's “one rule in the engines” is only partially satisfied.
- `enqueue` would skip a retry modelled as a non-cyclic jump to an earlier completed node; all
  realistic repair shapes in the code/tests are cycles. Documented behaviour, not exercised.
- `dist/` tarball staleness (above) is the concrete readiness gap for a product run.

## product20 — NOT run (not ready)

No full product20 was started. It is not ready:

1. **`formal-crypto` verifier image is missing** (19/20), and building it is blocked by the same
   CPU cap, slow SageMath download and an 11 G disk.
2. **CPU cap:** `formal-crypto` and `shadow-relay` request `cpus = 8` in `[environment]` and
   `[verifier.environment]` against a 4-CPU VM (`range of CPUs is from 0.01 to 4.00`), so neither
   task’s env or verifier can start.
3. **`dist/dsh-graph-loop-bench.tgz` is stale** for `823aa68`; repack before any run.
4. Known runtime blockers are unchanged: `medical-claims-processing` needs MCP servers the adapter
   does not start, `heat-pump-warranty` missed sidecars / Docker Hub, `freight-dispatch-shift`
   ships Node 20.19.2 (no `node:sqlite`), `intrastat-meldung` npm connectivity,
   `vpp-loss-divergence` reward-file loss.
5. Disk 11 G free (90 %); Docker proxy `192.168.1.5:8899` dead (direct egress works).
6. `shadow-relay` env lacks the Node/DSH overlay (network bootstrap; CPU-blocked anyway).

No aggregate exists: the tracked 2026-11-08 partial run remains invalid as an aggregate (and is
labelled “measured the pre-fix plan”); this cycle produced no product rows.

## Paths

- Smoke: `bench/official/results/2026-11-08-smoke-1327/` (README, logs, `jobs/`).
- Gate log: `bench/official/results/2026-11-08-eval-1327/ci-local.log`.
- This note: `bench/official/results/2026-11-08-eval-1327/README.md`.
- Real-task validity baseline: `bench/official/results/2026-11-08-oracle-control/` (3/3 at 1.0).

No push/publish; no DSH source edits.
