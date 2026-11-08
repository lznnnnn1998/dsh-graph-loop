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

## Kernel coverage

The exact table (plan shape → engine → test) lives in
[`docs/STATUS.md`](docs/STATUS.md#kernel-coverage-exact). Short version: the default kernel
evaluates every control-edge condition (`artifact`, `noArtifact`, `fact`, `callFailed`, and
`budget` on its step axis) and drives composed plans. Parallel fan-out/join, subagent batches and
reserved/nonconforming node ids fall back to **`FrontierTopology`**; a condition on a data edge is
rejected by plan validation because neither engine routes it. No claim is made that LangGraph
executes arbitrary graphs.

## What 0.2 builds

- **Per-turn topology** — task fingerprint → one plan per turn; one DSH step per node.
- **Per-turn capability envelope** — role/tool resolution; tool universe stable inside the turn.
- **Capability-driven synthesis** — stages (`discover`, `inspect`, `mutate`, `author`, `verify`) and
  artifact contracts, not hardcoded tool names.
- **Per-node tool admission** — a terminal node can run with no tools; the composed answer node
  keeps its tools so the turn can continue.
- **Per-stage classification** — every composed stage (`discover`, `inspect`, `mutate`, `author`,
  `verify`) has a step-scoped success fact and its own no-progress exit back to a repair node, so a
  stage that did nothing repairs instead of advancing. The author's guard is the stage's artifact
  *type*; the verify guard requires the node's planned verification tool to run. Failure exits are
  evaluated
  before the answer reserve, so a failed stage repairs even at the step-budget boundary instead of
  becoming the answer. The boundary recovery graph covers failures outside a composed plan.
- **Graph tab** — live topology, node → tool-call inspector, `/graph-chat` API.
- **Explore mode** — an agent preset installed as the default for new sessions.

## Status (honest)

- Unit suite, typecheck, and the release build gate are green:
  `npm test` (256 tests), `npm run typecheck`, `npm run build && npm run build:check`.
- Latest evaluator record is `f28de84` (253/253 at the gate; smoke 1.0 oracle / 1.0 graph / 1.0
  stock). Post-eval `63b5f20` narrows the verify signal to the planned verification tool and is
  256/256 at the cheap gate, but it has not been through the evaluator gate or smoke. The packaged
  tarball is still `f28de84` until the next repack.
- **No product benchmark aggregate.** Terminal-Bench easy10 + medium10 is defined in
  [`bench/official/subsets/product20.json`](bench/official/subsets/product20.json). The tracked
  2026-11-08 partial run
  ([result](bench/official/results/2026-11-08-product20-partial/README.md)) attempted 19/20 tasks
  (`formal-crypto` has no verifier image); 11 graph and 3 stock trials produced a valid score, only
  two tasks (`bun-sourcemap-leak`, `cargo-flight-dispatch`) are paired-valid, and every valid score
  is **0.0**. The reward is binary, so read the criteria: stock passed **35/37** on
  `bun-sourcemap-leak` (graph 18/37) and **33/40** on `cargo-flight-dispatch` (graph 32/40). The
  graph arm in that run used the **pre-fix** five-step chain, whose `n_answer` removed all tools
  (80 vs 217 session records): those graph scores measured premature termination, not a loop
  comparison. That plan shape is historical — the composer now emits per-stage repair/budget exits
  and a tool-enabled answer — so a rerun is required before any stock-vs-graph statement. The run
  is **invalid as a product aggregate; the instrument is unvalidated for the full suite.** A
  separate three-task oracle control
  ([result](bench/official/results/2026-11-08-oracle-control/README.md)) scores 1.0 on
  `html-js-filter`, `cargo-flight-dispatch` and `music-harmony`, so a 0.0 does not by itself measure
  the loop; only the task image, verifier and scoring path are validated. Do not cite accuracy,
  parity, token or cost from the partial run.
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

- DeepSeek Harness `0.2.2-rc.1` (the version the benchmark adapter installs and tests; workspace
  packages still declare `^0.2.1-rc.3`).
- `@langchain/langgraph@1.7.0` for the default kernel; `MinimalKernel` is the fallback.
- Checkpoints are in-memory in 0.2.

## Docs

- [`docs/STATUS.md`](docs/STATUS.md) — current facts, coverage, gaps.
- [`docs/MERGE-LANGGRAPH.md`](docs/MERGE-LANGGRAPH.md) — DSH / LangGraph / repo ownership.
- [`docs/EVALUATION.md`](docs/EVALUATION.md) — product20 protocol and reporting.
- [`docs/PUBLISHING.md`](docs/PUBLISHING.md) — package names and release steps.

## License

MIT. See [LICENSE](LICENSE).
