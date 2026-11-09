# Progress

Architecture B: the dedicated graph-loop plugin in `packages/loop` replaces the stock `agent-loop`
through `AgentFactory`. Current focus is product evidence on Terminal-Bench product20, not new
features.

## Done

- [x] Graph driver replaces the stock loop, no DSH source edits.
- [x] Per-turn topology: fingerprint → plan → one DSH step per node.
- [x] Capability envelope + capability-driven composition.
- [x] LangGraph kernel default; every control-edge condition is kernel-routed, composed plans included.
- [x] Bounded recovery/repair for failed verify nodes; a non-zero shell exit is a verification
      signal, not a blanket stage failure. Every composed stage declares, in order, a budget exit
      to the tool-enabled answer first, failure/no-progress exits to one repair node, then its
      success exit; the repair node has no back-edge to its stage. Discover/inspect succeed on
      `toolSucceeded`, mutate on the shell-aware `wroteFile`, author on the step-scoped
      `produced.<type>`, verify on `verificationRan`/`verificationFailed`.
- [x] Frontier join barrier: a forward join waits for every predecessor that has entered the run,
      including depth-2+ branches, and a join on a cycle runs once per iteration; explicit repair
      back-edges still re-enter.
- [x] Per-node tool admission; the composed answer node keeps its tools so the turn can continue.
- [x] Subagent batch nodes (frontier path), child fallback.
- [x] Graph tab + `/graph-chat` API; SSE/tool-call inspector.
- [x] Explore mode, one-command installer, profile verification.
- [x] Fork guard: pinned upstream + patch budgets, enforced in `ci-local`/`verify-all`.
- [x] 277 unit tests, typecheck, build:check, installed e2e, tarball e2e green.

## In progress / next

- [ ] **product20 — corrected full run aborted at 5/40 (2026-11-09 19:44 +08), no aggregate yet.**
      Terminal-Bench easy10 + medium10, stock vs graph. The instrument was repaired on 2026-11-09
      (8 vCPU / 20 GiB / 150 GiB, **20/20 env + 20/20 verifier** images including `formal-crypto`,
      `tb-dsh-base` overlay on every env image, sidecars pulled, smoke 1.0/1.0/1.0), and the
      `workspace-write` cap was fixed at `da3d598` for **both** arms
      (`sandbox-policy: danger-full-access`), verified by the post-fix smoke
      (`bench/official/results/2026-11-09-smoke-sandbox/`). The bounded four-task pre-run diagnostic
      first failed and then **passed after the vpp/medical fixes**
      (`bench/official/results/2026-11-09-prediag-fixes/`; all eight rows `n_trials: 1`,
      `n_errors: 0`; its intrastat/vpp counts are pre-fix ceilings). The corrected run was then
      **aborted at 5/40** because the graph arm hit the stage-routing bug fixed at `4561008`: the
      marker `/tmp/product20-shard-full.log` ends `_EXIT`, PID `61129` is dead, OUT_DIR
      `bench/official/results/2026-11-09-product20b/` holds five rows, `ABORTED.md` and no summary,
      and no liveness signal remains. Executed run commit `da3d598`; its tarball
      `f7a961a797ca5e17…` is pre-HEAD. Its rows are **not citable** — do not merge, score or reuse
      that OUT_DIR. **Rerun is blocked on two items:** `dist/dsh-graph-loop-bench.tgz` is the
      pre-fix bundle and must be repacked from HEAD, and a bounded post-HEAD real-model pre-run
      (including a shell-write/routing task) must pass first (audit `20261109-1319` P0-2/P0-3).
      **No aggregate** — do not cite accuracy, parity, token or cost from partial rows. The earlier
      04:18:32 full run (PID `38616`, OUT_DIR `…/2026-11-09-product20/`) was **stopped at 31/40 and is
      NOT CITABLE** (`bench/official/results/2026-11-09-product20/INVALID.md`: 6 `TRANSPORT` crashes,
      6 file-policy-capped trials); do not merge its rows. **Historical:**
      the tracked 2026-11-08 partial run (`bench/official/results/2026-11-08-product20-partial/`) was
      taken on the pre-repair instrument and attempted **19/20** tasks: **11 graph / 3 stock** valid
      trials, only **2 paired-valid** tasks (`bun-sourcemap-leak`, `cargo-flight-dispatch`), all
      **0.0**. Reward is binary: stock passed **35/37** criteria on `bun-sourcemap-leak` (graph 18/37)
      and **33/40** on `cargo-flight-dispatch` (graph 32/40). That run measured the **pre-fix**
      five-step plan, whose `n_answer` removed every tool (80 vs 217 session records); the plan shape
      has since changed, so the partial run is invalid as a product aggregate and none of its numbers
      are citable. A three-task oracle control
      (`bench/official/results/2026-11-08-oracle-control/`) passes **1.0** (task image/verifier path,
      not the DSH arm), so those zeros are not a blanket harness artifact.
