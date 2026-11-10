# dsh-graph-loop

> **Active graph driver in 0.2.** Installed as a bundle: the stock `agent-loop` row is disabled and
> this driver runs one graph node per DSH step. The LLM-facing default kernel is **LangGraph**
> (`MinimalKernel` fallback). This package is a **source fork** of `@deepseek-ai/dsh-agent-loop`;
> the duplication is tracked as maintenance debt and re-diffed with `scripts/diff-upstream.sh`.
> The guard is **enforced**: `scripts/ci-local.sh` and `scripts/verify-all.sh` run
> `diff-upstream.sh --check`, which pins the upstream commit and fails when a shared file diverges
> or a patched file (`agent.ts`, `index.ts`) outgrows its documented added/removed-line budget (it
> skips cleanly when no DSH checkout is available). The fork is the active loop (architecture B);
> there is no separate control-plane product path.

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
| `trivialChars` | `32` | Text length below which a trivial task stays a single node |
| `maxSteps` | `24` | Upper bound on graph steps in one turn (also the default plan `budget.maxSteps`) |
| `toolPolicy` | `plan` | `plan` narrows each step to the plan universe (token win); `preset` keeps the full preset tool set for benchmark harnesses |
| `composition` | `true` | Use the envelope + capability composer in dynamic mode; `false` keeps the legacy `synthesizeTopology` path |
| `benchGuards` | `false` | Benchmark-only retries: detect DSML-printed tool calls and force a mutation node that did not mutate. Off for normal loop use |
| `shellTools` | `['bash', 'pwsh']` | Tool names whose lone failed call fails the step's graph node (selects `callFailed` recovery) |
| `maxParallelToolCalls` | `10` | Stock loop parallel tool-call bound |
| `agents` | `[]` | Declarative startup agents |

The shipped row does not expose a kernel switch: the driver uses LangGraph when it can drive a
plan and `FrontierTopology` otherwise. `createGraphTurnDriver({ kernel: 'minimal' | 'off' })` is
available to tests and embedders.

Runtime trace storage is configured on the `graph-runtime` row (`traceDir`, `traceLimit`,
`maxProposals`).

## Extension points

- `graphRegistry` (service): capability graph built from the tool registry.
- `graphRouter` (service): template library and task matching.
- `graphRuntime` (service): proposals, live snapshots, per-turn traces.
- `src/scheduler.ts`: `createGraphTurnDriver` (loop-facing driver).
- `src/kernel/topology.ts`: `KernelTopology` (kernel round-trip; the scheduler uses
  `FrontierTopology` for plans the kernel cannot drive).
- `src/kernel/`: `KernelPort` implementations (`minimal`, `langgraph`).

## Model Experience

A graph node is injected as a logged user-role message (`[graph node <id>] …`) whose source kind is
the loop-owned `graph-node` (`{ kind: 'graph-node', nodeId }`), not the human `user` source. It is
model-visible history like the stock loop's injected context, but the stock Web API's
`latestUserQuestion` (which reads `source.kind === 'user'`) and any other human-prompt filter ignore
it. Injected subagent batch results use their own `subagent-result` source
(`{ kind: 'subagent-result', nodeId }`), and the benchmark-only retry corrections use `bench-retry`;
no synthetic producer claims the human source. Node-level tool admission narrows each step to the
plan's tool universe plus a small safe floor. No prompt-token reduction from that narrowing is
claimed. Because node directives enter history, a multi-node turn adds prompt bytes compared with a
single stock step.

## Known Limitations

- The driver is a fork; it is not covered by DSH's full conformance/snapshot suite. Local
  conformance/cross-loop scripts cover event invariants, not byte-identical replay.
- Kernel coverage is partial by plan shape, not by condition. The exact plan shape → engine → test
  table (and the data-edge rejection) is in
  [`../../docs/KERNEL-COVERAGE.md`](../../docs/KERNEL-COVERAGE.md).
- Kernel checkpoints are in-memory (`MemoryCheckpointer`); `storageDomain` persistence is pending.
- `dynamic` synthesis is heuristic, not an optimization over all graphs.
- `maxSteps` bounds **graph nodes per turn**: a replan, recovery plan or adopted proposal cannot
  reset the allowance, and both engines grant at most one extra wrap-up step when a `budget` edge
  targets a declared terminal. It does **not** count agent retries (DSML/mutation corrections) or
  subagent child steps; a child agent runs its own single-node budget, so a wide batch multiplies
  child work even though the parent trail grows by one per child. `TaskBudget.maxTokens` and
  `maxWallMs` are declared capacity, not enforced at a step boundary — the host `agent.timeout_sec`
  and abort are the wall-clock bound.
- Mid-run topology replacement is limited by `adoptPolicy: 'start-only'` by default.
