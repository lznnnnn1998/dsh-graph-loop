# Build progress — 0.2 cycle (historical)

Local working repo. Nothing here edits the DSH checkout.

> **HISTORICAL (2026-11-08).** This is the 0.2 working log, kept for history.
> Architecture **B** is the active direction: the dedicated graph loop in
> `packages/loop` replaces the stock `agent-loop` via `AgentFactory`
> ([README.md](README.md), [docs/STATUS.md](docs/STATUS.md)). The
> "direction reset" below and the M3 control-plane item are **superseded**; do
> not treat them as the current contract. The local-20 numbers are from a dirty,
> non-reproducible worktree and are not a product claim.

## Direction reset (2026-11-06) — RETIRED by architecture B

> Superseded: the lead decision is architecture B. The text below is the retired 0.2
> framing, kept verbatim as history (decision record archived at
> [`docs/archive/COMPOSITION.md`](docs/archive/COMPOSITION.md)). Summary of the retired framing:

- one graph per turn; harness-owned executors (`step` / `tool-batch` / `subagent` / `context`);
- per-turn capability envelope; tools stable inside the turn, prompt/memory vary per node;
- authoritative checkpoints in `storageDomain`; the session log stays the conversation record;
- ~~control plane over the stock loop first; fork only if 2+ triggers fire~~ (retired);
- product evaluation: 10 easy + 10 medium Terminal-Bench tasks; the local 20-task suite is archived;
  stress evaluation: Terminal-Bench smoke then a fixed subset, not the default gate;
- craft-first demo removed as the proof of value; crafts remain genericity fixtures;
- `packages/loop` is the **active graph driver** (a source fork, tracked as maintenance debt); `packages/mode` (Explore) is the active mode and installed by default for new sessions.

The 0.1.x build history is archived in [`docs/archive/PROGRESS-0.1.md`](docs/archive/PROGRESS-0.1.md).

## Value and end state (2026-11-06)

- **Value:** a DSH-native, tool-agnostic plugin that is measurably better than the official default
  experience on a public benchmark, and that external users install, use and extend.
- **Personal value:** community contribution; not a business, résumé piece or general framework.
- **End state:** product + evidence, third-party template ecosystem, sustainable OSS. No 1.0 gate.
- **Hedge if the claim fails:** Graph tab (observability) + reusable composition contract.
- **Non-goals:** general agent framework, craft/domain toolset, fork-first loop, research project.
- Full protocol: [`docs/EVALUATION.md`](docs/EVALUATION.md).

## 0.2 milestones

- [x] **M0 — direction reset**: decision record + contract (`docs/COMPOSITION.md`); README/PROGRESS
      updated; the driver kept as the active graph loop; `packages/mode` kept as the active Explore mode.
- [x] **M1 — capability envelope**: role vocabulary + deterministic resolution + task-driven
      selection (`packages/core/src/envelope.ts`), 20 unit tests. Conditional/dynamic tools are
      excluded by default; template roles bind by explicit `implementations`.
- [x] **M1b — tool-agnostic participation**: the default role vocabulary contains no product or
      craft name. Any tool becomes routable through data annotations (`applyAnnotations`), artifact
      roles (`produces:<type>`), template implementations, task hints, or the preset baseline;
      unannotated tools are never silently dropped when one of those paths applies.
- [x] **M1c — capability-driven synthesis**: `packages/core/src/compose.ts` builds plans from stages
      (`discover → inspect → mutate → author → verify → deliver`) and artifact contracts only, never
      tool names. Craft-like, MCP-only and annotation-only registries compose; an empty envelope
      degrades to a single generic step instead of dropping the task. 5 unit tests; 0.1.x
      `topology.ts` / `templates.ts` marked legacy.
- [x] ~~**M2 — checkpoint contract**~~ — **withdrawn**: the `GraphCheckpoint` / `CheckpointStore` /
      `TableCheckpointStore` / `InMemoryCheckpointStore` contract in
      `packages/core/src/checkpoint.ts` (10 unit tests) had zero production importers and was deleted
      in the 0.2 audit; it was never wired. Durable checkpointing remains future work on the live
      `MemoryCheckpointer`/LangGraph saver path (`docs/STATUS.md`, `docs/MERGE-LANGGRAPH.md` §3.3).
