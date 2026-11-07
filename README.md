# dsh-graph-loop

A composition layer for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):
a LangGraph-style typed graph composes DSH plugins — tools, skills, presets, subagents, context —
into **one graph per turn with a per-turn capability envelope**. The graph is visible in the Graph
tab; the LLM-facing kernel is LangGraph (Minimal fallback). The active path is a graph driver
installed as a bundle; the long-term path is a control plane over the stock loop, which would
remove the fork duplication.

**Value:** a DSH-native, tool-agnostic plugin that is measurably better than the official default
experience on a public benchmark, and that people actually install, use and extend. It is a
community contribution — not a business, a general agent framework or a research paper.

> **Status: 0.2 in progress — two lines.** *Product*: composition layer + live envelope/compose +
> per-turn tool surface, evaluated on medium tasks. *Stress*: Terminal-Bench, used to expose
> reliability gaps, not as the default gate. Start with [`docs/PRODUCT-LINE.md`](docs/PRODUCT-LINE.md),
> [`docs/STRESS-LINE.md`](docs/STRESS-LINE.md), and [`docs/STATUS.md`](docs/STATUS.md).
> Changelog: [`CHANGELOG.md`](CHANGELOG.md).

## What 0.2 builds

> **Live today:** graph driver + LangGraph kernel, Explore mode default, Graph tab, per-plan tool
> admission, **envelope + capability composer in dynamic mode**, and bounded verify→diagnose→edit
> repair. Checkpoints/`storageDomain` remain contract-only.

- **Per-turn capability envelope** — the router picks the smallest role/tool set a turn needs;
  tools stay stable inside the turn, prompt sections and memory selection vary per node.
- **Tool-agnostic by construction** — the default role vocabulary contains no product or craft
  name. Any registered tool joins through data annotations, `produces:<artifact>` roles, template
  implementations, task hints, or the preset baseline. Craft plugins are one genericity fixture,
  not the evaluation.
- **Capability-driven synthesis** — plans are built from stages (`discover`, `inspect`, `mutate`,
  `author`, `verify`, `deliver`) and artifact contracts, never hardcoded tool names. A tool that
  declares what it produces can fill a stage; an unknown tool set still gets a valid single-step
  plan instead of being dropped.
- **Harness-owned executors** — `step`, `tool-batch`, `subagent`, `context`. Plugins are untouched;
  third parties contribute capabilities and templates, never node executors.
- **Authoritative checkpoints** — graph state in a `storageDomain` sidecar, written at node
  boundaries; the session log remains the conversation record.
- **Single-writer parent** — parallel branches are child sessions joined into the parent.
- **Graph tab** — live topology, node → tool-call inspector, envelope and checkpoint history.
- **Template packages** — npm packages binding abstract roles + concrete implementations, with
  schema validation, dry-run preview and a curated index.
- **Product evaluation** — local 20-task medium suite (accuracy parity + token/steps win), then
  the OfficeBench 5-task subset when the office environment is available. **Terminal-Bench is a
  separate stress line**, not the default gate. Protocol: [`docs/EVALUATION.md`](docs/EVALUATION.md).

## Non-goals

- Not a general agent framework; no LangGraph/LangChain competition.
- Not a craft or domain-tool set.
- Not a permanent fork: the fork is the current bridge, the control plane is the long-term path.
- Not a research project; evaluation is a means, not the product.

## Why this direction

The earlier plan (graph loop versus stock loop, with cost gates) is kept as research history:
[`docs/archive/explore-mode-plan.zh.md`](docs/archive/explore-mode-plan.zh.md). The short version:

- the value is a **measured comparison** against the official default, not an abstract graph-vs-loop claim;
- per-step tool gating loses on prefix cache, so the envelope is **per turn**;
- the fork is a bridge; the control plane is the long-term path;
- checkpoints belong in a public storage API, not in session-format exceptions.

Details: [`docs/COMPOSITION.md`](docs/COMPOSITION.md) · [`docs/MERGE-LANGGRAPH.md`](docs/MERGE-LANGGRAPH.md) ·
[`docs/STATUS.md`](docs/STATUS.md). All docs: [`docs/README.md`](docs/README.md).

## Repository layout

```
packages/core/          capability graph, routing, topology, contracts (private)
packages/loop/          graph driver (fork) + LangGraph/Minimal kernel — ACTIVE, fork is debt
packages/mode/          Explore mode (agent preset) + graph policy / reuse guard — ACTIVE
packages/graph-ui/      Graph tab (conversation.view) + /graph-chat API
docs/                   active contracts + reference/ + archive/ (index: docs/README.md)
research/               evidence base for the original plan
bench/                  product eval (agent-eval, OfficeBench) + stress harness (official)
compat/                 DSH-style vitest/coverage harness
```

## Install (default Web profile)

```sh
bash scripts/install-explore.sh          # default profile: web
# or: bash scripts/install-explore.sh --profile <name>
dsh web                                  # the stock agent-loop row is disabled
```

The installer adds the Graph-tab, driver and Explore-mode bundles to the profile, sets the
`agent-preset-registry` default to `explore`, and verifies that the stock `agent-loop` row is
`disabled: true`. The stock package is **not uninstalled** — the shipped base
bundle depends on it; disabling the row is DSH's supported replacement mechanism. DSH has no global
default-profile setting, so “default” means the profile you actually boot (`web` by default).

## Quick start

```sh
bash scripts/link-dsh.sh            # link the read-only DSH checkout packages
bash scripts/verify-all.sh          # typecheck + tests + installed e2e + tarball e2e + links
bash scripts/install-explore.sh     # install into the default web profile (stock row disabled)
```

Benchmark:

```sh
bash bench/agent-eval/run-real.sh --arm both --reps 2
node bench/agent-eval/summarize.mjs bench/agent-eval/results/<file>.json --per-task
bash bench/official/terminal-bench/preflight.sh   # NOT READY without Docker/Modal
bash bench/official/nl2repo/preflight.sh          # NOT READY without Docker
```

Composition-layer commands are documented as they land; the contract is in
[`docs/COMPOSITION.md`](docs/COMPOSITION.md) and the evaluation protocol in
[`docs/EVALUATION.md`](docs/EVALUATION.md). Docs index: [`docs/README.md`](docs/README.md).

## Requirements

- DeepSeek Harness `^0.2.1-rc.3` (see each package's `engines.dsh`).
- 0.2 additionally mounts `@deepseek-ai/dsh-storage-domain`; the composition row fails loudly if it
  is absent.

## License

MIT. See [LICENSE](LICENSE).
