# Status — 2026-11-09

Architecture: **B**. `packages/loop` is a dedicated graph-loop plugin that replaces the stock
`agent-loop` through `AgentFactory`. No DSH source file is modified.

## Current benchmark state

**The corrected full product20 is aborted at 5/40 (2026-11-09 19:44 +08); no aggregate exists.**
The graph arm hit the stage-routing bug fixed at `4561008`, so the run was stopped and its five rows
are **not citable** ([`ABORTED.md`](../bench/official/results/2026-11-09-product20b/ABORTED.md)). No
liveness signal remains: `/tmp/product20-shard-full.log` ends `_EXIT`, PID `61129` is dead, both
`bench/official/results/*/runner.pid` PIDs are dead, and no Harbor `__env` container is running. The
run executed `da3d598` (every row carries it) with the tarball
`f7a961a797ca5e17fdd68d52c0bd6dfeec50ec4151f42d84bbd7405069b12064` (223,458 B, pre-HEAD). Do not
merge, score or cite those rows, and never point a new `OUT_DIR` at
`bench/official/results/2026-11-09-product20b/` (`run-subset.sh` truncates `rows.jsonl`).

The earlier full run (started 04:18:32 +08 as PID `38616` in
`bench/official/results/2026-11-09-product20/`) was **stopped at 31/40** and is **NOT CITABLE**:
[`INVALID.md`](../bench/official/results/2026-11-09-product20/INVALID.md) names the 6 `TRANSPORT`
crashes and the 6 file-policy-capped trials; its rows are preserved as evidence of the broken
instrument. Do not merge them into any later run.

**No benchmark is live.** Before any rerun: (1) repack `dist/dsh-graph-loop-bench.tgz` from HEAD
(the dist bundle is the pre-fix `f7a961…`; a HEAD pack is 225,595 B / `45de8539…` and contains
`toolSucceeded`), (2) run a bounded post-HEAD real-model pre-run on the new tarball that includes a
shell-write/routing task (audit 2026-11-09T13:19 P0-2/P0-3), and (3) only
then start product20 with a fresh `OUT_DIR`. The 2026-11-09 smoke and four-task diagnostic installed
the pre-fix plugin and do not cover `4561008`. **No aggregate, accuracy, parity, token or cost
number is citable** until all 20 tasks have `n_trials >= 1`, the runner exits, **and every trial
passes the validity test** in [`docs/EVALUATION.md`](EVALUATION.md#trial-validity) (healthy agent
terminal; every declared artifact path writable). The `da3d598` fix removes the `/app` sandbox cap,
but the per-trial `write_capped` field is still absent, so confirm the policy from each trial's
session log. vpp/medical are repaired locally for this environment (see Known gaps 4) — do not
rebuild either or reset the task dirs before the builder/compose fixes land.

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
| Tests | `npm test` **277/277** (0 fail, 0 skipped) on the current tree; three engines in the transition matrix |

## Kernel coverage (exact)

| Plan shape | Engine | Evidence |
|---|---|---|
| Linear chain | **LangGraph** | `test/unit/kernel-topology.test.ts` |
| Any control-edge condition: `artifact`, `noArtifact`, `fact`, `callFailed`, `budget` (step axis) | **LangGraph** (one shared evaluator; `routeKernelPlan` selects `state.next`) | `test/unit/transition-matrix.test.ts` (frontier + minimal + langgraph), `test/unit/kernel-topology.test.ts` |
| Composed plans (per-stage success / no-progress / repair / budget exits) | **LangGraph** | `test/unit/transition-matrix.test.ts` (frontier + minimal + langgraph), `test/unit/scheduler.test.ts` |
| Parallel fan-out / join | `FrontierTopology` (a forward join waits for every entered predecessor, depth-2+ branches included; retry back-edges still re-enter; a join on a cycle runs once per iteration) | `test/unit/transition-matrix.test.ts`, `test/unit/topology.test.ts` |
| Subagent batches | `FrontierTopology` | `test/unit/scheduler.test.ts` |
| Condition on a data edge | **Neither engine** routes it; `validateTaskPlan` rejects the plan (`P023`) | `test/unit/transition-matrix.test.ts` |
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
`lastOk` stays about tool invocation.

