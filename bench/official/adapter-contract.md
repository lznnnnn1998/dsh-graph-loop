# DSH agent adapter contract (Terminal-Bench)

Harbor calls an agent class; it does not know about DSH. The adapter is the only bridge.

## Required behaviour

1. One task = one DSH process in the task working directory.
2. Launch a profile that installs `dsh-graph-loop` (and optionally the Graph tab / Explore mode);
   do not edit DSH source.
3. Set `agent-loop.toolPolicy: preset` for benchmark runs so the full benchmark tool set is visible.
4. Pass the task instruction as a single non-interactive prompt with the benchmark timeout.
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
- runs one DSH turn in `/app`, downloads `/root/.dsh/sessions`;
- `DSH_STOCK=1` selects the stock control arm.

`terminal-bench/preflight.sh` checks Docker, Harbor and the adapter.

## Known asymmetries to record

- The graph profile patch sets `llm-deepseek.retryPolicy.maxRetries: 1`; the stock arm uses the
  default.
- Task images are rebuilt for linux/arm64; record the image tags with results.
- A prebaked Node/DSH overlay changes setup time but not the agent prompt; record it.

## Reportability

- [ ] Smoke gate: oracle/graph/stock all 1.0.
- [ ] Stock and graph arms run the same task image, model, tool policy and timeout.
- [ ] Model, harness version, image tags, commit and profile patch recorded.
- [ ] Raw session logs and result JSON saved; `n_trials: 0` is an infrastructure error.
