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

## Kernel coverage (exact)

| Plan shape | Engine | Evidence |
|---|---|---|
| Linear chain | **LangGraph** | `test/unit/kernel-topology.test.ts` |
| Linear + one `callFailed` branch | **LangGraph** (real conditional edge; `routeKernelPlan` selects `state.next`) | `test/unit/kernel-topology.test.ts` |
| Parallel fan-out / join | `FrontierTopology` | `test/unit/topology.test.ts` |
| Subagent batches | `FrontierTopology` | `test/unit/scheduler.test.ts` |
| `artifact`/`noArtifact`/`fact`/`budget` conditions | `FrontierTopology` | `canKernelDrive()` rejects them |
| Reserved node ids | `FrontierTopology` | `canKernelDrive()` rejects them |

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
32/40). The graph arm's composed plan is a **five-step linear chain** (`n_inspect -> n_mutate ->
n_mutate -> n_verify -> n_answer`); `n_answer` removes every tool and ends the turn after one step.
The graph session has 80 records versus 217 for stock, so the graph scores are dominated by
premature termination, not by model capability. That defect is the first thing to fix; see the
partial-run README for the node sequence and counts.

A three-task oracle control
([result](../bench/official/results/2026-11-08-oracle-control/README.md)) scores **1.0** on
`html-js-filter`, `cargo-flight-dispatch` and `music-harmony`; the task harness (image, verifier,
scoring) can produce a pass on those tasks, so a 0.0 is not by itself evidence about the loop. The earlier single-task
[`2026-11-08-html-js-filter`](../bench/official/results/2026-11-08-html-js-filter/README.md) run and
the partial run disagree on that task's stock arm (the partial stock attempt timed out at 900 s);
both are task-level evidence, neither is an aggregate.

The latest evaluator readiness pass
([`2026-11-08-readiness`](../bench/official/results/2026-11-08-readiness/README.md)) records 20/20
env images, 19/20 verifier images (`formal-crypto` still missing), a passing local gate (168/168
tests) and a passing three-arm smoke
([`2026-11-08-smoke`](../bench/official/results/2026-11-08-smoke/README.md)); product20 was not run,
so no aggregate changed.

The former local 20-task run is not part of this tree and is not citable as current evidence.

## Known gaps

1. **Durable checkpoints**: `MemoryCheckpointer` only; no `storageDomain` saver, no restart resume.
   The blocker is the consumer (replay/time-travel), not storage availability.
2. **Kernel breadth**: parallel fan-out/join, subagent batches and non-`callFailed` conditions still
   use `FrontierTopology`.
3. **Product20 blocked on the instrument and on graph termination**: the 2026-11-08 run spent most
   stock arms on a 900 s fixed timeout; `formal-crypto` and `shadow-relay` request `cpus = 8` in
   `task.toml` against this 4-CPU VM; it also hit image pull/TLS (`heat-pump-warranty`), missing MCP
   startup (`medical-claims-processing`), npm bootstrap (`intrastat-meldung`), and an old-Node
   `node:sqlite` import (`freight-dispatch-shift`). The
   timeout policy is now per-task `[agent].timeout_sec` with `DSH_AGENT_TIMEOUT_CAP` as an override;
   see [`EVALUATION.md`](EVALUATION.md). Separately, the composed five-step plan ends at `n_answer`
   with `toolAllow: []`, so the graph arm stops before the stock loop would; fix termination and
   rerun before comparing arms.
4. **Fork debt**: source copy of DSH's loop; enforced by `scripts/diff-upstream.sh --check`.
5. **Benchmark heuristics off by default** (`benchGuards: false`); they are harness-specific.

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
