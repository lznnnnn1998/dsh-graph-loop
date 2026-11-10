# LangGraph ownership

Status: **active reference.** LangGraph is the default kernel for plan shapes the adapter can route;
`FrontierTopology` remains the fallback. Architecture B: `packages/loop` replaces the stock loop.

## Principle

Do not implement a concern twice.

| Layer | Owns | Does not own |
|---|---|---|
| DSH | session log, turn/step machine, prompt assembly, tool registry/execution, approvals, compaction, persistence, projections, UI, subagents | graph control flow, graph checkpoints, typed channels |
| LangGraph | StateGraph/Pregel execution, channels/reducers, checkpointer/resume/time travel, Send/Command, subgraphs, retry/cache, streaming primitives | session log, prompt admission, tool registry, approvals, UI |
| This repo | capability graph, task fingerprint/router, per-turn envelope, DSH node executors, model-authored topology + validator, Graph tab, conformance | a second session log, prompt assembler, tool pipeline or approval system |

The fork is tracked as debt; do not hide it behind the graph narrative.

## Current split

| Concern | Current owner | State |
|---|---|---|
| Session log, turn/step, prompt, tools, approvals, compaction | DSH | Kept by the fork |
| Graph execution | LangGraph for every control-edge condition (`artifact`, `noArtifact`, `fact`, `callFailed`, `budget` step axis) and composed plans | Done |
| Parallel fan-out / subagent batches / reserved ids | `FrontierTopology` | Fallback; documented |
| Typed channels/reducers | Plugin `GraphState` | One JSON `state` channel; not LangGraph channels |
| Checkpoints | Kernel `MemoryCheckpointer` + `plugin:graph-loop/checkpoint` session-log record (`packages/loop/src/graph-state-log.ts`) | Kernel saver is a per-run cache; the session-log boundary record is folded at turn start and resumes the plan at `state.next` (`test/unit/driver-resume.test.ts`). No `storageDomain` saver |
| Send / Command / subgraphs | — | The adapter exposes `Send` fan-out; the live driver does not use it |
| Interrupt / HITL | DSH tool approvals | Correct owner |
| Retry/cache policy | DSH inner retry | Not mapped to LangGraph |
| Graph visualization | Graph tab | Done |

## What to absorb next

1. **Durable checkpoints**: a tested `storageDomain` saver. The read/replay consumer now exists (the
   session-log boundary record folded at turn start, `packages/loop/src/graph-state-log.ts`), so the
   remaining piece is the saver; do not add a second resume path or a second memory store.
2. **Kernel breadth**: one legitimate parallel shape only if the live loop gains a parallel DSH
   step; otherwise keep the frontier fallback and say so.
3. **Channels/reducers** if graph state becomes shared across branches; not needed for the current
   single-branch control-edge path.

## What not to absorb

- LangGraph `interrupt()` for LLM nodes (node body re-executes).
- LangGraph Platform, prebuilt ReAct/supervisor/swarm.
- A second memory store; DSH `storageDomain` owns durable state.
- A second session log.
- Cross-process mid-turn resume by default; stock DSH closes interrupted turns.

## Rule for agents

Before adding graph machinery, name the concrete task class that needs it and the test that proves
it. Do not add a feature just to close a table row.
