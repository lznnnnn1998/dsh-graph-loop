# dsh-graph-loop

A graph-native agent loop for DeepSeek Harness, shipped as an out-of-tree plugin +
bundle. The stock `agent-loop` row is disabled and replaced by `@dsh/explore-loop`,
which runs one compiled graph node per DSH step. No DSH source is modified.

- Evaluation and full implementation plan: [`docs/explore-mode-plan.zh.md`](docs/explore-mode-plan.zh.md)
- Research evidence: [`research/`](research/)
- Design contracts: [`design/`](design/)
- Build status: [`PROGRESS.md`](PROGRESS.md)

## Quick start (dev overlay, no install)

```sh
bash scripts/link-dsh.sh
npx tsc -p tsconfig.json --noEmit
node --import tsx --test test/unit/*.test.ts
bash scripts/e2e-headless.sh
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
