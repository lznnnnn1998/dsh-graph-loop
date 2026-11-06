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

> **Status: 0.2 in progress — direction reset (2026-11).** The graph driver (a source fork) is the
> active loop, with the LangGraph kernel as the default; the fork duplication is tracked as debt.
> The **Explore mode** is installed as the default for new sessions. Start with
> [`docs/STATUS.md`](docs/STATUS.md) and [`docs/COMPOSITION.md`](docs/COMPOSITION.md).

## What 0.2 builds

> **Live today:** graph driver + LangGraph kernel (kernel-drivable plans), Explore mode default,
> Graph tab, per-plan tool admission. The envelope/synthesis/checkpoint items below are implemented
> core contracts; their live wiring is in progress. See [`docs/STATUS.md`](docs/STATUS.md).

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
- **Evaluation** — an OfficeBench 5-task single-app probe across three arms (default profile,
  controlled stock, composition), then a fixed subset and a public head-to-head report. The probe
  is the first hard decision gate; there is no 1.0 gate. Protocol:
  [`docs/EVALUATION.md`](docs/EVALUATION.md).

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
bench/                  task/token harness + OfficeBench probe manifest
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

## Quick start (0.1.x experiments)

Development commands:

```sh
bash scripts/link-dsh.sh            # link the read-only DSH checkout packages
npm test                            # unit tests
npm run e2e                         # dev overlay + mock LLM
bash scripts/e2e-installed.sh       # install the driver bundle into a throwaway profile
bash scripts/e2e-graph-tab.sh       # Graph tab in the real Web chat UI
bash scripts/install-explore.sh     # install into the default web profile (stock row disabled)
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
