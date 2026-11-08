# Status — 2026-11-09

Architecture: **B**. `packages/loop` is a dedicated graph-loop plugin that replaces the stock
`agent-loop` through `AgentFactory`. No DSH source file is modified.

## Works today

| Layer | State |
|---|---|
| Install | `bash scripts/install-explore.sh [profile]` (default `web`) installs driver + Graph tab + Explore mode; verifies `agent-loop` disabled and `preset-explore` default |
| Mode | Explore preset registered; new sessions default to it |
| Kernel | `createKernel()` / `runPlan()` default to **LangGraph**; `MinimalKernel` fallback |
| Live driver | `KernelTopology` pauses before a node; DSH runs the step; kernel resumes. Coverage below |
| Composition | envelope / role resolution / capability composer live in dynamic mode |
| UI | Graph tab + `/graph-chat`; installed e2e passes |
| Packaging | tarball install + packed-loop runtime e2e passes; `build:check` reproducible |
| Tests | `npm test` **256/256** (0 fail, 0 skipped) on the current tree; three engines in the transition matrix |

## Kernel coverage (exact)

| Plan shape | Engine | Evidence |
|---|---|---|
| Linear chain | **LangGraph** | `test/unit/kernel-topology.test.ts` |
| Any control-edge condition: `artifact`, `noArtifact`, `fact`, `callFailed`, `budget` (step axis) | **LangGraph** (one shared evaluator; `routeKernelPlan` selects `state.next`) | `test/unit/transition-matrix.test.ts` (frontier + minimal + langgraph), `test/unit/kernel-topology.test.ts` |
| Composed plans (per-stage success / no-progress / repair / budget exits) | **LangGraph** | `test/unit/transition-matrix.test.ts` (frontier + minimal + langgraph), `test/unit/scheduler.test.ts` |
| Parallel fan-out / join | `FrontierTopology` (a forward join waits for every entered predecessor, depth-2+ branches included; retry back-edges still re-enter; a join on a cycle runs once per iteration) | `test/unit/transition-matrix.test.ts`, `test/unit/topology.test.ts` |
| Subagent batches | `FrontierTopology` | `test/unit/scheduler.test.ts` |
| Condition on a data edge | `FrontierTopology`; rejected by `validateTaskPlan` (`P023`) | `test/unit/transition-matrix.test.ts` |
| Reserved / nonconforming node ids | `FrontierTopology` | `canKernelDrive()` rejects them |

Only the `budget` **step** axis is routed. `maxTokens` / `maxWallMs` are declared plan capacity with
no consumption producer, so token/wall budget conditions were removed from `Condition` and are
rejected by `validateTaskPlan` (`P022`) instead of silently never firing.

