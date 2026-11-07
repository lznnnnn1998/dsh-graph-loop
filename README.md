# dsh-graph-loop

A dedicated **graph loop** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).
It replaces the stock `agent-loop` through DSH's `AgentFactory` seam and runs **one typed graph per
turn**: a runtime topology (nodes, control edges, per-node tool admission) whose nodes are ordinary
DSH steps. The loop is installed as a bundle, so no DSH source file is modified.

**Architecture B — the fork is the active loop.** `packages/loop` is a bounded source fork of DSH's
agent loop. It keeps the stock session event log, turn/step machine, prompt assembly, tool
resolution/approval waterfall, compaction and projections, and adds the graph-specific hooks
(turn-graph stepping, per-node tool admission, subagent batches, failure routing). The graph runtime
is LangGraph by default, with `FrontierTopology` as the fallback for shapes the kernel does not yet
own. There is no second "control plane" product path; that framing was retired in the 0.2 audit
(see [`docs/STATUS.md`](docs/STATUS.md) and [`docs/archive/COMPOSITION.md`](docs/archive/COMPOSITION.md)).

**Kernel coverage (exact, tested).**

| Plan shape | Engine |
|---|---|
| Linear chain (`always`/no condition, one control out-edge per node) | LangGraph (`KernelTopology` pause-before-node round-trip) |
| Linear + **one `callFailed` failure branch** (success edge + recovery edge from a node) | LangGraph — `routeKernelPlan()` picks `state.next`, the conditional edge follows it (declared destinations: every node id + `END`); both arms are unit-tested |
| Parallel fan-out / two-branch join | `FrontierTopology` (a DSH step is sequential; parallel branches are subagent nodes) |
| Subagent batches | `FrontierTopology` |
| `artifact` / `noArtifact` / `fact` / `budget` conditions | `FrontierTopology` |
| Node ids with `:` or LangGraph-reserved names | `FrontierTopology` |

**What 0.2 builds**

- **Per-turn topology** — the scheduler fingerprints the task and installs one plan per turn; the
  graph advances one DSH step per node.
- **Per-turn capability envelope** — role/tool resolution and prompt sections are selected per turn;
  the plan's tool universe stays stable inside the turn.
- **Capability-driven synthesis** — composed plans come from stages (`discover`, `inspect`, `mutate`,
  `author`, `verify`, `deliver`) and artifact contracts, not hardcoded tool names.
- **Per-node tool admission** — each step narrows to the plan universe; an answer-only terminal node
  runs with no tools.
- **Bounded failure recovery** — a boundary replan installs a small recovery/repair graph, and a plan
  with a `callFailed` edge is routed by the kernel.
- **Graph tab** — live topology, node → tool-call inspector, envelope history, `/graph-chat` API.
- **Explore mode** — an agent preset installed as the default for new sessions.

**Status and evidence (honest).**

- Unit suite, typecheck, and the release build gate are green (`npm test`, `npm run typecheck`,
  `npm run build && npm run build:check`).
- **There is no reproducible product benchmark result.** The active product suite
  ([`bench/official/subsets/product20.json`](bench/official/subsets/product20.json), Terminal-Bench
  easy10 + medium10) is defined but has not been run. The archived local 20-task run is
  **non-reproducible**: it ran on a dirty worktree whose recorded commit contains no live
  composition code, and even that run had a **higher billed total** despite fewer prompt tokens. Its
  −50% prompt figure is not a product claim and is quoted only in the archived evidence with that
  provenance. The hard Terminal-Bench stress line is 0.0 on clean trials; the smoke task is 1.0.
- Checkpoints are **in-memory** (`MemoryCheckpointer`); `storageDomain` durability is not wired, so a
  restart cannot resume mid-turn.
- The fork is maintenance debt: `packages/loop` tracks DSH's loop and must be re-diffed on upstream
  changes (`scripts/diff-upstream.sh`).

**Non-goals**

- Not a general agent framework; no LangGraph/LangChain competition.
- Not a craft or domain tool set.
- Not a second execution product beside the stock loop: architecture B is the loop replacement.
- Not a research project.

**Repository layout**

```
packages/core/      capability graph, routing, topology, composer, contracts (private)
packages/loop/      graph driver (bounded fork) + LangGraph/Minimal kernel — ACTIVE
packages/mode/      Explore mode (agent preset) + graph policy
packages/graph-ui/  Graph tab (conversation.view) + /graph-chat API
docs/               active status/merge/publishing docs + reference/ + archive/
research/           evidence base for the original plan
bench/              product TB easy/medium suite + archived local harness + stress harness
compat/             DSH-style fork-fidelity harness (manual)
```

**Install (default Web profile)**

```sh
bash scripts/install-explore.sh          # default profile: web
# or: bash scripts/install-explore.sh --profile <name>
dsh web                                  # the stock agent-loop row is disabled
```

The installer adds the Graph-tab, driver and Explore-mode bundles to the profile, sets the
`agent-preset-registry` default to `explore`, and verifies that the stock `agent-loop` row is
`disabled: true`. The stock package is **not uninstalled** — the shipped base bundle depends on it;
disabling the row is DSH's supported replacement mechanism. DSH has no global default-profile
setting, so "default" means the profile you actually boot (`web` by default).

**Quick start**

```sh
bash scripts/link-dsh.sh            # link the read-only DSH checkout packages
bash scripts/verify-all.sh          # typecheck + tests + installed e2e + tarball e2e + links
bash scripts/install-explore.sh     # install into the default web profile (stock row disabled)
```

Product benchmark (Terminal-Bench easy10 + medium10) — **not run yet; Docker/Harbor required**:

```sh
bash bench/official/terminal-bench/preflight.sh
bash bench/official/terminal-bench/run-smoke.sh
bash bench/official/terminal-bench/run-subset.sh /tmp/tb-arm-dsh
```

The old local 20-task harness is archived at [`bench/archive/agent-eval/`](bench/archive/agent-eval/);
its results are historical evidence, not a current claim.

**Requirements**

- DeepSeek Harness `^0.2.1-rc.3` (see each package's `engines.dsh`).
- LangGraph `@langchain/langgraph@1.7.0` is the default kernel; without it the loop degrades to the
  vendored `MinimalKernel`.
- Checkpoints are in-memory in 0.2; `storageDomain` persistence is not mounted.

**Docs**

- [`docs/STATUS.md`](docs/STATUS.md) — facts, coverage, gaps, next.
- [`docs/MERGE-LANGGRAPH.md`](docs/MERGE-LANGGRAPH.md) — DSH / LangGraph / this repo ownership.
- [`docs/PUBLISHING.md`](docs/PUBLISHING.md) — package names and release steps.
- [`docs/archive/COMPOSITION.md`](docs/archive/COMPOSITION.md) — historical 0.2 control-plane
  decision record (superseded).
- [`docs/archive/PRODUCT-LINE.md`](docs/archive/PRODUCT-LINE.md) — original product line
  (historical; no reproducible evidence).

**License**

MIT. See [LICENSE](LICENSE).
