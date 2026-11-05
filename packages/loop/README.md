# dsh-graph-loop

Graph-native replacement for `@deepseek-ai/dsh-agent-loop`: one turn is a run of a per-turn
topology rather than a fixed linear loop. The driver forks the stock loop (same session events,
same turn/step machine, same tools) and adds a graph scheduler around the model step.

## Use this package

Install the driver into a profile (it replaces the base `agent-loop` row):

```sh
dsh plugin --profile web add dsh-graph-loop
dsh plugin --profile web add dsh-graph-loop-ui   # Graph tab + /graph-chat
```

From a checkout, `bash scripts/install-explore.sh web` installs both.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `topology` | `dynamic` | `template` (curated library), `dynamic` (synthesized from the capability graph), `propose` (model authors it via `graph_plan`) |
| `trivialChars` | `32` | Text length below which a trivial task stays a single node |
| `maxSteps` | `24` | Upper bound on nodes in one synthesized plan |
| `maxParallelToolCalls` | inherited | Stock loop parallel tool-call bound |
| `agents` | `[]` | Declarative startup agents |

Runtime trace storage is configured on the `graph-runtime` row (`traceDir`, `traceLimit`).

## Extension points

- `graphRegistry` (service): capability graph built from the tool registry.
- `graphRouter` (service): template library and task matching.
- `graphRuntime` (service): proposals, live snapshots, per-turn traces.
- `scheduler.ts`: `createGraphTurnDriver` (the loop-facing driver).
- `kernel/`: `KernelPort` implementations (`minimal`, optional `langgraph`).

## Model Experience

Each graph node is injected as a logged `user/message` directive (`[graph node <id>] …`).
That keeps model-visible text reconstructable from the session log. Because node directives enter
history, a multi-node turn adds prompt bytes compared with a single stock step; KV-cache reuse of the
prior conversation is unaffected, but the new tail differs. `template` mode is cheaper; `dynamic`
trades bytes for explicit coverage. `propose` adds one planning step before work starts.

## Known Limitations and Deferred Work

- The driver is a fork; it is not covered by DSH's full conformance/snapshot suite. The local
  `scripts/e2e-conformance.sh` checks event invariants and cross-loop resume, not byte-identical replay.
- `dynamic` synthesis is heuristic, not an optimization over all graphs.
- Mid-run topology replacement is limited to `adoptPolicy: 'start-only'` by default.
- LangGraph is an optional kernel adapter; the default path is the in-repo step graph.
- Child agents force a single-node plan; they do not discover topologies of their own.
