# Changelog

Product behavior per release. Dates and commit history belong to `git log`; volatile run state is
not recorded here.

## 0.2.0

### Features

- Dedicated graph loop replacing the stock `agent-loop` through `AgentFactory`; no DSH source
  changes.
- Per-turn topology: task fingerprint → one plan per turn, one DSH step per node.
- Per-turn capability envelope and capability-driven composition over `discover`, `inspect`,
  `mutate`, `author` and `verify` stages.
- LangGraph kernel default with a `MinimalKernel` fallback.
- One shared evaluator for every control-edge condition (`artifact`, `noArtifact`, `fact`,
  `callFailed`, `budget` on its step axis); composed plans are kernel-driven.
- Per-node tool admission; the composed answer node is an answer-only terminal admitted exactly the
  typed `graph_answer` channel, so the plan's last step submits its answer through that call, never
  as free text.
- Composed stage routing: each stage declares a budget exit to the answer first, then
  one repair node for failure/no-progress, then its success exit; the repair node has no back-edge
  to its stage. A stage's success exit requires its own declared evidence contract
  (`PlanNode.evidence` → the node-scoped fact `evidence.ok`), never a step-activity aggregate.
- `FrontierTopology` fallback for fan-out outside the acyclic all-unconditional class, subagent
  batches and reserved/nonconforming node ids. A forward join waits for every entered predecessor
  (depth-2+ branches included), a join on a cycle runs once per iteration, and explicit repair
  back-edges still re-enter.
- Bounded failure recovery and repair graphs; failed turns are reported as `GRAPH_FAILED`.
- Graph tab (`conversation.view`) with live topology and a node → tool-call inspector, plus the
  `/graph-chat` page/API.
- Explore agent preset (graph policy, executor suggestion, duplicate-spawn guard) and a one-command
  installer that verifies the composed profile.

### Reliability

- `graph-node`, `subagent-result` and `bench-retry` message sources; no synthetic producer claims the
  human `user` source.
- Step-scoped facts: `failedTool`, `produced.<type>`, `verificationRan` and `verificationFailed` are
  written on every step, so a stale value cannot route a later step.
- One shell-aware effect classifier feeds the graph's `wroteFile`/`readFile` facts and the retry
  guards, so shell reads/writes and `read_image` classify consistently.
- Graph-chat route hardening: bounded bodies, pinned methods, host trust fence, SSE close handling.
- `diff-upstream.sh` pins the DSH commit and patch budgets; local gates enforce it when a checkout is
  present.
- `budget` conditions expose only the `steps` axis; token/wall axes are rejected by validation
  instead of silently never firing.

## 0.1.2

- LangGraph and Minimal kernels, Graph tab, Explore mode bundle.

## 0.1.1

- Graph tab and `/graph-chat`; Explore mode bundle.

## 0.1.0

- First graph-loop driver.
