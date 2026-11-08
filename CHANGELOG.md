# Changelog

## 0.2.0 (unreleased)

### Features

- Dedicated graph loop replacing stock `agent-loop` via `AgentFactory`; no DSH source changes.
- Per-turn topology: fingerprint → plan → one DSH step per node.
- Per-turn capability envelope and capability-driven composition.
- LangGraph kernel default; every control-edge condition (`artifact`, `noArtifact`, `fact`,
  `callFailed`, `budget` step axis) is routed by the kernel, composed plans included.
- Bounded recovery/repair for failed verify nodes; subagent batch nodes.
- Per-stage classification: every composed stage (`discover`, `inspect`, `mutate`, `author`,
  `verify`) has a step-scoped success fact and its own no-progress repair exit. The author's success
  guard is the stage's declared artifact **type** (`produced.<artifact>`, reset every step) and the
  verify guard requires `verificationRan` for the node's planned verification tool, so an author fed
  the wrong artifact type or a verify step filled by a non-verification tool repairs instead of
  advancing.
- Graph tab with live topology, node → tool-call inspector and `/graph-chat` API.
- Explore agent preset, one-command installer, default-mode wiring.
- Per-node tool admission; the composed answer node keeps its tools so the turn can continue.

### Reliability

- `graph-node`, `subagent-result` and `bench-retry` message sources; no synthetic producer claims the
  human `user` source.
- Bounded failure graphs, failed turns reported as `GRAPH_FAILED`, subagent failures surfaced.
- `diff-upstream.sh` pins the DSH commit and patch budgets; enforced in local gates.
- Graph-chat route hardening: bounded bodies, methods, host trust fence, SSE close handling.
- Stage exits observe real outcomes: artifacts come from the node's registered `produces` only when
  the planned tool actually ran (third-party/MCP authors included); a non-zero `[exit code: N]` is a
  step-scoped `verificationFailed` fact consumed by the verify stage (inspect/mutate steps running
  `grep`/`diff` are not repaired); repair loops are bounded by `maxSteps`. `produced.<type>` and
  `failedTool` are step-scoped too, so a stale artifact type or failing-tool name cannot route a later
  step.
- A composed stage's failure exits are evaluated before its budget exit: a failed stage at the answer
  reserve repairs instead of becoming `n_answer`, so a failed verification is not reported as a
  successful run.
- Fan-in joins are ordered on the frontier: a forward join waits for every entered predecessor
  (depth-2+ branches included) and a join on a cycle runs once per iteration, while explicit repair
  back-edges still re-enter; the kernel adapter reserves the step a budget-routed wrap-up node needs.
- `budget` conditions only expose the `steps` axis: token/wall axes had no producer and are rejected
  by validation instead of being silently inert.

### Benchmark / docs

- Terminal-Bench easy10 + medium10 product suite defined; smoke gate and DSH adapter added.
- Terminal-Bench product20 attempted 19/20 tasks on 2026-11-08 (pre-repair instrument). The run is
  **not a valid aggregate** (2 paired-valid tasks, all 0.0); a three-task oracle control scores 1.0
  and the smoke gate passes. No product claim. The 2026-11-09 repair is readiness only; the full run
  is pending.
- Removed historical research, archived plans, old local benchmark artifacts and stale docs.

## 0.1.2

- First reliably resolvable loop package; LangGraph/Minimal kernels, Graph tab, Explore mode.

## 0.1.1

- Graph tab + `/graph-chat`, Explore mode bundle.

## 0.1.0

- First graph-loop driver.
