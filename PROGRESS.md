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

## Just landed (packaging + cross-loop + structural A/B)
- [x] **One-command install**: `scripts/install-explore.sh` installs the driver bundle + the Graph-tab
      bundle and verifies the composed rows. `graph-ui` is now its own bundle layer.
- [x] **Cross-loop resume e2e**: stock→graph and graph→stock both pass; event invariants hold on the
      resulting logs (`scripts/e2e-cross-loop.sh`).
- [x] **Stronger conformance**: turn/step numbering must be contiguous, in addition to pairing and
      tool-call/result checks.
- [x] **Structural A/B harness**: `scripts/ab-structural.sh` + `docs/AB-STRUCTURAL.md`. Mock route now;
      `AB_REAL=1` runs the same tasks against the real model. First data: graph adds steps/bytes on
      non-trivial tasks, wins on trivial ones (triage).
- [x] Split dev patches: `dev-headless.patch.yml` (no Web rows) vs `dev.patch.yml` (Web rows), so
      headless runs no longer warn about the pending `webServer` row.

## Previously landed (usability + reliability pass)
- [x] **Graph tab node inspector**: click a node → instruction + its tool calls (name, ok/error) +
      `open in trajectory` buttons using the conversation view's `openView('trajectory', callId)`.
- [x] **Conformance invariants**: `scripts/e2e-conformance.sh` runs the same task through stock and
      graph loops and checks turn/step pairing, tool call→result pairing, assistant-without-header,
      and open-turn/step leftovers on both logs (`scripts/conformance-diff.mjs`). Both pass.
- [x] Synthesis no longer adds a spurious write node for "summarize a document" tasks.
- [x] Graph tab e2e drives a node click and asserts the tool-call inspector; screenshot refreshed.

## Previously landed (reflection + live Graph tab)
- [x] `docs/RETROSPECTIVE.md`: honest list of regressions, keepers, and potentially disruptive ideas.
- [x] Graph tab now uses **SSE** (`/graph-chat/api/events`) with polling fallback; live snapshots carry
      plan + trail + replans, so a running turn renders before it closes.
- [x] **Triage**: trivial tasks (<32 chars, no artifacts) stay a single step instead of paying for a graph.
- [x] **Child agents** force the single-node fallback, so subagent children no longer recurse into
      dynamic topology (previous failure mode).
- [x] 73 unit tests; Graph-tab e2e still passes.

## Previously landed (Graph tab in the existing Web chat)
- [x] **Graph is now a conversation-view tab** registered through `ctx.slots` `conversation.view`
      (order 5, between Chat and Trajectory). The whole existing chat shell is reused: composer,
      model selector, voice input, mode chip, agent-team/subagent list, trajectory, sidebar.
- [x] Client half lives in its own package `@dsh/explore-graph-ui` (client-modules requires one
      active Loader entry per client package; putting it in the driver package collided with the
      driver's subpath rows).
- [x] E2E drives the real UI with Puppeteer: dismisses the preview notice, types a message,
      verifies `Chat,Trajectory,Graph`, clicks Graph, screenshots `preview/graph-tab-live.png`.
- [x] Standalone `/graph-chat` page remains for API/headless/dev use.

## Previously landed (graph-chat page)
- [x] Live `graph-chat` page at `/graph-chat` served by a host plugin: chat on the left, the current
      turn's topology on the right, polling the graph runtime every 1.2s. New chat + send message APIs.
- [x] `POST /api/new` binds the `standard` preset so preset-scoped tools are visible (the host view
      only had 3 globals; the fix uses `ctx.agentPresets.select` + agent-scoped tool resolution).
- [x] `POST /api/send` goes through `agent.followup()`, the same path as the Web input.
- [x] E2E: `scripts/e2e-graph-chat.sh` starts a real Web host + mock LLM, sends a message over HTTP,
      asserts a 4-node dynamic topology, and captures `preview/graph-chat-live.png` with headless Chrome.
- [x] Offline preview remains for arbitrary trace dirs (`scripts/preview.mjs`).

## Previously landed (parallel subagents, boundary replan, preview)
- [x] Graph nodes can be `subagent` executions: a batch of ready subagent nodes runs concurrently via
      `ctx.subagents.startActivation({delivery:'caller'})`, results are injected as `[subagent <node>]`
      context for the join node. Children do not fan out again (`delegationDepth > 0` disables nested
      subagent synthesis). E2E: `scripts/e2e-subagents.sh` (2 parent steps, 2 children).
- [x] Boundary replan: a failing verify tool (`bash`/`pwsh` `tool/result` `isError`) marks the node failed;
      a pre-declared `callFailed` edge is taken, otherwise a recovery subgraph
      `r_diagnose → r_retry → r_answer` is installed (bounded by `maxReplans`).
      E2E: `scripts/e2e-replan.sh` (6 steps, recovery nodes ran).
- [x] Preview panel: `graph-runtime.traceDir` writes per-turn `{plan, trail, rationale, depth, replans}`;
      `scripts/preview.mjs` renders `preview/index.html` (SVG topology + information flow + node inspector,
      roots first, child turns labelled). Open the generated file directly.
- [x] 73 unit tests + 10 e2e suites green

## Previously landed (dynamic topology)
- [x] `synthesizeTopology`: arbitrary DAG from the capability graph (no template): discovery,
      inspect→edit→verify, parallel research fan-out, terminal answer (`packages/core/src/topology.ts`)
- [x] `FrontierTopology`: frontier executor with runtime `addNode/removeNode/addEdge`, bounded cycles,
      conditional/failure edges
- [x] `graph_plan` tool + proposal validator: the model authors any node/edge topology; the harness
      validates against the registry/budget and the driver adopts it (`proposal.ts`, `tools.ts`)
- [x] Three topology modes `template | dynamic | propose` + `adoptPolicy` (default `start-only`,
      i.e. topology is fixed once real work starts)
- [x] E2E: dynamic synthesis (4 nodes) and **model-authored topology** (model called `graph_plan`,
      harness adopted `p1→p2`, both nodes ran)
- [x] Design rationale: `docs/DYNAMIC-TOPOLOGY.md`

## Previously landed

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
