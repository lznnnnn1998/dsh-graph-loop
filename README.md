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
- **Corrected full product20 live (2026-11-09), no aggregate yet.** Colima is **8 vCPU / 20 GiB /
  150 GiB**; **20/20 env and 20/20 verifier** images are present, `formal-crypto` included; every env
  image carries the `tb-dsh-base` overlay (Node 24.9.0 + DSH 0.2.2-rc.1);
  `dist/dsh-graph-loop-bench.tgz` reproduces from HEAD; smoke is **1.0 oracle / 1.0 graph / 1.0
  stock** ([2026-11-09 record](bench/official/results/2026-11-09-smoke-prep/README.md)). The bounded
  four-task pre-run diagnostic first **failed** on two infrastructure faults
  ([2026-11-09-prediag-0122](bench/official/results/2026-11-09-prediag-0122/README.md)) and then
  **passed after fixes**
  ([2026-11-09-prediag-fixes](bench/official/results/2026-11-09-prediag-fixes/README.md)): all eight
  rows have `n_trials: 1` and `n_errors: 0`. The corrected product20 is **running** — PID `61129`,
  started 2026-11-09 17:19 +08, `OUT_DIR` `bench/official/results/2026-11-09-product20b/`
  (`runner.pid`, `rows.jsonl` growing per trial), log `/tmp/product20b-2026-11-09.log`, marker
  `/tmp/product20-shard-full.log` with no `_EXIT` yet, executed run commit `da3d598` (rows carry it;
  `b3e9af7` is the README-only wrapper committed after start), tarball
  `f7a961a797ca5e17…b12064`. The earlier 04:18:32 run (PID `38616`, `…/2026-11-09-product20/`) was
  **stopped at 31/40 and is NOT CITABLE**
  ([INVALID.md](bench/official/results/2026-11-09-product20/INVALID.md)). **No aggregate exists**; do
  not cite accuracy, parity, token or cost from partial rows or from the stopped run. A run is
  citable only when every trial passes [trial validity](docs/EVALUATION.md#trial-validity). Canonical
  state: [`docs/STATUS.md`](docs/STATUS.md#current-benchmark-state).
- **vpp/medical repaired locally for this run; canonical rebuild deferred.**
  `medical-claims-processing` now has valid expected-0.0 trials (graph 2/27, stock 22/27) on an
  arm64-native `playwright-mcp` sidecar; the prepared compose points at the local tag
  `tb-arm64-medical-claims-sidecar:latest`. The two `vpp-loss-divergence` images were patched
  out-of-band (both arms 4/5 criteria; stock 56m57s) because
  `bench/official/terminal-bench/build-arm64-task.sh` still uses Docker's legacy builder, which drops
  heredoc `RUN` bodies. **Do not rebuild vpp/medical or reset the task dirs while the run is live**;
  the BuildKit/de-heredoc fix and a scripted medical compose patch are deferred until the runner
  exits, and a canonical rebuild would reproduce both defects. Separately, the
  `workspace-write` file policy rooted at `/app` that capped `intrastat-meldung`, `roy-polymorph-cn`
  and `vpp-loss-divergence` for **both** arms (and would have capped `freight-dispatch-shift`) is
  **fixed at `da3d598`**: both arms now run under `sandbox-policy: danger-full-access`, verified by
  the post-fix smoke. The per-trial `write_capped` probe is still deferred
  ([`docs/EVALUATION.md`](docs/EVALUATION.md#instrument-defects-open)).
- **No product benchmark aggregate.** Terminal-Bench easy10 + medium10 is defined in
  [`bench/official/subsets/product20.json`](bench/official/subsets/product20.json); no aggregate
  exists for the current instrument. The **historical** 2026-11-08 partial run
  ([result](bench/official/results/2026-11-08-product20-partial/README.md)) was taken on the
  pre-repair instrument (4-CPU VM, 19/20 verifier images) and attempted 19/20 tasks; 11 graph and 3
  stock trials produced a valid score, only two tasks (`bun-sourcemap-leak`, `cargo-flight-dispatch`)
  are paired-valid, and every valid score is **0.0**. The reward is binary, so read the criteria:
  stock passed **35/37** on `bun-sourcemap-leak` (graph 18/37) and **33/40** on
  `cargo-flight-dispatch` (graph 32/40). The graph arm in that run used the **pre-fix** five-step
  chain, whose `n_answer` removed all tools (80 vs 217 session records): those graph scores measured
  premature termination, not a loop comparison. That plan shape is historical — the composer now
  emits per-stage repair/budget exits and a tool-enabled answer — so the live rerun must finish
  before any stock-vs-graph statement. The partial run is **invalid as a product aggregate** and is
  not current evidence. A separate three-task oracle control
  ([result](bench/official/results/2026-11-08-oracle-control/README.md)) scores 1.0 on
  `html-js-filter`, `cargo-flight-dispatch` and `music-harmony`, so a 0.0 does not by itself measure
  the loop. Do not cite accuracy, parity, token or cost from the partial run.
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
