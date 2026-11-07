# Product line — composition layer

> **The original intent.** A DSH-native, installable composition layer: one graph per turn composes
> arbitrary tools/plugins, the per-turn envelope keeps the tool surface stable, and the result is
> **accuracy parity with fewer prompt tokens/steps** on tasks the model can do.

## Scope

- Per-turn capability envelope: role resolution, tool universe, prompt sections, memory policy.
- Capability-driven composer: stages (`discover → inspect → mutate → author → verify → deliver`),
  artifact contracts, no hardcoded product/tool names.
- Live wiring: the scheduler uses `selectEnvelopeForTask` + `synthesizeComposition` in dynamic mode
  (verified on the 20-task suite), not just the legacy `synthesizeTopology`.
- Bounded `verify → diagnose → edit → verify` repair for normal reliability.
- Installable bundle + Explore mode; no DSH source changes.
- Evaluation on **tasks within model capability**: 10 easy + 10 medium Terminal-Bench tasks
  ([`bench/official/subsets/product20.json`](../bench/official/subsets/product20.json)); the old
  local 20-task suite is archived.

## Success criteria

1. **Accuracy parity** with stock on the medium suite.
2. **Token win**: lower prompt tokens, mean and median.
3. **Steps parity or better**; wall time reported, not required to win.
4. Installable and default-mode behavior verified; no DSH source edits.
5. The composition path is the live path, not a core-only contract.

## Current evidence

- **Active product suite:** Terminal-Bench easy10 + medium10, defined and fixed; the 20-task run is
  **pending** (native builds are required).
- The live scheduler now calls `selectEnvelopeForTask` + `synthesizeComposition` in dynamic mode;
  the bounded verify → diagnose → edit → verify repair is installed on verification failure.
- Archived local 20-task live-compose run (superseded; dirty worktree, not commit-bound): 40/40
  both, prompt **25,105 → 12,561 (−50.0% mean; −48.6% median)**, steps 4.2 → 4.0; wall +9.4% /
  +4.2%. Cost is not a win: billed total +16.8% (legacy topology +44.6%), output +41.2% / +55.2%.
  See [`bench/archive/agent-eval/RESULTS.md`](../bench/archive/agent-eval/RESULTS.md).
- Terminal-Bench easy/medium suite is prepared; it needs the Terminal-Bench product suite Docker environment and action
  mapping.

## Non-goals

- Solving every Terminal-Bench hard task; that is the [stress line](STRESS-LINE.md).
- A general agent framework or a new model.
- Beating the stock loop on tasks the model cannot solve.
