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
      signal, not a blanket stage failure. Every composed stage classifies its own success with a
      step-scoped fact (discover/inspect/mutate/author/verify), so no stage advances on no progress;
      failure exits are evaluated before the answer reserve.
- [x] Frontier join barrier: a forward join waits for every predecessor that has entered the run,
      including depth-2+ branches, and a join on a cycle runs once per iteration; explicit repair
      back-edges still re-enter.
- [x] Per-node tool admission; the composed answer node keeps its tools so the turn can continue.
- [x] Subagent batch nodes (frontier path), child fallback.
- [x] Graph tab + `/graph-chat` API; SSE/tool-call inspector.
- [x] Explore mode, one-command installer, profile verification.
- [x] Fork guard: pinned upstream + patch budgets, enforced in `ci-local`/`verify-all`.
- [x] 256 unit tests, typecheck, build:check, installed e2e, tarball e2e green.

## In progress / next

- [ ] **product20 — blocked by the failed 2026-11-09 pre-run diagnostic.** Terminal-Bench easy10 +
      medium10, stock vs graph. The instrument was repaired on 2026-11-09 (8 vCPU / 20 GiB / 150 GiB,
      **20/20 env + 20/20 verifier** images including `formal-crypto`, `tb-dsh-base` overlay on every
      env image, sidecars pulled, tarball `f7a961a797ca5e17…`, smoke 1.0/1.0/1.0). The bounded
      four-task diagnostic then ran at HEAD `5cae65c` and **failed**
      (`bench/official/results/2026-11-09-prediag-0122/`): `intrastat-meldung` (graph 0/47, stock
      42/47 criteria) and `heat-pump-warranty` (graph 1/21, stock 16/21) are valid 0.0 near-misses,
      while `vpp-loss-divergence` and `medical-claims-processing` are `n_trials: 0` on both arms. No
      full run was started and there is no aggregate. **Historical:** the tracked 2026-11-08 partial
      run (`bench/official/results/2026-11-08-product20-partial/`) was taken on the pre-repair
      instrument and attempted **19/20** tasks: **11 graph / 3 stock** valid trials, only **2
      paired-valid** tasks (`bun-sourcemap-leak`, `cargo-flight-dispatch`), all **0.0**. Reward is
      binary: stock passed **35/37** criteria on `bun-sourcemap-leak` (graph 18/37) and **33/40** on
      `cargo-flight-dispatch` (graph 32/40). That run measured the **pre-fix** five-step plan, whose
      `n_answer` removed every tool (80 vs 217 session records); the plan shape has since changed, so
      the partial run is invalid as a product aggregate and none of its numbers are citable. A
      three-task oracle control (`bench/official/results/2026-11-08-oracle-control/`) passes **1.0**
      (task image/verifier path, not the DSH arm), so those zeros are not a blanket harness artifact.
      **Rerun on the repaired instrument before any stock-vs-graph statement.**
- [ ] `medical-claims-processing` **infrastructure blocker** (separate from the MCP-adapter
      limitation): its `playwright-mcp` sidecar is a vendor amd64 image, and under qemu on arm64
      Chrome never opens CDP 9222, so the compose healthcheck fails and no trial is created. It needs
      an arm64-native sidecar (or a different health gate) before it can produce a valid expected-0.0
      trial or enter the aggregate; do not backfill a 0.0 row for it.
- [ ] `vpp-loss-divergence` image reproducibility: the two images were patched out-of-band because
      Docker's legacy builder silently drops `RUN python - <<'PYEOF'` heredoc bodies (the CPU/gloo
      shim and the `/opt/verifier_pristine` snapshot live there). `build-arm64-task.sh` still uses
      plain `docker build`, so a canonical rebuild reproduces the defect; force BuildKit/`docker
      buildx` (or convert the heredoc), rebuild both images, and finish the stock trial.
- [ ] Graph termination, remaining part: the tool-stripping/forced-summary defect is fixed (the
      answer keeps tools and an exhausted plan gets a continuation step), but that continuation is a
      graph-to-stock hand-off bounded by the per-turn `maxSteps`, not graph routing. Decide whether
      to document it as intended or implement graph continuation.
- [ ] Durable checkpoints: `MemoryCheckpointer` only; the read/replay consumer is not designed.
- [ ] Kernel breadth: parallel fan-out, subagent batches, data-edge conditions and reserved node ids
      still use `FrontierTopology`.
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
