# Build progress — DSH `explore` graph loop

Local working repo. Nothing here edits the DSH checkout; the driver is loaded through
`--patch` (dev) or installed as a bundle (release).

## Working today (verified by running)

- [x] npm workspace + TS toolchain + DSH package symlinks (`scripts/link-dsh.sh`)
- [x] Core: graph schema / matcher / replan / kernel interface / conformance contracts
- [x] Core: deterministic registry builder (`packages/core/src/registry.ts`, impl-core)
- [x] Core: 6-template library incl. `t_stock` fallback (`packages/core/src/templates.ts`)
- [x] Core: step-graph executor + tests (`packages/core/src/step-graph.ts`)
- [x] Forked `agent-loop` (2,122 LOC) with a graph turn-driver seam
- [x] Registry row: live capability graph from `ctx.tools`, rebuild on `tools/change`
- [x] Router row: wires the template library into the driver
- [x] Driver row: per-turn match → plan → one graph node per DSH step
- [x] `graph_status` tool row
- [x] Bundle A (`packages/mode`): `explore` preset + policy section + roster context +
      `suggest_executor` + `spawn_teammate` duplicate guard (13 tests)
- [x] Bundle B (`packages/loop`): disables `agent-loop`, inserts the graph driver
- [x] Release build: esbuild → `packages/*/lib/*.js` (core bundled, DSH packages external)
- [x] **E2E dev overlay**: headless profile + mock LLM → 3 graph nodes
      (`n_discover → n_inspect → n_done`), `turn/end completed`
- [x] **E2E installed bundle**: profile created from the headless template, `dsh plugin add
      packages/loop`, same task → 3 graph steps, exit 0
- [x] 62 pure unit tests green
- [x] Composition evidence: `--dump-config` shows stock row disabled + graph rows inserted
      (installed profile), and `preset-explore` present with bundle A

## Just landed

- [x] Kernel: minimal stepwise + LangGraph 1.7 adapter behind `KernelPort`
      (`packages/loop/src/kernel/`), 26 tests incl. one-node-per-`next()` semantics,
      JSON checkpoint guard, budget mapping, fallback when LangGraph is absent
- [x] `lib/kernel.js` built and exported

## Not wired yet

- [ ] `graph_run` tool using `runPlan` (kernel is implemented and tested, the tool is not)
- [ ] Subagent-node plans + replan execution

## Not implemented yet (known gaps)

- Node `toolAllow` is soft (instruction only); the tool schemas are not gated per node.
  This is deliberate for v1 because per-step hard gating loses on KV-cache (research/04).
- Node instructions are injected as a logged user message (one per step). A later
  iteration should use a scoped prompt section to avoid history growth.
- Subagent nodes + replan are designed but not wired into the driver.
- No conformance replay-diff suite yet (16 obligations are documented in
  `packages/core/src/conformance.ts`; tests for them are pending).
- Cross-loop session resume (stock → graph) is not tested.
- The `graph_run` tool (run a full plan inside one tool call) is not implemented.

## Commands

```sh
bash scripts/link-dsh.sh                    # after any npm install
npm run typecheck                           # NODE_OPTIONS=8GB + tsc
npm test                                    # 62 unit tests
npm run e2e                                 # dev overlay + mock LLM
bash scripts/e2e-installed.sh               # installed bundle + mock LLM
node scripts/build-bundles.mjs              # rebuild lib/
```

## Reproduce the composition

```sh
cd /path/to/deepseek-harness
DSH_HOME=/tmp/dsh-explore node --import tsx/esm apps/cli/src/bin.ts \
  --profile explore --from-default-profile headless --dump-config
DSH_HOME=/tmp/dsh-explore node --import tsx/esm apps/cli/src/bin.ts \
  plugin --profile explore add /path/to/dsh-graph-loop/packages/loop
DSH_HOME=/tmp/dsh-explore node --import tsx/esm apps/cli/src/bin.ts \
  --profile explore --dump-config | grep -A3 'graph-loop'
```
