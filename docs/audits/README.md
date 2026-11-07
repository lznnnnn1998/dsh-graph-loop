# Audit loop

Every two hours the Lead runs two subagents against this repository:

1. **auditor** (read-only except the report): checks the tree against the original intent, runs
   typecheck/unit tests, flags scope drift and dead/redundant artifacts, writes
   `docs/audits/<UTC timestamp>.md`.
2. **implementer** (write access): reads the newest report, implements only the P0/P1 items that
   move the chosen architecture forward, runs the checks, and appends a resolution section.

Guardrails: original intent is a **graph-based loop for DSH** (existing-loop strengths + LangGraph
strengths); the two allowed architectures are (A) LangGraph driving the stock loop through extension
seams or (B) a dedicated graph-loop plugin replacing the stock `agent-loop` via `AgentFactory`.
The DSH checkout is read-only. No push, npm publish, or token handling from subagents.

Reports are immutable; resolutions append to a copy or a sibling `-resolution` section.
