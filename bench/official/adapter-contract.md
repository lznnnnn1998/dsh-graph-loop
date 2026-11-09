# DSH agent adapter contract (Terminal-Bench)

Harbor calls an agent class; it does not know about DSH. The adapter is the only bridge.

## Required behaviour

1. One task = one DSH process in the task working directory.
2. Launch a profile that installs `dsh-graph-loop` (and optionally the Graph tab / Explore mode) for
   the graph arm; do not edit DSH source.
3. On the graph arm, set `graph-loop.toolPolicy: preset` for benchmark runs so the full benchmark
   tool set is visible; the stock arm already runs the full preset tool set.
4. Pass the task instruction as a single non-interactive prompt with `DSH_AGENT_TIMEOUT_SEC`
   (task `[agent].timeout_sec` via the runner; 900 s adapter fallback). `DSH_AGENT_TIMEOUT_CAP` is
   the only override. A timeout is a failed task, not a score.
5. Let the benchmark verifier read the workspace after the agent exits; do not copy tests into the
   agent image.
6. Capture the DSH session log for steps, tool calls and usage. The session log is the source of
   truth; do not parse stdout for tokens.
7. A model error, timeout or non-zero DSH exit is a failed task, not a harness crash; record it
   distinctly.

## Harbor implementation

[`terminal-bench/dsh_agent.py`](terminal-bench/dsh_agent.py) implements the Harbor lifecycle:

- installs Node + DSH (skipped when a prebaked image already has `dsh` on `PATH`);
- installs the packed plugin into a throwaway profile and applies the tool policy patch;
- runs one DSH turn in `/app` under `DSH_AGENT_TIMEOUT_SEC`, downloads `/root/.dsh/sessions`;
- declares `AgentCapabilities(mcp_servers=True)` when the task configures MCP servers and appends
  each server's name/transport/URL to the prompt (Harbor defines the capability as prompt exposure,
  not connectivity). It starts no SSE/streamable client and registers no tools, so an MCP task is
  reported as "config exposed, tools unavailable" — a valid trial, never an `n_trials: 0` error;
- `DSH_STOCK=1` selects the stock control arm.

`terminal-bench/preflight.sh` checks Docker, Harbor and the adapter.

## Known asymmetries to record

- Both arms share the instrument patch (`sandbox-policy: danger-full-access`,
  `llm-deepseek.retryPolicy.maxRetries: 3`). The graph arm additionally sets
  `graph-loop.toolPolicy: preset` and `benchGuards: true`; the stock arm runs the full preset tool
  set without bench guards. Record the graph-only guards as a harness asymmetry.
- Task images are rebuilt for linux/arm64; record the image tags with results.
- A prebaked Node/DSH overlay changes setup time but not the agent prompt. The MCP prompt note is a
  separate asymmetry: for a task with configured MCP servers, the prompt gains the server
  name/transport/URL while the tools stay unavailable; record both.

## Reportability

- [ ] Smoke gate: oracle/graph/stock all 1.0.
- [ ] Stock and graph arms run the same task image, model, tool policy and timeout.
- [ ] Model, harness version, image tags, commit and profile patch recorded.
- [ ] Raw session logs and result JSON saved; `n_trials: 0` is an infrastructure error.
