# dsh-graph-loop

A dedicated **graph loop** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).
It replaces the stock `agent-loop` through DSH's `AgentFactory` seam and runs **one graph per
turn**: a runtime topology whose nodes are ordinary DSH steps. It is installed as a bundle; no DSH
source file is modified.

**Architecture B — the fork is the active loop.** `packages/loop` is a bounded source fork of DSH's
agent loop. It keeps the stock session log, turn/step machine, prompt assembly, tool
resolution/approval waterfall, compaction and projections, and adds the graph-specific hooks
(turn-graph stepping, per-node tool admission, subagent batches, failure routing). LangGraph is the
default kernel; `FrontierTopology` is the fallback for plan shapes the kernel does not own.

## Kernel coverage (exact)

| Plan shape | Engine |
|---|---|
| Linear chain (`always`/no condition, one control out-edge per node) | LangGraph (`KernelTopology`) |
| Linear + one `callFailed` failure branch | LangGraph; `routeKernelPlan()` selects `state.next`, then a real conditional edge follows it. Both arms are unit-tested. |
| Parallel fan-out / two-branch join | `FrontierTopology` |
| Subagent batches | `FrontierTopology` |
| `artifact` / `noArtifact` / `fact` / `budget` conditions | `FrontierTopology` |
| Node ids with `:` or LangGraph-reserved names | `FrontierTopology` |

No claim is made that LangGraph executes arbitrary graphs.

## What 0.2 builds

- **Per-turn topology** — task fingerprint → one plan per turn; one DSH step per node.
- **Per-turn capability envelope** — role/tool resolution; tool universe stable inside the turn.
- **Capability-driven synthesis** — stages (`discover`, `inspect`, `mutate`, `author`, `verify`,
  `deliver`) and artifact contracts, not hardcoded tool names.
- **Per-node tool admission** — a terminal node can run with no tools.
- **Bounded failure recovery** — recovery/repair graph, with a `callFailed` edge routed by the
  kernel.
- **Graph tab** — live topology, node → tool-call inspector, `/graph-chat` API.
- **Explore mode** — an agent preset installed as the default for new sessions.

## Status (honest)

- Unit suite, typecheck, and the release build gate are green:
  `npm test` (168 tests), `npm run typecheck`, `npm run build && npm run build:check`.
- **No product benchmark aggregate yet.** Terminal-Bench easy10 + medium10 is defined in
  [`bench/official/subsets/product20.json`](bench/official/subsets/product20.json) but not run to
  completion. One member, `html-js-filter`, has a real tracked trial
  ([result](bench/official/results/2026-11-08-html-js-filter/README.md)): **graph 0.0 / stock 0.0**
  (one task, both arms completed; not an aggregate).
- Checkpoints are **in-memory** (`MemoryCheckpointer`); `storageDomain` durability is not wired, so
  a restart cannot resume mid-turn.
- The fork is maintenance debt. `scripts/diff-upstream.sh --check` pins the upstream commit and
  patch budgets; `ci-local.sh` and `verify-all.sh` enforce it.

## Non-goals

- Not a general agent framework; no LangGraph/LangChain competition.
- Not a craft/domain tool set.
- Not a second execution product beside the stock loop: B is the loop replacement.
- No new benchmark suite; product20 is the only product gate.

## Repository layout

```
packages/core/      capability graph, routing, topology, composer, contracts (private)
packages/loop/      graph driver (bounded fork) + LangGraph/Minimal kernel — ACTIVE
packages/mode/      Explore mode (agent preset) + graph policy
packages/graph-ui/  Graph tab (conversation.view) + /graph-chat API
bench/official/     Terminal-Bench product20 suite, smoke gate and DSH adapter
docs/               current status, architecture, evaluation and publishing notes
scripts/            build, install, verification and e2e scripts
test/unit/          node:test unit suite
```

## Install (default Web profile)

```sh
bash scripts/link-dsh.sh            # link the read-only DSH checkout packages
bash scripts/install-explore.sh     # default profile: web
dsh web                             # the stock agent-loop row is disabled
```

The installer adds the Graph-tab, driver and Explore-mode bundles, sets the
`agent-preset-registry` default to `explore`, and verifies that the stock `agent-loop` row is
`disabled: true`. The stock package stays installed because the shipped base bundle depends on it.

## Verify

```sh
bash scripts/ci-local.sh            # typecheck + tests + build + reproducibility + fork guard
bash scripts/verify-all.sh          # ci-local + installed e2e + tarball e2e + markdown links
```

## Product benchmark

```sh
bash bench/official/terminal-bench/preflight.sh
bash bench/official/terminal-bench/run-smoke.sh
TASKS_DIR=/tmp/tb-arm-dsh bash bench/official/subsets/run-product20.sh
```

Docker + Harbor and native arm64 task images are required. See [`bench/README.md`](bench/README.md)
for the image build and proxy notes.

## Requirements

- DeepSeek Harness `^0.2.1-rc.3`.
- `@langchain/langgraph@1.7.0` for the default kernel; `MinimalKernel` is the fallback.
- Checkpoints are in-memory in 0.2.

## Docs

- [`docs/STATUS.md`](docs/STATUS.md) — current facts, coverage, gaps.
- [`docs/MERGE-LANGGRAPH.md`](docs/MERGE-LANGGRAPH.md) — DSH / LangGraph / repo ownership.
- [`docs/EVALUATION.md`](docs/EVALUATION.md) — product20 protocol and reporting.
- [`docs/PUBLISHING.md`](docs/PUBLISHING.md) — package names and release steps.

## License

MIT. See [LICENSE](LICENSE).
