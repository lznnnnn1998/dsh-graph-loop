# dsh-graph-loop

A graph-native agent loop for DeepSeek Harness, shipped as an out-of-tree plugin +
bundle. The stock `agent-loop` row is disabled and replaced by `dsh-graph-loop`,
which runs one compiled graph node per DSH step. No DSH source is modified.

- Evaluation and full implementation plan: [`docs/explore-mode-plan.zh.md`](docs/explore-mode-plan.zh.md)
- Research evidence: [`research/`](research/)
- Design contracts: [`design/`](design/) · dynamic topology: [`docs/DYNAMIC-TOPOLOGY.md`](docs/DYNAMIC-TOPOLOGY.md)
- Build status: [`PROGRESS.md`](PROGRESS.md) · implementation notes: [`docs/IMPLEMENTATION.md`](docs/IMPLEMENTATION.md) · review: [`docs/RETROSPECTIVE.md`](docs/RETROSPECTIVE.md) · compliance audit: [`docs/COMPLIANCE.md`](docs/COMPLIANCE.md) · topology optimality: [`docs/TOPOLOGY-OPTIMALITY.md`](docs/TOPOLOGY-OPTIMALITY.md)

## Quick start

```sh
bash scripts/link-dsh.sh            # link the read-only DSH checkout packages
npm test                            # 36 unit tests
npm run e2e                         # dev overlay + mock LLM (3 graph nodes)
bash scripts/e2e-installed.sh       # install bundle B into a throwaway profile and run
bash scripts/e2e-propose.sh         # model-authored topology via graph_plan
bash scripts/e2e-subagents.sh       # parallel subagent branches in the graph
bash scripts/e2e-replan.sh          # boundary replan after a failed verify
bash scripts/e2e-graph-chat.sh      # standalone graph-chat page + API + screenshot
bash scripts/e2e-graph-tab.sh       # Graph tab inside the real Web chat UI
bash scripts/e2e-conformance.sh     # stock vs graph event invariants
bash scripts/e2e-cross-loop.sh      # resume stock->graph and graph->stock
bash scripts/ab-structural.sh       # structural A/B (mock; AB_REAL=1 for the real route)
bash compat/run.sh                  # DSH-style vitest + coverage in /tmp/dsh-compat
# published packages
dsh plugin --profile web add dsh-graph-loop-ui
dsh plugin --profile web add dsh-graph-loop
# or from a checkout: bash scripts/install-explore.sh
# repo: https://github.com/lznnnnn1998/dsh-graph-loop · packages: see docs/PUBLISHING.md
node scripts/preview.mjs /tmp/dsh-graph-traces preview   # offline topology preview
# Web UI: install packages/loop + packages/graph-ui, then open any session and click the Graph tab
node scripts/build-bundles.mjs      # rebuild packages/*/lib
```

To boot the Web UI with the graph driver from a DSH source checkout:

```sh
cd /path/to/deepseek-harness
DSH_HOME=/tmp/dsh-explore node --import tsx/esm apps/cli/src/bin.ts \
  --profile web --patch /path/to/dsh-graph-loop/packages/loop/dev.patch.yml
```

## Layout

```
packages/core/src/      graph model, matcher, step executor, design contracts
packages/loop/src/      forked agent-loop + graph scheduler + registry/router/tools rows
packages/mode/          bundle A: explore preset, policy, agent-reuse guard
scripts/                link-dsh.sh, e2e-headless.sh
test/unit/              pure unit tests
docs/                   the plan (Chinese)
research/               evidence base
```
