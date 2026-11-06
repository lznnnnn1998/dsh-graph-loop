# DSH agent adapter contract for official benchmarks

Both official harnesses call an **agent**; neither knows about DSH. The adapter is the only piece
that needs to change when moving from the official agent to this plugin.

## Required behaviour

1. **One task = one DSH process** in the benchmark's working directory (or a copy exposed to DSH).
2. Launch with a profile that installs `dsh-graph-loop`, the Graph tab (optional for CLI) and the
   Explore mode; do **not** edit DSH source.
3. Set `agent-loop.toolPolicy: preset` so benchmark tools are not filtered by the synthesized plan.
   Record the profile patch and `toolPolicy` in the run manifest.
4. Pass the task instruction as the prompt. Use a non-interactive, single-turn invocation with a
   hard timeout from the benchmark.
5. The benchmark's verifier reads the workspace after the agent exits; do not copy the solution or
   the tests into the agent image.
6. Capture the DSH session log for metrics: steps, tool calls, prompt/output/cache tokens, wall
   time. The session log is the source of truth; do not parse stdout for tokens.
7. Return the benchmark's expected exit status/JSON. A model error, timeout or non-zero DSH exit is
   a failed task, not a harness crash; record it distinctly.

## Harbor (Terminal-Bench)

Harbor's `--agent <name>` resolves an agent class. A DSH adapter must:

- implement Harbor's agent lifecycle (install/start/run/stop) for a container;
- forward the task instruction and any follow-up messages;
- expose the container workspace to DSH (shell/file tools run inside the task container);
- return the final agent result to Harbor.

This adapter is **not implemented** in this repo. The preflight marks it explicitly.

## OpenHands (NL2Repo-Bench)

NL2Repo's `main.py` drives `openhands/openhands_app.py`. Options:

- replace the OpenHands app with a DSH app while keeping the task/workspace/result contract; or
- run DSH behind an OpenHands-compatible adapter.

The repo uses OpenHands images `openhands:0.56` and `runtime:0.56-nikolaik`; the adapter must keep
the Docker volume/workspace layout and write the same per-task result JSON. Not implemented.

## Minimal acceptance before a score is reportable

- [ ] Oracle/baseline run passes on the exact harness version and image digest.
- [ ] One task runs with stock DSH and one with the graph plugin, both scored by the verifier.
- [ ] `toolPolicy: preset` is recorded; the benchmark tool set is visible to the agent.
- [ ] Model, harness commit, dataset digest, max steps, timeout and profile patch are recorded.
- [ ] Raw session logs and result JSON are saved.
