# Status — 2026-11-07

One-page snapshot of the repository. Decisions: [COMPOSITION.md](COMPOSITION.md). LangGraph merge
plan: [MERGE-LANGGRAPH.md](MERGE-LANGGRAPH.md). Evidence: [bench/agent-eval/RESULTS.md](../bench/agent-eval/RESULTS.md).

## What this is

A DSH composition/graph plugin, installed as a bundle: the stock `agent-loop` row is disabled, a
graph driver plus a LangGraph kernel runs the turn, the Graph tab shows the topology, and the
**Explore** mode is the default for new sessions. No DSH source files are modified.

## Works today

| Layer | State |
|---|---|
| Install | `bash scripts/install-explore.sh [profile]` (default `web`) installs driver + Graph tab + Explore mode; verifies `agent-loop` disabled, `preset-explore` present, `agent-preset-registry.default = explore` |
| Mode | Explore preset registered; new sessions default to it (explicit user selection still wins) |
| Kernel | `createKernel()` / `runPlan()` default to **LangGraph**; `MinimalKernel` fallback when the optional dependency is absent |
| Live driver | `KernelTopology` pauses the kernel before a node, DSH runs the step, the kernel resumes with the outcome. Linear plans with safe node ids use it; subagent/conditional plans fall back to `FrontierTopology` |
| Composition core | envelope / role resolution / capability composer **live in dynamic mode**; annotation layer + checkpoint contract; 116 tests |
| UI | Graph tab + `/graph-chat`; installed e2e passes |
| Packaging | tarball install + packed-loop runtime e2e passes (`scripts/e2e-tarball.sh`) |
| Benchmark | product: local 20-task 40/40, prompt −60.7%; OfficeBench probe prepared |
| Stress | Terminal-Bench smoke 1.0 all arms; hard subset 0.0 clean (not the gate) |
| Tests | **116 unit tests**, typecheck clean, installed e2e + tarball e2e pass |

## Evidence (real model, `deepseek-flash`, `reasoningEffort: high`)

| Run | success | prompt tokens mean / median | steps mean / median | wall mean / median |
|---|---|---|---|---|
| stock, 20 tasks × 2 reps (live compose) | 40/40 | 25,105 / 23,741 | 4.2 / 4 | 5.8 s / 5.9 s |
| graph, 20 tasks × 2 reps (live compose) | 40/40 | **12,561 / 12,201** | **4.0 / 4** | 6.3 s / 6.2 s |
| delta | parity | **−50.0% / −48.6%** | −4.8% / 0 | +9.4% / +4.2% |

The token and step wins hold for mean and median. **Wall time is not a win**: the mean is +5.9% and
the median −7.4%; one graph run took 49 s. Earlier 6-task runs (installed and kernel-live) are in
[`bench/agent-eval/RESULTS.md`](../bench/agent-eval/RESULTS.md).

## Known gaps

1. **Kernel coverage is partial**: conditional/failure edges, subagent batches and plans with
   LangGraph-reserved node ids still use `FrontierTopology`.
2. **Checkpoints are in-memory** (`MemoryCheckpointer`); `storageDomain` persistence and
   `getStateHistory` are not wired.
3. **OfficeBench is prepared, not run**; it needs the OfficeBench Docker environment and action
   mapping. The local 20-task live-compose result is the current product signal.
4. **Wall time is slightly worse**; token/steps are the wins. Terminal-Bench stress line is 0.0 on
   hard tasks by design of the current agent.
5. **Fork duplication** remains: `packages/loop` is a source copy of DSH's loop. Version tracking is
   automated today; it is still maintenance debt.
6. **No push** unless asked; the tree is committed locally after this snapshot.

## Next, in order

1. Review and commit the current tree (local commit; no push unless asked).
2. Keep the live 20-task composition result green; extend to OfficeBench when available.
3. Run the OfficeBench 5-task product probe when Docker/OfficeBench is available.
4. Stress line only as needed: smoke, then a fixed subset; do not make it the default gate.
5. M3e: kernel routing for conditional/subagent plans; `storageDomain` checkpoint saver.

## Commands

```sh
bash scripts/install-explore.sh          # install into the web profile
npm test                                 # 116 unit tests
npm run typecheck
bash scripts/e2e-installed.sh            # installed bundle e2e (mock LLM)
bash scripts/e2e-tarball.sh              # packed-tarball install path
bash scripts/verify-all.sh               # typecheck + tests + both e2e + links
bash bench/agent-eval/run-real.sh --arm both --reps 2
node bench/agent-eval/summarize.mjs bench/agent-eval/results/2026-11-07-local-2x.json --per-task
bash bench/official/terminal-bench/preflight.sh  # READY: Docker + Harbor + DSH adapter
bash bench/official/terminal-bench/run-smoke.sh    # 1.0 oracle/graph/stock; run BEFORE subsets
bash bench/official/terminal-bench/build-arm64-task.sh <task-dir> /tmp/tb-arm64
bash bench/official/nl2repo/preflight.sh         # Docker present; DSH adapter still missing
```
