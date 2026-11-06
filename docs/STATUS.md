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
| Composition core | envelope / role resolution, capability-driven synthesis, annotation layer, checkpoint contract — pure core, 25 focused tests |
| UI | Graph tab + `/graph-chat`; installed e2e passes |
| Tests | **112 unit tests**, typecheck clean, installed e2e passes |

## Evidence (real model, `deepseek-flash`, `reasoningEffort: high`)

| Run | success | prompt tokens mean / median | steps mean / median | wall mean / median |
|---|---|---|---|---|
| stock, 2 reps × 6 tasks | 12/12 | 23,723 / 23,466 | 4.0 / 4 | 16.3 s / 14.9 s |
| graph, 2 reps × 6 tasks | 12/12 | **9,352 / 9,237** | 4.0 / 4 | 21.8 s / 14.8 s |
| stock, installed, 6 tasks | 6/6 | 26,986 / 26,733 | 4.5 / 4.5 | 19.2 s / 15.6 s |
| graph, installed, 6 tasks | 6/6 | **9,349 / 9,267** | **4.0 / 4.0** | 24.1 s / 17.9 s |
| stock, kernel-live, 6 tasks | 6/6 | 25,865 / 23,516 | 4.3 / 4.0 | 5.8 s / 5.6 s |
| graph, kernel-live, 6 tasks | 6/6 | **9,265 / 9,128** | **4.0 / 4.0** | 47.3 s / 46.0 s |

The token and step wins hold for mean and median. **Wall time is not a win**: the means are inflated
by 82–92 s single-call API stalls; do not cite kernel-live wall time as a result.

## Known gaps

1. **Kernel coverage is partial**: conditional/failure edges, subagent batches and plans with
   LangGraph-reserved node ids still use `FrontierTopology`.
2. **Checkpoints are in-memory** (`MemoryCheckpointer`); `storageDomain` persistence and
   `getStateHistory` are not wired.
3. **Accuracy is parity**, not better. The 6 local tasks are too easy; the OfficeBench 5-task probe
   is prepared but not run (needs Docker/office machine).
4. **Fork duplication** remains: `packages/loop` is a source copy of DSH's loop. Version tracking is
   automated today; it is still maintenance debt.
5. **No commit/push** for the current working tree at the time of this snapshot.
6. **OfficeBench probe is not executed**; only the task manifest, setup notes and preflight exist.

## Next, in order

1. Review and commit the current tree (local commit; no push unless asked).
2. OfficeBench 5-task probe on a Docker/office machine; publish the head-to-head report.
3. M3e: kernel routing for conditional/subagent plans; `storageDomain` checkpoint saver.
4. Optional: control-plane path to remove the fork duplication.

## Commands

```sh
bash scripts/install-explore.sh          # install into the web profile
npm test                                 # 112 unit tests
npm run typecheck
bash scripts/e2e-installed.sh            # installed bundle e2e (mock LLM)
bash bench/agent-eval/run-real.sh --arm both --reps 2
node bench/agent-eval/summarize.mjs bench/agent-eval/results/2026-11-07-local-2x.json --per-task
scripts/officebench-preflight.sh         # probe environment check
```
