# Status — 2026-11-08

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
| Tests | `npm test` **253/253** (0 fail, 0 skipped) on the current tree; three engines in the transition matrix |

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
composed verify stage repairs when verification failed **or** never ran, so an inspect/mutate step
that runs `grep`/`diff` (exit 1) is not sent to repair and a no-tool verify is not read as a pass.
`lastOk` stays about tool invocation. Every composed stage also classifies its own progress with a
step-scoped fact (`hadToolCall` for discover, `readFile`, `wroteFile`, `produced.<artifact>` for the
author's declared artifact type) and has a no-progress exit to its repair node, so no stage advances
on a false success. Failure exits are declared before the budget exit, so a stage that fails at the
answer reserve repairs instead of becoming the answer. The kernel adapter also reserves the one step
a budget-routed wrap-up node needs; the frontier stops at the plan's step cap, which only differs for
a guard that fires with zero steps left.

No claim is made that LangGraph executes arbitrary graphs.

## Evidence

**Product evidence is incomplete and its only aggregate is invalid.** The active suite is
Terminal-Bench easy10 + medium10
([`bench/official/subsets/product20.json`](../bench/official/subsets/product20.json)). The tracked
2026-11-08 partial run
([result](../bench/official/results/2026-11-08-product20-partial/README.md)) attempted **19/20**
tasks (`formal-crypto` has no verifier image): **11 graph / 3 stock** valid trials, only **2
paired-valid** tasks (`bun-sourcemap-leak`, `cargo-flight-dispatch`), and every valid score is
**0.0**. It is invalid as a product aggregate, and the instrument is unvalidated for the full
suite — no accuracy, parity, token or cost number from it is citable.

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

The latest evaluator pass
([`2026-11-08-eval-1327`](../bench/official/results/2026-11-08-eval-1327/README.md), HEAD `823aa68`)
records 20/20 env images, 19/20 verifier images (`formal-crypto` still missing), `ci-local.sh` PASS
at **204/204** tests (the figure at `823aa68`; the current tree runs 253/253, see the Tests row of
"Works today") and a passing three-arm smoke
([`2026-11-08-smoke-1327`](../bench/official/results/2026-11-08-smoke-1327/README.md): 1.0 oracle /
1.0 graph / 1.0 stock on a fresh `823aa68` tarball); product20 was not run, so no aggregate changed.
`dist/dsh-graph-loop-bench.tgz` was repacked from `packages/loop` at `823aa68` (220,087 B, sha256
`499d89ac…`); `run-smoke.sh` and `run-subset.sh` do not rebuild it, so repack before any product20
run.

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
4. **Product20 blocked on the instrument and on the remaining termination work**: the 2026-11-08
   run spent most stock arms on a 900 s fixed timeout; `formal-crypto` and `shadow-relay` request
   `cpus = 8` in `task.toml` against this 4-CPU VM; it also hit image pull/TLS
   (`heat-pump-warranty`), missing MCP startup (`medical-claims-processing`), npm bootstrap
   (`intrastat-meldung`), and an old-Node `node:sqlite` import (`freight-dispatch-shift`). The
   timeout policy is now per-task `[agent].timeout_sec` with `DSH_AGENT_TIMEOUT_CAP` as an override;
   see [`EVALUATION.md`](EVALUATION.md). The pre-fix plan's tool-stripping is fixed: the composed
   answer keeps its tools and an exhausted plan gets a continuation step. That continuation is a
   graph-to-stock hand-off (one `fallbackPlan` node, `maxReplans: 0`) bounded by the per-turn
   `maxSteps`, not graph routing; decide whether that is the intended contract before comparing
   arms.
5. **Fork debt**: source copy of DSH's loop; enforced by `scripts/diff-upstream.sh --check`.
6. **Benchmark heuristics off by default** (`benchGuards: false`); they are harness-specific.

## Next

1. Fix or exclude the per-task harness blockers above (MCP, sidecar images/CPU, old-Node images) one
   diagnostic at a time; do not spend a full product20 run on the current instrument.
2. Only after the blockers are cleared: run product20 and report aggregate accuracy, prompt tokens,
   billed cost and steps.
3. Only after those numbers exist: decide whether the graph loop has a product claim.
4. Then durable checkpoint consumer and kernel breadth.

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
