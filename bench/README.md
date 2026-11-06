# bench/ — token & cache A/B harness for the DSH graph loop

> **0.2 evaluation** uses the local 20-task suite ([`agent-eval/`](agent-eval/)) as the pre-signal
> and Terminal-Bench 4.0 + NL2Repo-Bench as the official targets ([`official/`](official/)). See
> [`../docs/EVALUATION.md`](../docs/EVALUATION.md). This file documents the 0.1.x token/cache
> harness and remains useful for cost accounting.

Status: **partially runnable**. The baseline arm runs end to end today; the two graph arms
are specified but deliberately refuse to run until the plugin exists. Everything here prices
*logged sessions*, so the same script works unchanged once graph mode exists.

Numbers and conclusions live in [`../research/04-tokens.md`](../research/04-tokens.md). This
README is the operator manual.

## Layout

```
bench/
  agent-eval/                # 0.2 local 20-task stock-vs-graph harness + results
  official/                  # Terminal-Bench 4.0 / NL2Repo preflights + adapter contract
  officebench/               # secondary 5-task probe manifest (pinned commit)
  tasks/tasks.jsonl          # 8 tasks: single-tool, multi-tool edit, research, doc gen, bug fix,
                             # long refactor, multi-agent, no-tool
  schema/results.schema.json # one row per (arm, task, repetition)
  scripts/
    analyze-session.mjs      # session log -> results row (offline, no model calls)
    catalog-bytes.mjs        # docs/tool-catalog.md -> per-tool schema bytes (default config)
    cost-model.mjs           # billed-token decomposition, break-even, mode A/B model
    aggregate.mjs            # per-arm medians + acceptance/kill rules
    run-arm.mjs              # live runner skeleton (baseline/explore runnable)
  baselines/
    tool-bytes.json          # MEASURED per-tool schema bytes from a live request header (160 tools)
    catalog-tools.json       # catalog-derived sizes, default config (proxy only)
    system-prompt.web.txt    # MEASURED rendered system prompt of a live web-profile session
  results/
    measured-web-sessions.jsonl  # 5 real sessions priced with provider usage
    smoke-baseline.jsonl         # end-to-end runner proof against the mock wire server
```

## Quick start

```sh
# 1. Price real sessions you already have (no API key, no model calls)
node bench/scripts/analyze-session.mjs ~/.dsh/sessions/*/*/session.v4.jsonl.zstd --arm baseline > /tmp/rows.jsonl

# 2. Decompose where the billed input goes + break-even + mode model
node bench/scripts/cost-model.mjs --measured /tmp/rows.jsonl
node bench/scripts/cost-model.mjs --what break-even
node bench/scripts/cost-model.mjs --what modes

# 3. Run the baseline arm on the task set (needs a provider endpoint, see below)
DEEPSEEK_BASE_URL=http://127.0.0.1:8124 DEEPSEEK_API_KEY=mock \
  node bench/scripts/run-arm.mjs --arm baseline --tasks T1,T8

# 4. Score an arm against the thresholds
node bench/scripts/aggregate.mjs bench/results/*.jsonl
```

Deterministic, free endpoint (Anthropic-Messages wire compatible, no key needed):

```sh
cd /Users/zhinan/deepseek-harness
node --import tsx packages/test-support/llm-mock-server/src/bin.ts \
  --sequence success --repeat-last --success-text "OK" --port 8124
```

Set `DSH_HOME` to a directory under this workspace so nothing is written into a user profile.

## What is measured vs estimated

| Field | Source | Label |
|---|---|---|
| `toolSchemaBytes`, `tools` | `request/header.tools` JSON length in the session log | MEASURED |
| `systemChars` | rendered `system/message` text | MEASURED |
| `toolSchemaTokens`, `systemTokens` | `ceil(chars/4)` (+4 heuristic overheads) from `packages/llm/token-meter/src/estimate.ts` | MEASURED-DERIVED |
| `promptTokens`, `cacheReadTokens`, `missTokens`, `outputTokens` | provider usage on `assistant/message` | MEASURED |
| `billedInputUnits`, `billedCostUsd` | `miss + 0.02*hit`, list prices | DERIVED |
| `toolSchemaTokens` in a mock/replay run | heuristic, `tokenSource: "heuristic"` | ESTIMATE |
| preset surface numbers | measured per-tool bytes summed over preset membership | MEASURED bytes, ESTIMATE for unmounted tools |

## Honest gaps (do not paper over)

1. **`run-arm --arm baseline` measures the headless composition (24 tools), not the web
   `standard` preset (33 tools).** The headless bundle mounts the base tool rows directly;
   the web bundle composes tools through `agent-preset`. A preset-aware headless profile is
   the missing piece. Until then, preset comparisons are analytic from `tool-bytes.json` and
   the preset YAMLs, not from a live run.
2. **No `explore` preset exists yet.** The runner accepts `--profile <explore>` but nothing
   provides one. It must be a preset file (e.g. `bench/presets/explore.patch.yml` copied into
   a profile) — a preset switch is a *new session*, which is exactly right for a cache-clean
   comparison and wrong for a mid-session tool change.
3. **Graph arms are not wired.** `--arm graph-control` needs a plugin mounted as a
   `cordis.patch.yml` row replacing `agent-loop`; `--arm graph-node` needs a coordinator that
   spawns one subagent session per node and records a parent id so `sessionCount` is real.
   Both refuse to run rather than silently measuring a single session.
4. **Mock runs have synthetic usage.** `llm-mock-server` reports `input_tokens: 3`, so token
   columns fall back to the heuristic. Cache behaviour can only be measured against the real
   provider (or `llm-replay`, which replays recorded streams and still yields no real usage).
5. **Session logs are user data.** `analyze-session.mjs` reads them in place and emits only
   metrics; do not commit raw session logs to this directory.
6. **`aggregate.mjs` needs ≥3 tasks per arm** before medians mean anything; the shipped
   `measured-web-sessions.jsonl` is 5 heterogeneous sessions, not an A/B.

## Adding an arm

1. Mount the arm (profile patch / plugin) and give it a profile name.
2. `node bench/scripts/run-arm.mjs --arm <arm> --profile <profile> --tasks T1,T2,T6`.
3. `node bench/scripts/aggregate.mjs bench/results/*.jsonl` — the verdicts apply the
   pre-registered thresholds in `scripts/aggregate.mjs` (`ACCEPT`).
4. If the arm changes tools or prompt *inside* a session, also report `cacheReadRatio`: a drop
   of more than 20 points means the prefix cache was destroyed (see research/04-tokens.md §4).
