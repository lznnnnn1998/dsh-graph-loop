# Progress

Architecture B: the dedicated graph-loop plugin in `packages/loop` replaces the stock `agent-loop`
through `AgentFactory`. Current focus is product evidence on Terminal-Bench product20, not new
features.

## Done

- [x] Graph driver replaces the stock loop, no DSH source edits.
- [x] Per-turn topology: fingerprint → plan → one DSH step per node.
- [x] Capability envelope + capability-driven composition.
- [x] LangGraph kernel default; linear + one `callFailed` branch are kernel-routed.
- [x] Bounded recovery/repair for failed verify nodes.
- [x] Per-node tool admission; answer-only terminals.
- [x] Subagent batch nodes (frontier path), child fallback.
- [x] Graph tab + `/graph-chat` API; SSE/tool-call inspector.
- [x] Explore mode, one-command installer, profile verification.
- [x] Fork guard: pinned upstream + patch budgets, enforced in `ci-local`/`verify-all`.
- [x] 168 unit tests, typecheck, build:check, installed e2e, tarball e2e green.

## In progress / next

- [ ] **product20**: Terminal-Bench easy10 + medium10, stock vs graph. The tracked 2026-11-08
      partial run (`bench/official/results/2026-11-08-product20-partial/`) attempted **19/20** tasks
      (`formal-crypto` has no verifier image): **11 graph / 3 stock** valid trials, only
      **2 paired-valid** tasks (`bun-sourcemap-leak`, `cargo-flight-dispatch`), all **0.0**. Invalid
      as a product aggregate; the instrument is unvalidated for the full suite. A three-task oracle
      control (`bench/official/results/2026-11-08-oracle-control/`) passes **1.0** (task
      image/verifier path, not the DSH arm), so those zeros are not a blanket harness artifact.
- [ ] Durable checkpoints: `MemoryCheckpointer` only; the read/replay consumer is not designed.
- [ ] Kernel breadth: parallel fan-out and subagent batches still use `FrontierTopology`.
- [ ] Product claim: none. No accuracy, parity or cost number from the partial run is citable.

## Known debt

- `packages/loop` is a source fork; `scripts/diff-upstream.sh` must be re-baselined deliberately
  when the DSH checkout moves.
- Benchmark heuristics are behind `benchGuards` (default off) and are not generic loop behavior.
- No hosted CI; `scripts/ci-local.sh` is the local gate.

## Commands

```sh
npm run typecheck
npm test
npm run build && npm run build:check
bash scripts/ci-local.sh
bash scripts/verify-all.sh
bash scripts/install-explore.sh
```
