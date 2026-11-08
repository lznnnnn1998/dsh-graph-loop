# Changelog

## 0.2.0 (unreleased)

### Features

- Dedicated graph loop replacing stock `agent-loop` via `AgentFactory`; no DSH source changes.
- Per-turn topology: fingerprint → plan → one DSH step per node.
- Per-turn capability envelope and capability-driven composition.
- LangGraph kernel default; linear + one `callFailed` branch routed by the kernel.
- Bounded recovery/repair for failed verify nodes; subagent batch nodes.
- Graph tab with live topology, node → tool-call inspector and `/graph-chat` API.
- Explore agent preset, one-command installer, default-mode wiring.
- Per-node tool admission and answer-only terminal nodes.

### Reliability

- `graph-node`, `subagent-result` and `bench-retry` message sources; no synthetic producer claims the
  human `user` source.
- Bounded failure graphs, failed turns reported as `GRAPH_FAILED`, subagent failures surfaced.
- `diff-upstream.sh` pins the DSH commit and patch budgets; enforced in local gates.
- Graph-chat route hardening: bounded bodies, methods, host trust fence, SSE close handling.

### Benchmark / docs

- Terminal-Bench easy10 + medium10 product suite defined; smoke gate and DSH adapter added.
- Terminal-Bench product20 attempted 19/20 tasks. The run is **not a valid aggregate** (2
  paired-valid tasks, all 0.0); a three-task oracle control scores 1.0 and the smoke gate passes. No
  product claim.
- Removed historical research, archived plans, old local benchmark artifacts and stale docs.

## 0.1.2

- First reliably resolvable loop package; LangGraph/Minimal kernels, Graph tab, Explore mode.

## 0.1.1

- Graph tab + `/graph-chat`, Explore mode bundle.

## 0.1.0

- First graph-loop driver.