- [x] `medical-claims-processing` **fixed for this run.** The vendor `playwright-mcp` sidecar is
      amd64-only and never opened CDP 9222 under qemu; the prepared task now uses a local arm64-native
      sidecar (`tb-arm64-medical-claims-sidecar:latest`), so both arms have valid trials (graph 2/27,
      stock 22/27; reward is expected 0 because DSH has no native SSE-MCP client). **Remaining debt:**
      the compose image line is a local edit that a task-dir reset loses and the repo does not
      re-apply; the runner is stopped, but do not reset or rebuild before that fix lands.
- [x] `vpp-loss-divergence` **fixed for this run.** Docker's legacy builder silently drops the
      `RUN python - <<'PYEOF'` heredoc bodies (the CPU/gloo shim and `/opt/verifier_pristine`), so
      both images were patched out-of-band; graph and stock both score criteria **4/5** (stock
      56m57s). **Remaining debt:** `build-arm64-task.sh` still uses plain `docker build`, so a
      canonical rebuild reproduces the defect. Force BuildKit/`docker buildx` (or convert the
      heredoc), rebuild both images and re-verify both arms **after** the builder fix lands — the
      runner is stopped, but do not rebuild or retag yet. The default `workspace-write` policy rooted
      at `/app` that capped intrastat/roy/vpp on **both** arms (freight would have been too) was
      **fixed at `da3d598`**: both arms now get `sandbox-policy: danger-full-access`. Re-measure
      those tasks from a future completed run (the aborted `product20b` rows are not citable); the
      per-trial `write_capped` field is still deferred
      (`docs/EVALUATION.md#instrument-defects-open`).
- [ ] Graph termination, remaining part: the tool-stripping/forced-summary defect is fixed (the
      answer keeps tools and an exhausted plan gets a continuation step), but that continuation is a
      graph-to-stock hand-off bounded by the per-turn `maxSteps`, not graph routing. Decide whether
      to document it as intended or implement graph continuation.
- [ ] Durable checkpoints: `MemoryCheckpointer` only; the read/replay consumer is not designed.
- [ ] Kernel breadth: parallel fan-out, subagent batches and reserved node ids still use
      `FrontierTopology`; data-edge conditions are rejected by `validateTaskPlan` (`P023`) because
      neither engine routes them.
- [ ] Budget boundary: the kernel adapter reserves one step for a budget-routed wrap-up node; the
      frontier stops at the plan cap. Composed plans target 2 remaining steps so both have room, but
      one rule in both engines is still open.
- [ ] Product claim: none. No accuracy, parity or cost number from the partial run is citable.

## Known debt

- `packages/loop` is a source fork; `scripts/diff-upstream.sh` must be re-baselined deliberately
  when the DSH checkout moves.
- Benchmark heuristics are behind `benchGuards` (default off) and are not generic loop behavior.
- No hosted CI; `scripts/ci-local.sh` is the local gate.
- Composer stage order (`STAGE_ORDER`), the per-stage `successGuard` fact switch, the boundary
  `repairTopology`/`recoveryTopology` linear graphs and the template library stay explicit linear
  policies; they are a documented synthesis/recovery policy, not a discovered exit.
- Run-cumulative `artifact`/`noArtifact` conditions keep run-level meaning for model-authored plans;
  the composer uses step-scoped facts for stage success.

## Commands

```sh
npm run typecheck
npm test
npm run build && npm run build:check
bash scripts/ci-local.sh
bash scripts/verify-all.sh
bash scripts/install-explore.sh
```
