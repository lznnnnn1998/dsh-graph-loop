# Status — 2026-11-08

One-page snapshot of the repository. Architecture: **B** — the dedicated graph-loop plugin in
`packages/loop` replaces the stock `agent-loop` through `AgentFactory`. Ownership map:
[MERGE-LANGGRAPH.md](MERGE-LANGGRAPH.md). Historical decision records (superseded):
[archive/COMPOSITION.md](archive/COMPOSITION.md), [archive/PRODUCT-LINE.md](archive/PRODUCT-LINE.md).

## What this is

A DSH-native graph loop, installed as a bundle: the stock `agent-loop` row is disabled, a graph
driver plus a LangGraph kernel runs the turn, the Graph tab shows the topology, and the **Explore**
mode is the default for new sessions. No DSH source files are modified.

## Works today

| Layer | State |
|---|---|
| Install | `bash scripts/install-explore.sh [profile]` (default `web`) installs driver + Graph tab + Explore mode; verifies `agent-loop` disabled, `preset-explore` present, `agent-preset-registry.default = explore` |
| Mode | Explore preset registered; new sessions default to it (explicit user selection still wins) |
| Kernel | `createKernel()` / `runPlan()` default to **LangGraph**; `MinimalKernel` fallback when the optional dependency is absent |
| Live driver | `KernelTopology` pauses the kernel before a node, DSH runs the step, the kernel resumes with the outcome. See the coverage table below |
| Composition core | envelope / role resolution / capability composer **live in dynamic mode**; unit suite green |
| UI | Graph tab + `/graph-chat`; installed e2e passes |
| Packaging | tarball install + packed-loop runtime e2e passes (`scripts/e2e-tarball.sh`); `npm run build && npm run build:check` green |

## Kernel coverage (exact)

| Plan shape | Engine | Evidence |
|---|---|---|
| Linear chain (`always`/no condition, one control out-edge per node) | **LangGraph** (`KernelTopology`) | `test/unit/kernel-topology.test.ts`, `test/unit/kernel-langgraph.test.ts` |
| Linear + one `callFailed` failure branch (success edge + recovery edge) | **LangGraph** — real conditional edge, one of two declared destinations taken | `test/unit/kernel-topology.test.ts` (`takes the callFailed branch`, `follows the success edge`) |
| Parallel fan-out / two-branch join | `FrontierTopology` | `test/unit/topology.test.ts` |
| Subagent batches | `FrontierTopology` | `test/unit/scheduler.test.ts` |
| `artifact` / `noArtifact` / `fact` / `budget` conditions; conditions on `data` edges | `FrontierTopology` | `canKernelDrive()` rejects them |
| Node ids with `:` or LangGraph-reserved names | `FrontierTopology` | `canKernelDrive()` rejects them |

No claim is made that LangGraph executes arbitrary graphs: parallel branches, subagent fan-out and
non-`callFailed` conditions are frontier features today.

## Evidence

**Product evidence is absent.** The active suite is Terminal-Bench easy10 + medium10
([`bench/official/subsets/product20.json`](../bench/official/subsets/product20.json)); it is
**defined but not yet run**. The earlier archived local 20-task run is **not reproducible**: it ran
on a dirty worktree whose recorded commit contains no live composition code, and even there the
billed total rose. Its prompt-token numbers are historical, not a product claim — see
[`bench/archive/agent-eval/RESULTS.md`](../bench/archive/agent-eval/RESULTS.md) and the provenance
note in the run manifest.

**Stress line:** Terminal-Bench hard subset 0.0 on clean trials; smoke 1.0. Not the product gate.
See [`STRESS-LINE.md`](STRESS-LINE.md).

## Known gaps

1. **Kernel coverage is partial**: parallel fan-out/join, subagent batches and non-`callFailed`
   conditions still use `FrontierTopology`.
2. **Checkpoints are in-memory** (`MemoryCheckpointer`); `storageDomain` persistence and
   `getStateHistory` are not wired, so a restart cannot resume mid-turn.
3. **The Terminal-Bench product suite is defined but not run**; it needs native builds for the 20
   selected tasks (some have sidecars/desktop deps).
4. **The stress line is 0.0 on hard tasks**; it is diagnostic, not the product gate.
5. **Fork duplication** remains: `packages/loop` is a source copy of DSH's loop, re-diffed with
   [`scripts/diff-upstream.sh`](../scripts/diff-upstream.sh) (expected patch surface is documented in
   the script).
6. **Benchmark heuristics are gated off by default**: DSML-text detection and the forced mutation
   retry now require `benchGuards: true` on the `graph-loop` row. They are harness-specific, not
   graph semantics.

## Next, in order

1. Build and run the Terminal-Bench easy10 + medium10 product suite (stock vs composition) before
   making any product claim.
2. Keep the smoke gate; do not substitute hard stress tasks.
3. Wire the `storageDomain` checkpoint saver and session-event node trail.
4. Extend kernel coverage to one parallel shape only if the live loop gains a legitimate parallel
   step (it has none today); otherwise keep the frontier capability and stop claiming LangGraph owns
   arbitrary graphs.

## Commands

```sh
npm run typecheck                        # tsc --noEmit over packages/** + test/**
npm test                                 # unit suite
npm run build && npm run build:check     # release gate (lib reproducible from source)
bash scripts/ci-local.sh                 # typecheck + test + build gate (no external services)
bash scripts/install-explore.sh          # install into the web profile
bash scripts/e2e-installed.sh            # installed bundle e2e (mock LLM)
bash scripts/e2e-tarball.sh              # packed-tarball install path
bash scripts/verify-all.sh               # typecheck + tests + both e2e + links
bash scripts/diff-upstream.sh            # fork patch surface vs the DSH checkout
bash bench/official/terminal-bench/preflight.sh  # Docker + Harbor + DSH adapter
bash bench/official/terminal-bench/run-smoke.sh  # 1.0 oracle/graph/stock; run BEFORE subsets
bash bench/official/terminal-bench/run-subset.sh /tmp/tb-arm-dsh   # product20, after native builds
```
