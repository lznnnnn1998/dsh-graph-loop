# dsh-graph-loop

> **Active graph driver in 0.2.** Installed as a bundle: the stock `agent-loop` row is disabled and
> this driver runs one graph node per DSH step. The LLM-facing default kernel is **LangGraph**
> (`MinimalKernel` fallback). This package is a **source fork** of `@deepseek-ai/dsh-agent-loop`;
> the duplication is tracked as maintenance debt, and the long-term option is a control plane over
> the stock loop.

## Use this package

```sh
dsh plugin --profile web add dsh-graph-loop
dsh plugin --profile web add dsh-graph-loop-ui   # Graph tab + /graph-chat
```

Or run the one-command installer from a checkout:

```sh
bash scripts/install-explore.sh          # default profile: web
```

The installer also adds the Explore mode and verifies the composed profile.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `topology` | `dynamic` | `template` (curated library), `dynamic` (synthesized from the capability graph), `propose` (model authors it via `graph_plan`) |
| `kernel` | `langgraph` | `langgraph` (default, falls back to Minimal when absent) or `minimal` |
| `trivialChars` | `32` | Text length below which a trivial task stays a single node |
| `maxSteps` | `24` | Upper bound on nodes in one synthesized plan |
| `toolPolicy` | `plan` | `plan` narrows each step to the plan universe (token win); `preset` keeps the full preset tool set for benchmark harnesses |
| `maxParallelToolCalls` | inherited | Stock loop parallel tool-call bound |
| `agents` | `[]` | Declarative startup agents |

Runtime trace storage is configured on the `graph-runtime` row (`traceDir`, `traceLimit`).

## Extension points

- `graphRegistry` (service): capability graph built from the tool registry.
- `graphRouter` (service): template library and task matching.
- `graphRuntime` (service): proposals, live snapshots, per-turn traces.
- `scheduler.ts`: `createGraphTurnDriver` (loop-facing driver).
- `kernel/topology.ts`: `KernelTopology` (kernel round-trip; frontier fallback).
- `kernel/`: `KernelPort` implementations (`minimal`, `langgraph`).

## Model Experience

A graph node is injected as a logged user message (`[graph node <id>] …`). Node-level tool
admission narrows each step to the plan's tool universe plus a small safe floor, which is the source
of the measured prompt-token reduction. Because node directives enter history, a multi-node turn
adds prompt bytes compared with a single stock step; the token win currently comes from tool-schema
narrowing, not from fewer steps.

## Known Limitations

- The driver is a fork; it is not covered by DSH's full conformance/snapshot suite. Local
  conformance/cross-loop scripts cover event invariants, not byte-identical replay.
- Kernel coverage is partial: subagent/conditional plans and plans with LangGraph-reserved node ids
  use `FrontierTopology`.
- Kernel checkpoints are in-memory (`MemoryCheckpointer`); `storageDomain` persistence is pending.
- `dynamic` synthesis is heuristic, not an optimization over all graphs.
- Mid-run topology replacement is limited by `adoptPolicy: 'start-only'` by default.
