# dsh-graph-loop

A dedicated **graph loop** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).
It replaces the stock `agent-loop` through DSH's `AgentFactory` seam and runs **one graph per
turn**: the nodes are ordinary DSH steps. It is installed as a bundle; no DSH source file is
modified.

**Architecture B — the fork is the active loop.** `packages/loop` is a bounded source fork of DSH's
agent loop. It keeps DSH's session log, turn/step machine, prompt assembly, tool pipeline,
approvals, compaction and projections, and adds the graph-specific hooks (turn-graph stepping,
per-node tool admission, subagent batches, stage routing, failure recovery). LangGraph is the
default kernel; `FrontierTopology` executes plan shapes the kernel adapter does not own. The fork
surface is pinned and diff-enforced by `scripts/diff-upstream.sh`.

## Kernel coverage

The exact table (plan shape → engine → test, with source files) lives in
[`docs/KERNEL-COVERAGE.md`](docs/KERNEL-COVERAGE.md). Short version: the default kernel evaluates
every control-edge condition (`artifact`, `noArtifact`, `fact`, `callFailed`, `budget` on its step
axis) and drives composed plans. Parallel fan-out/join, subagent batches and reserved/nonconforming
node ids run on **`FrontierTopology`**; a condition on a data edge is rejected by plan validation
because neither engine routes it. No claim is made that LangGraph executes arbitrary graphs.

## What 0.2 builds

- **Per-turn topology** — task fingerprint → one plan per turn; one DSH step per node.
- **Per-turn capability envelope** — role/tool resolution; the tool universe is stable inside the
  turn.
- **Capability-driven synthesis** — stages (`discover`, `inspect`, `mutate`, `author`, `verify`) and
  artifact contracts, selected from the live registry, not hardcoded tool names.
- **Per-node tool admission** — an answer-only node (`toolAllow: []`) can run with no tools; the
  composed answer node keeps its tools so the turn can continue.
- **Composed stage routing** — each stage declares, in evaluation order: a budget exit to the
  tool-enabled answer first, its failure/no-progress exits to one repair node, then its success
  exit. The repair node mirrors those exits to the answer and has no back-edge to its stage, so a
  stage gets one repair attempt and the answer continues abandoned work. Success guards are
  step-scoped: `toolSucceeded` for discover/inspect, the shell-aware `wroteFile` for mutate,
  `produced.<type>` for author, and `verificationRan`/`verificationFailed` for verify. The answer is
  a **continuation, not a success claim**.
- **Failure recovery** — bounded recovery/repair graphs when a work node fails; failed turns are
  reported as `GRAPH_FAILED`.
- **Graph tab** — live topology, node → tool-call inspector, `/graph-chat` API.
- **Explore mode** — an agent preset installed as the default mode for new sessions.
- **One-command installer** — wires driver, Graph tab and Explore mode into a DSH profile and
  verifies the composition.

## Limitations

- The kernel checkpointer is **in-memory** (`MemoryCheckpointer`, a per-run cache); `storageDomain`
  durability is not wired. A completed node boundary is recorded in the session log
  (`plugin:graph-loop/checkpoint`), so a later turn resumes a kernel-driven plan at the pending node
  instead of re-running completed ones; a frontier-owned plan records no checkpoint and starts a
  fresh plan.
- The fork is maintenance debt. `scripts/diff-upstream.sh --check` pins the upstream commit and
  patch budgets; `scripts/ci-local.sh` and `scripts/verify-all.sh` run it when a DSH checkout is
  available.
- Kernel coverage is partial by plan shape, not by condition: parallel fan-out/join, subagent batches
  and reserved/nonconforming node ids use `FrontierTopology`, and a condition on a data edge is
  rejected by `validateTaskPlan` because neither engine routes it.
- Graph runtime state (run records, live snapshots, turn traces) is process-local, so the Graph tab
  keeps no graph history across a host restart; session history is unaffected.
- This README makes no accuracy, parity, token or cost claim. Product evidence is tracked outside
  the published tree and is not part of the installable package.

## Repository layout

```
packages/core/      graph model, registry, matching, envelope, composer, conditions, kernel ports (private)
packages/loop/      graph driver (bounded fork) + LangGraph/Minimal kernel — ACTIVE
packages/mode/      Explore agent preset + graph policy + duplicate-spawn guard
packages/graph-ui/  Graph tab (conversation.view) + /graph-chat API
docs/               kernel coverage, ownership, publishing
scripts/            build, install, fork guard and verification scripts
test/unit/          node:test unit suite
marketplace/        marketplace listing metadata for the published packages
```

## Install

From npm into a DSH profile:

```sh
dsh plugin --profile web add dsh-graph-loop
dsh plugin --profile web add dsh-graph-loop-ui
dsh plugin --profile web add dsh-graph-loop-mode   # Explore preset and default mode
```

The driver bundle disables the stock `agent-loop` row; the stock package stays installed because the
shipped base bundle depends on it. A headless profile needs only `dsh-graph-loop`.

From a source checkout, one command installs and verifies the same three bundles:

```sh
bash scripts/install-explore.sh web        # default profile: web
dsh web                                    # graph rows active, stock agent-loop disabled
```

The installer requires a local DeepSeek Harness checkout; its header documents the environment
override. For repository development, link that checkout's packages first:

```sh
npm ci
bash scripts/link-dsh.sh                   # symlink the read-only DSH checkout packages
```

## Verify

```sh
npm run typecheck
npm test                                   # node:test unit suite, no model
npm run build && npm run build:check       # bundles + reproducibility
bash scripts/ci-local.sh                   # product gate; maintainer-only checks skip outside the maintainer environment
bash scripts/verify-all.sh                 # product + installed/tarball e2e; same caveat
```

The end-to-end scripts need a DSH checkout and a mock LLM server; `diff-upstream.sh` skips cleanly
without one.

## Requirements

- DeepSeek Harness satisfying the driver's `engines.dsh` range (`^0.2.2-rc.1` in
  `packages/loop/package.json`).
- Node 24+ (the bundles target Node 24; the workspace types are `@types/node` 24).
- `@langchain/langgraph` 1.7.0 is an optional dependency; when it is absent the driver falls back to
  the MinimalKernel.
- A DeepSeek Harness checkout for development, type checking and the end-to-end checks (see
  [Install](#install)).

## Docs

- [`docs/README.md`](docs/README.md) — documentation index and the docs contract.
- [`docs/KERNEL-COVERAGE.md`](docs/KERNEL-COVERAGE.md) — plan shape → engine → test.
- [`docs/MERGE-LANGGRAPH.md`](docs/MERGE-LANGGRAPH.md) — DSH / LangGraph / repo ownership.
- [`docs/PUBLISHING.md`](docs/PUBLISHING.md) — package names and release steps.
- Package docs: [`core`](packages/core/README.md), [`loop`](packages/loop/README.md),
  [`graph-ui`](packages/graph-ui/README.md), [`mode`](packages/mode/README.md).

## License

MIT. See [LICENSE](LICENSE).
