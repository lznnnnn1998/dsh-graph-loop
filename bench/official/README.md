# Official benchmarks — plan, gates, and current status

Primary benchmarks chosen from the DeepSeek V4.1-Flash-1017 model card:

| Benchmark | Model-card score | Harness | Gate |
|---|---|---|---|
| **Terminal-Bench 4.0** | 42.3 | [Harbor](https://github.com/harbor-framework/terminal-bench) | Docker/Modal + a DSH Harbor agent adapter |
| **NL2Repo-Bench** | 68.2 | [OpenHands headless](https://github.com/multimodal-art-projection/NL2RepoBench) | Docker + an OpenHands→DSH adapter |

Adapter contract: [`adapter-contract.md`](adapter-contract.md).

The local 20-task benchmark in [`../agent-eval/`](../agent-eval/) is the **pre-signal** that runs
today. Official runs are gated on the missing pieces below; do not report a model-card comparison
until the exact harness version, task selection and agent adapter are pinned.

## Current status (2026-11-07)

- **No container runtime** on the development machine: `docker`, `podman`, `colima` all absent.
  Terminal-Bench and NL2Repo-Bench both require containers.
- Terminal-Bench 4.0 is run through **Harbor**. Harbor does not ship a DSH agent; a small adapter
  must launch DSH in the task container and report the final answer. Not implemented.
- NL2Repo-Bench is an **OpenHands** harness (`main.py` → `openhands/openhands_app.py`), with
  Docker images `openhands:0.56` and `runtime:0.56-nikolaik`. Replacing OpenHands with DSH is a
  larger adapter; not implemented.
- Therefore the official scores are **not measured**. Preflights below exit `NOT READY`; that is the
  honest state, not a failure of the plugin.

## Run protocol (when the gates pass)

1. Pin the model: `deepseek-flash` is the 1017 snapshot; record the provider/model and
   `reasoningEffort` in the run manifest.
2. Pin the harness commit/tag and dataset digest before the first run.
3. Pre-register a fixed task subset (do not select after seeing results). Start with 10–20 tasks;
   only run the full set after the probe is green.
4. Two arms, same harness and config:
   - **stock**: official DSH loop;
   - **graph**: this plugin, `toolPolicy: preset` so benchmark tools are never hidden by plan
     filtering.
5. Run `--reps 2` where the harness supports repetitions; report **mean and median** for steps,
   tool calls, prompt tokens, output tokens, wall time and score, plus success counts.
6. Report absolute score **and** delta vs stock. Only compare to the model card when the harness,
   prompt, tools, max steps and timeouts are identical to the card's setup.
7. Store raw rows and the exact command under `bench/official/results/<date>-<harness>/`.

## Terminal-Bench 4.0

```sh
# preflight first
bash bench/official/terminal-bench/preflight.sh

git clone https://github.com/harbor-framework/terminal-bench.git /tmp/terminal-bench
uv tool install 'harbor[modal]'
harbor run -d terminal-bench/terminal-bench@latest \
  --agent <dsh-harbor-agent> \
  --model deepseek/deepseek-flash \
  --env docker \
  --n-concurrent 4
```

The `--agent` value must be a Harbor agent that launches DSH. The model card used 42.3; treat it as
a reference, not a guarantee under a different agent harness.

## NL2Repo-Bench

```sh
bash bench/official/nl2repo/preflight.sh
git clone https://github.com/multimodal-art-projection/NL2RepoBench.git /tmp/nl2repo
cd /tmp/nl2repo
python3 -m pip install -r requirements.txt
# adapt openhands/openhands_app.py or supply a DSH agent; then:
python3 main.py
```

The repo has 104 tasks (`test_files/`), Docker images, and writes one result JSON per task under
`result/`. The model card used 68.2.

## What is deliberately not claimed

- No official benchmark has been run in this repository yet.
- The local 20-task suite is not Terminal-Bench/NL2Repo; it measures the same plugin seam on a
  cheaper harness.
- A model-card score is **not** a baseline for this plugin until the adapter and harness match.