A non-zero shell exit (`[exit code: N]`) is a normal DSH result, not a tool-invocation error. The
runtime folds it into the step-scoped `verificationFailed` fact and a `verificationRan` fact; the
composed verify stage repairs when verification failed **or** never ran. `verificationRan` requires
the node's planned verification tool to have run, so a verify step filled by `read` (or any other
non-verification tool) repairs, an inspect/mutate step that runs `grep`/`diff` (exit 1) is not sent
to repair, and a no-tool verify is not read as a pass.
`lastOk` stays about tool invocation. Every composed stage also classifies its own progress with a
step-scoped fact (`hadToolCall` for discover, `readFile`, `wroteFile`, `produced.<artifact>` for the
author's declared artifact type) and has a no-progress exit to its repair node, so no stage advances
on a false success. Failure exits are declared before the budget exit, so a stage that fails at the
answer reserve repairs instead of becoming the answer. The kernel adapter also reserves the one step
a budget-routed wrap-up node needs; the frontier stops at the plan's step cap, which only differs for
a guard that fires with zero steps left.

No claim is made that LangGraph executes arbitrary graphs.

## Evidence

**Product evidence is incomplete: no aggregate exists for the repaired instrument.** The active suite
is Terminal-Bench easy10 + medium10
([`bench/official/subsets/product20.json`](../bench/official/subsets/product20.json)). The tracked
**historical** 2026-11-08 partial run
([result](../bench/official/results/2026-11-08-product20-partial/README.md)) was taken on the
pre-repair instrument and attempted **19/20** tasks (`formal-crypto` had no verifier image):
**11 graph / 3 stock** valid trials, only **2 paired-valid** tasks (`bun-sourcemap-leak`,
`cargo-flight-dispatch`), and every valid score is **0.0**. It is invalid as a product aggregate; no
accuracy, parity, token or cost number from it is citable.

The reward is binary, so 0.0 does not mean both arms did nothing: stock passed **35/37** verifier
criteria on `bun-sourcemap-leak` (graph 18/37) and **33/40** on `cargo-flight-dispatch` (graph
32/40). The graph arm in that run used the **pre-fix** five-step chain (`n_inspect -> n_mutate ->
n_mutate -> n_verify -> n_answer`), whose `n_answer` removed every tool and ended the turn after
one step (80 vs 217 session records). That plan shape is historical: the composer now emits
per-stage repair/budget exits and a tool-enabled answer, so a rerun is required before any
stock-vs-graph comparison. The partial run's own numbers remain invalid, not a current comparison;
see the partial-run README for the node sequence and counts.

A three-task oracle control
([result](../bench/official/results/2026-11-08-oracle-control/README.md)) scores **1.0** on
`html-js-filter`, `cargo-flight-dispatch` and `music-harmony`; the task harness (image, verifier,
scoring) can produce a pass on those tasks, so a 0.0 is not by itself evidence about the loop. The earlier single-task
[`2026-11-08-html-js-filter`](../bench/official/results/2026-11-08-html-js-filter/README.md) run and
the partial run disagree on that task's stock arm (the partial stock attempt timed out at 900 s);
both are task-level evidence, neither is an aggregate.

The last pre-repair evaluator pass
([`2026-11-08-eval-1525`](../bench/official/results/2026-11-08-eval-1525/README.md), HEAD `f28de84`)
recorded 20/20 env images, 19/20 verifier images (`formal-crypto` was still missing), `ci-local.sh`
PASS at 253/253 tests and a passing smoke (1.0/1.0/1.0). A post-eval fix `63b5f20` narrowed
`verificationRan` to the node's planned verification tool and is 256/256 at the cheap gate. That
record is historical.

On **2026-11-09** the instrument was repaired
([readiness note](../bench/official/results/2026-11-09-product20-prep/README.md)): **20/20 env and
20/20 verifier images** including a built `formal-crypto` verifier (SageMath 10.7 / Python 3.12.14;
its direct `--cpus 8` check passed), Colima **8 vCPU / 20 GiB / 150 GiB**, every env image overlaid
from `tb-dsh-base` (Node v24.9.0 + DSH 0.2.2-rc.1), product20 sidecars pulled, the Docker daemon
proxy (inside Colima) repointed to the current host LAN IP, `dist/dsh-graph-loop-bench.tgz` at
`f7a961a797ca5e17…` (223,458 B), and smoke 1.0/1.0/1.0
([record](../bench/official/results/2026-11-09-smoke-prep/README.md)).

The bounded four-task pre-run diagnostic first ran at HEAD `5cae65c`
([result](../bench/official/results/2026-11-09-prediag-0122/README.md), 01:46 → 03:22) and failed on
two infrastructure faults: `vpp-loss-divergence` had an empty `/opt/verifier_pristine` because the
legacy builder dropped the Dockerfile heredoc, and `medical-claims-processing` never started because
its vendor `playwright-mcp` sidecar is amd64-only and Chrome never opened CDP 9222 under qemu.
`intrastat-meldung` (0/47 graph, 42/47 stock) and `heat-pump-warranty` (1/21, 16/21) were already
valid near-misses.

Both faults were then repaired and the four tasks were rerun
([final table](../bench/official/results/2026-11-09-prediag-fixes/README.md)):

| task | graph | stock | verdict |
|---|---|---|---|
| `vpp-loss-divergence` | 1 trial, 4/5 | 1 trial, 4/5 (56m57s) | valid; only `test_losses_match_reference` failed |
| `intrastat-meldung` | 1 trial, 0/47 | 1 trial, 42/47 | valid near-misses |
| `heat-pump-warranty` | 1 trial, 1/21 | 1 trial, 16/21 | valid near-misses |
| `medical-claims-processing` | 1 trial, 2/27 | 1 trial, 22/27 | valid (arm64 sidecar) |

All eight rows have `n_trials: 1` and `n_errors: 0`; **the readiness gate now passes**. Rewards are
still 0.0 because reward is binary, so the criteria are the diagnostic. The vpp images were patched
out-of-band (the repo build script still uses the legacy builder and would reproduce the heredoc
defect on a canonical rebuild), and the medical task's prepared compose points at a local arm64
sidecar tag. The full product20 run is now allowed but has **not been started**; there is no product
aggregate.

The former local 20-task run is not part of this tree and is not citable as current evidence.

## Known gaps

1. **Durable checkpoints**: `MemoryCheckpointer` only; no `storageDomain` saver, no restart resume.
   The blocker is the consumer (replay/time-travel), not storage availability.
2. **Kernel breadth**: parallel fan-out/join, subagent batches, conditions on data edges and
   reserved/nonconforming node ids still use `FrontierTopology`. `maxTokens`/`maxWallMs` are declared
   capacity, not routed budget axes. The frontier now waits for every entered predecessor before a
   forward join (depth-2+ diamonds included) and a join on a cycle runs once per iteration, but only
   the frontier executes fan-out at all.
3. **Budget boundary**: the kernel adapter reserves one extra step for a budget-routed wrap-up node;
   the frontier stops at the plan's step cap. Composed plans target `ANSWER_RESERVE_STEPS` (2), so
   both engines have room in practice; one rule in both engines is still open.
4. **Product20 blocked (the 2026-11-09 diagnostic gate failed) and the remaining termination work.**
   The instrument is repaired (above), so the historical 2026-11-08 blockers — 900 s fixed timeout,
   missing `formal-crypto` verifier, `cpus = 8` requests on a 4-CPU VM, missing shadow overlay,
   sidecar TLS, old-Node images — are fixed; do not re-report them as current without checking. Two
   blockers remain, both infrastructure: `medical-claims-processing` cannot start because its
   `playwright-mcp` sidecar is amd64 under qemu and never turns healthy (it needs an arm64-native
   sidecar or a different health gate, not a DSH change), and `vpp-loss-divergence` needs a
   reproducible verifier image — the canonical `build-arm64-task.sh` still uses the legacy builder,
   which drops the heredoc patches, so the repaired images are local only. The diagnostic's other two
   tasks (`intrastat-meldung`, `heat-pump-warranty`) produced valid near-miss trials on the repaired
   instrument. The pre-fix plan's tool-stripping is fixed: the composed answer keeps its tools and an
   exhausted plan gets a continuation step. That continuation is a graph-to-stock hand-off (one
   `fallbackPlan` node, `maxReplans: 0`) bounded by the per-turn `maxSteps`, not graph routing;
   decide whether that is the intended contract before comparing arms.
5. **Fork debt**: source copy of DSH's loop; enforced by `scripts/diff-upstream.sh --check`.
6. **Benchmark heuristics off by default** (`benchGuards: false`); they are harness-specific.

## Next

1. Unblock `medical-claims-processing`: an arm64-native Playwright/Chromium sidecar image (or a
   compose health gate that does not require CDP 9222), so a trial can exist at all. The separate
   MCP-adapter limitation only matters once a trial runs.
2. Make the vpp repair reproducible: force BuildKit/`docker buildx` (or convert the heredoc patch) in
   `bench/official/terminal-bench/build-arm64-task.sh`, rebuild both vpp images, and get a valid
   stock trial (the graph retest is already criteria 4/5).
3. Re-run the four-task diagnostic from [`automation/evaluator.md`](../automation/evaluator.md) — the
   gate is `n_trials >= 1` on every row. Only then run product20 (background it; report status and
   the live result path) and report aggregate accuracy, prompt tokens, billed cost and steps.
4. Only after those numbers exist: decide whether the graph loop has a product claim.
5. Then durable checkpoint consumer and kernel breadth.

## Commands

```sh
npm run typecheck
npm test
npm run build && npm run build:check
bash scripts/ci-local.sh
bash scripts/install-explore.sh
bash scripts/verify-all.sh
bash scripts/diff-upstream.sh --check
bash bench/official/terminal-bench/preflight.sh
bash bench/official/terminal-bench/run-smoke.sh
TASKS_DIR=/tmp/tb-arm-dsh bash bench/official/subsets/run-product20.sh
```
