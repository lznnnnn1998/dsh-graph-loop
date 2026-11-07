# Build progress — DSH composition layer

Local working repo. Nothing here edits the DSH checkout.

## Direction reset (2026-11-06)

0.2 is the **composition layer**, not a fork-first graph loop. The decision record and v0.2 contract
are in [`docs/COMPOSITION.md`](docs/COMPOSITION.md). Summary:

- one graph per turn; harness-owned executors (`step` / `tool-batch` / `subagent` / `context`);
- per-turn capability envelope; tools stable inside the turn, prompt/memory vary per node;
- authoritative checkpoints in `storageDomain`; the session log stays the conversation record;
- control plane over the stock loop first; fork only if 2+ triggers fire;
- evaluation: OfficeBench 5-task single-app probe across three arms, then a public head-to-head
  report; no 1.0 gate; the probe is the first hard decision point;
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
- [x] **M2 — checkpoint contract**: `GraphCheckpoint` / `CheckpointStore` / `TableCheckpointStore`
      (storageDomain-shaped) / `InMemoryCheckpointStore` (`packages/core/src/checkpoint.ts`),
      10 unit tests. JSON guard, 64 KiB cap, stable keys, deterministic latest, prune by turn.
- [x] **Verification**: 108 unit tests green; `npm run typecheck` clean.
- [x] **M3a — measurable graph runtime (installable bundle)**: per-plan/per-node tool admission,
      mutation detection, answer-only terminal nodes, safe tool floor, and a non-null turn end when
      the graph finishes. Local real-model evaluation, 2 repetitions × 6 tasks: **12/12 success for
      both arms**, median prompt **23,466 → 9,237 (−61%)**, median steps **4 = 4**, median wall
      **14.9 s → 14.8 s** (parity). See [`bench/agent-eval/RESULTS.md`](bench/agent-eval/RESULTS.md).
      The bundle builds and `scripts/e2e-installed.sh` passes; no DSH source is modified.
- [x] **M3b — installed-profile real-model run**: `bench/agent-eval/prepare-installed.sh` creates a
      throwaway stock `headless` profile and an `explore` profile with `dsh plugin add packages/loop`
      (no `--patch`, no DSH source changes). 6/6 both arms; median steps **5 → 4**, median prompt
      **26,733 → 9,267 (−65%)**, median wall 15.6 s → 17.9 s (noise-dominated). Raw rows:
      [`bench/agent-eval/results/2026-11-07-installed.json`](bench/agent-eval/results/2026-11-07-installed.json).
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
      Async driver interface; 3 new unit tests; 115 total tests. Live eval: **6/6 both arms**, median
      prompt **23,516 → 9,128 (−61%)**, steps 4 = 4; wall time was noise-dominated (86–92 s stalls on
      three graph runs). Kernel checkpoints are still in-memory.
- [ ] **M3e — kernel coverage + durable checkpoint**: route conditional/failure edges and subagent
      batches through the kernel, then replace `MemoryCheckpointer` with the `storageDomain` saver.
- [ ] **M3 — control plane over the stock loop** (product path; the measured graph above is the
      graph driver installed as a bundle): step nodes, late prompt section, node boundaries,
      checkpoint writes, annotation/preset feed, conformance for ordinary chat.
- [x] **M4a — local 20-task pre-signal**: 20 tasks × 2 arms × 2 reps on the 1017 model; **40/40
      both**, prompt **24,454 → 9,612 (−60.7% mean; −59.5% median)**, steps 4.1 → 4.0; wall mixed
      (+5.9% mean / −7.4% median). Checks validated negative/positive; results and manifest in
      [`bench/agent-eval/RESULTS.md`](bench/agent-eval/RESULTS.md). Also added `toolPolicy: preset`,
      optional read nodes, DSML formatting retry, and mutation detection for merge/rename tasks.
- [ ] **M4b — official harness**: Docker/Colima + Harbor + the Terminal-Bench DSH adapter
      ([`bench/official/terminal-bench/dsh_agent.py`](bench/official/terminal-bench/dsh_agent.py))
      run real tasks end to end. The fixed 7-task subset scored **0.0 on every clean trial**; stock
      timeouts on three tasks, payments sidecar images missing. No aggregate. NL2Repo-Bench still
      needs an OpenHands→DSH adapter.
      See [`bench/official/results/terminal-bench-subset/`](bench/official/results/terminal-bench-subset/).
- [ ] **M5 — official head-to-head** (Terminal-Bench + NL2Repo) + public report + 0.2.0.
- [ ] **Gate at M4b:** continue / change benchmark / stop. No 1.0.
