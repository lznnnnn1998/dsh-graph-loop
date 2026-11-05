# dsh-graph-loop-core

Pure TypeScript library behind the graph loop: no Cordis service, no host I/O. It owns the typed
registry/plan model, task fingerprinting and template matching, topology synthesis, the frontier
executor, proposal validation, and the kernel port.

## Contents

- `graph-schema.ts` — `RegistryGraph`, `TaskTemplate`, `TaskPlan`, `PlanNode`, `PlanEdge`, limits.
- `matching.ts` — `extractFingerprint`, `match`, template instantiation, weights.
- `registry.ts` — deterministic capability graph from tool definitions, digest, warnings.
- `topology.ts` — `synthesizeTopology`, `bootstrapTopology`, `recoveryTopology`, `FrontierTopology`.
- `proposal.ts` — `graph_plan` JSON schema, validation, materialization.
- `replan.ts`, `step-graph.ts`, `runtime.ts`, `kernel.ts` — recovery, fallback plan, kernel port.

## Configuration

This package has no config. Thresholds used by the driver are exposed on the `explore-loop` row
(`trivialChars`, `maxSteps`) or embedded in templates/proposals.

## Extension points

Templates, weight constants, and the kernel port are imported by the driver; add a template by
extending `templates.ts` and covering it in `test/unit/core-templates.test.ts`.

## Model Experience

Nothing here is model-visible directly. The synthesized plan becomes model-visible only when the
driver injects per-node directives as logged user messages.

## Known Limitations and Deferred Work

- Synthesis is a fixed set of heuristics (entry, discovery, inspection, optional web/mutation,
  terminal answer), not a graph search.
- `match` scores a six-template library; new task families need new templates.
- The minimal kernel and the LangGraph adapter are covered by unit tests, not by the shipped profile.