**Composed routing policy at `4561008`** (`packages/core/src/compose.ts:459-491`). Each stage
declares, in evaluation order: (1) a **budget exit** to the tool-enabled `n_answer` at
`remainingAtMost: 2`; (2) its failure exits — `callFailed`, `lastOk=false` and its own no-progress
guards — to **one repair node**; (3) its success guard to the next stage (or the answer). The repair
node mirrors the budget/failure exits to `n_answer`, carries the same success edge and ends with an
unconditional answer fallback; there is **no repair→stage back-edge**, so a stage gets exactly one
repair attempt and the tool-enabled answer continues abandoned work. Success guards are step-scoped:
`toolSucceeded` for discover/inspect (any successful tool call, including shell and third-party
tools), the shell-aware `wroteFile` for mutate, `produced.<artifact>` for author, and
`verificationRan`/`verificationFailed` for verify. The benchmark mutation retry is keyed by node,
not by turn. A frontier that exhausts its step budget reports `done` only when it reached a
terminal, otherwise `failed`.

**Reserve boundary.** Because the budget exit is declared first, a stage that keeps failing at the
answer reserve goes to `n_answer` instead of repairing forever. `n_answer` is a **continuation, not
a success claim**: the turn machine reports `done`, but the failed verify step's tool output
(`[exit code: N]`) remains in the node trail and session log (its step-scoped
`verificationFailed` fact is what routed it), and the
answer step is instructed to finish abandoned work and report risk. This is the shipped contract
pinned by `test/unit/transition-matrix.test.ts` ("at maxSteps 5 a failed verify reaches the answer,
not a repair dead end"). The pre-`4561008` failure-before-budget order was the dead end and is not
current.

The kernel adapter also reserves the one step a budget-routed wrap-up node needs; the frontier stops
at the plan's step cap, which only differs for a guard that fires with zero steps left.

No claim is made that LangGraph executes arbitrary graphs.

## Evidence

**Product evidence is incomplete: the full product20 was aborted at 5/40 and no aggregate exists for
the repaired instrument.** The active suite is Terminal-Bench easy10 + medium10
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
([historical readiness snapshot](../bench/official/results/2026-11-09-product20-prep/README.md)):
**20/20 env and 20/20 verifier images** including a built `formal-crypto` verifier (SageMath 10.7 /
Python 3.12.14; its direct `--cpus 8` check passed), Colima **8 vCPU / 20 GiB / 150 GiB**, every env
image overlaid from `tb-dsh-base` (Node v24.9.0 + DSH 0.2.2-rc.1), product20 sidecars pulled, the
Docker daemon proxy (inside Colima) repointed to the current host LAN IP,
`dist/dsh-graph-loop-bench.tgz` at `f7a961a797ca5e17…` (223,458 B), and smoke 1.0/1.0/1.0
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
| `vpp-loss-divergence` | 1 trial, 4/5 | 1 trial, 4/5 (56m57s) | Harbor-valid but **capped at the time** by the file policy (4/5 was the ceiling) |
| `intrastat-meldung` | 1 trial, 0/47 | 1 trial, 42/47 | Harbor-valid but **capped at the time** (`/workspace/out` denied) |
| `heat-pump-warranty` | 1 trial, 1/21 | 1 trial, 16/21 | valid near-misses |
| `medical-claims-processing` | 1 trial, 2/27 | 1 trial, 22/27 | valid (arm64 sidecar) |

All eight rows have `n_trials: 1` and `n_errors: 0`; **the readiness gate passed**. Rewards are
still 0.0 because reward is binary, so the criteria are the diagnostic. **Caveat added
2026-11-09T13:35Z:** `n_trials: 1` is not full validity — intrastat and vpp failed the
artifact-writable clause of [`docs/EVALUATION.md`](EVALUATION.md#trial-validity) **when measured**,
so their counts are ceilings for both arms, and intrastat's 0/47 (graph) or 42/47 (stock) and vpp's
4/5 must not be read as capability. That cap was **fixed at `da3d598`** (both arms now run under
`sandbox-policy: danger-full-access`; the per-trial `write_capped` probe is still deferred) —
re-measure intrastat/vpp from a future completed run's rows, not from this table or from the
aborted `product20b` rows. heat-pump and medical
write inside `/app` and were unaffected. The vpp images were patched out-of-band (the repo build
script still uses the legacy builder and would reproduce the heredoc defect on a canonical rebuild),
and the medical task's prepared compose points at a local arm64 sidecar tag. The corrected full
product20 was **aborted at 5/40** (PID `61129`, OUT_DIR
`bench/official/results/2026-11-09-product20b/`, stopped 2026-11-09 19:44 +08; see Current
benchmark state); there is no product aggregate. The vpp/medical repairs are local to this
environment and are deferred code debt.

The former local 20-task run is not part of this tree and is not citable as current evidence.

## Known gaps

1. **Durable checkpoints**: `MemoryCheckpointer` only; no `storageDomain` saver, no restart resume.
   The blocker is the consumer (replay/time-travel), not storage availability.
2. **Kernel breadth**: parallel fan-out/join, subagent batches and reserved/nonconforming node ids
   still use `FrontierTopology`; a condition on a data edge is rejected by `validateTaskPlan` because
   neither engine routes it. `maxTokens`/`maxWallMs` are declared capacity, not routed budget axes.
   The frontier now waits for every entered predecessor before a forward join (depth-2+ diamonds
   included) and a join on a cycle runs once per iteration, but only the frontier executes fan-out at
   all.
3. **Budget boundary**: the kernel adapter reserves one extra step for a budget-routed wrap-up node;
   the frontier stops at the plan's step cap. Composed plans target `ANSWER_RESERVE_STEPS` (2), so
   both engines have room in practice; one rule in both engines is still open.
4. **Product20 aborted; aggregate pending; repair debt deferred.** The instrument is repaired
   (above), so the historical 2026-11-08 blockers — 900 s fixed timeout, missing `formal-crypto`
   verifier, `cpus = 8` requests on a 4-CPU VM, missing shadow overlay, sidecar TLS, old-Node
   images — are fixed; do not re-report them as current without checking. The 2026-11-09 diagnostic
   found two infrastructure faults, both repaired **locally only**: `medical-claims-processing` now
   runs on an arm64-native Playwright sidecar, but its compose image tag is a local edit that a
   task-dir reset loses; `vpp-loss-divergence` images were patched out-of-band, but the canonical
   `build-arm64-task.sh` still uses the legacy builder, which drops the heredoc patches. Both code
   fixes (a scripted medical compose patch, BuildKit/de-heredoc plus rebuild and re-verify) are
   deferred; the runner is stopped, but do not rebuild or reset the task dirs before those fixes
   land. The pre-fix plan's tool-stripping is fixed: the composed
   answer keeps its tools and an exhausted plan gets a continuation step. That continuation is a
   graph-to-stock hand-off (one `fallbackPlan` node, `maxReplans: 0`) bounded by the per-turn
   `maxSteps`, not graph routing; decide whether that is the intended contract before comparing arms.
   **Third instrument defect — fixed at `da3d598`:** the Harbor adapter used to run DSH under the
   default `workspace-write` file policy rooted at `/app`, so both arms were denied
   `intrastat-meldung`'s `/workspace/out`, `roy-polymorph-cn`'s `/results` and
   `vpp-loss-divergence`'s installed `site-packages` writes, and `freight-dispatch-shift`
   (`/workspace/dispatch`) would have been too. Both arms now receive a shared
   `sandbox-policy: danger-full-access` profile patch (the trial is the disposable container), verified
   by the post-fix smoke in both agent sessions. What remains deferred is the per-trial `write_capped`
   field / writable-artifact readiness probe, documented in
   [`docs/EVALUATION.md`](EVALUATION.md#instrument-defects-open).
5. **Fork debt**: source copy of DSH's loop; enforced by `scripts/diff-upstream.sh --check`.
6. **Benchmark heuristics off by default** (`benchGuards: false`); they are harness-specific.

## Next

1. Repack `dist/dsh-graph-loop-bench.tgz` from HEAD (audit `20261109-1319` P0-2) and record its
   size/sha; the current dist is the pre-fix `f7a961…` bundle. Do not launch any run before this.
2. Run the bounded post-HEAD gate on the new tarball into a **new** `OUT_DIR`: the smoke gate plus a
   real-model check that includes at least one shell-write/routing task (audit P0-3). The aborted
   `product20b` rows and the pre-HEAD smoke/diagnostic are not a substitute.
3. Only then start product20 with a fresh `OUT_DIR`. Verify every task has `n_trials >= 1`; a
   `n_trials: 0` row is infrastructure, not a score. Then apply the full validity test
   ([`docs/EVALUATION.md`](EVALUATION.md#trial-validity)): no `TRANSPORT`/agent exit 1 other than
   `GRAPH_FAILED`, and every declared artifact path writable (the policy is fixed; the row's
   `write_capped` field is still absent, so check the trial sessions). Produce the aggregate from
   the completed run's `rows.jsonl`, naming its executed commit and tarball sha256; use only valid
   trials and no partial rows. `GRAPH_FAILED` remains a Harbor-valid agent terminal but is a
   graph/kernel fault after `4561008` — report it separately and treat a run containing one as
   non-citable until investigated.
4. After a completed run: make the vpp repair reproducible (BuildKit/`docker buildx` or
   de-heredoc), rebuild and re-verify both arms, and script/re-apply the medical arm64 sidecar
   compose patch before any task-dir reset. Do not rebuild while a benchmark is live; none is live
   now, but the builder defect must be fixed first.
5. Only after those numbers exist: decide whether the graph loop has a product claim.
6. Then durable checkpoint consumer and kernel breadth.

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