- [x] **Verification**: the unit suite green; `npm run typecheck` clean.
- [x] **M3a — measurable graph runtime (installable bundle)**: per-plan/per-node tool admission,
      mutation detection, answer-only terminal nodes, safe tool floor, and a non-null turn end when
      the graph finishes. Local real-model evaluation, 2 repetitions × 6 tasks: **12/12 success for
      both arms**, median prompt **23,466 → 9,237 (−61%)**, median steps **4 = 4**, median wall
      **14.9 s → 14.8 s** (parity). See [`bench/archive/agent-eval/RESULTS.md`](bench/archive/agent-eval/RESULTS.md).
      The bundle builds and `scripts/e2e-installed.sh` passes; no DSH source is modified.
- [x] **M3b — installed-profile real-model run**: `bench/archive/agent-eval/prepare-installed.sh` creates a
      throwaway stock `headless` profile and an `explore` profile with `dsh plugin add packages/loop`
      (no `--patch`, no DSH source changes). 6/6 both arms; median steps **5 → 4**, median prompt
      **26,733 → 9,267 (−65%)**, median wall 15.6 s → 17.9 s (noise-dominated). Raw rows:
      [`bench/archive/agent-eval/results/2026-11-07-installed.json`](bench/archive/agent-eval/results/2026-11-07-installed.json).
- [x] **M3c — default install + default mode + kernel default**: `scripts/install-explore.sh` now
      defaults to the `web` profile, installs Graph-tab + driver + the **Explore mode**, creates a
      custom profile from the web template when needed, and fails unless `graph-loop`/`graph-ui`/
      `preset-explore` are present, the stock `agent-loop` row is `disabled: true`, and
      `agent-preset-registry.default = explore`. The stock package stays installed because the base bundle depends on it.
      `createKernel()`/`runPlan()` now default to `langgraph` with a transparent `MinimalKernel`
      fallback.
- [x] **M3d — kernel round-trip (kernel-drivable plans)**: the scheduler now uses `KernelTopology`
      (LangGraph `KernelPort`, pause-before-node bridge, one superstep per DSH step) for linear plans
      with safe node ids and no subagent/conditional edges; other plans keep `FrontierTopology`.
      Async driver interface; 3 new unit tests; the full suite green. Live eval: **6/6 both arms**, median
      prompt **23,516 → 9,128 (−61%)**, steps 4 = 4; wall time was noise-dominated (86–92 s stalls on
      three graph runs). Kernel checkpoints are still in-memory.
- [x] **M3e (partial) — kernel coverage**: one real `callFailed` failure branch now runs on the
      LangGraph kernel (conditional edge; both arms tested). Parallel fan-out/join, subagent batches,
      and `artifact`/`fact`/`budget` conditions remain on `FrontierTopology`. Durable checkpointing is
      still pending: `MemoryCheckpointer` remains, `storageDomain` is not wired.
- [ ] ~~**M3 — control plane over the stock loop**~~ **RETIRED** by architecture B; do not build it.
- [x] **M4a — legacy local 20-task signal (archived)**: 20 tasks × 2 arms × 2 reps; **40/40 both**, prompt
      **24,454 → 9,612 (−60.7%)** legacy; live envelope/compose rerun is **25,105 → 12,561
      (−50.0% mean; −48.6% median)**, steps 4.2 → 4.0. Cost is not a win: billed input +33.8% legacy /
      −8.6% live, billed total **+44.6% / +16.8%**, output +55.2% / +41.2% (the repo's K3 abandon
      criterion triggers in both runs). Both runs are dirty-worktree, not commit-bound. The active claim
      is now the TB product suite. Results:
      [`bench/archive/agent-eval/RESULTS.md`](bench/archive/agent-eval/RESULTS.md).
- [x] **M4b — Terminal-Bench stress line**: Docker/Colima + Harbor + DSH adapter; smoke 1.0 on
      oracle/graph/stock; hard subset 0.0 on clean trials. This is a stress finding, **not the
      default gate**. See [`docs/STRESS-LINE.md`](docs/STRESS-LINE.md) and
      [`bench/official/results/`](bench/official/results/).
- [ ] **M5 — product head-to-head** (Terminal-Bench easy10 + medium10) + public report + 0.2.0; stress
      line remains diagnostic.
- [ ] **Gate at M4a/M5:** product accuracy parity + token/steps win; stress does not gate the product.
