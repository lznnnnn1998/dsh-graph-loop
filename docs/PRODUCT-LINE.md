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
- Evaluation on **tasks within model capability**: local 20-task medium suite now; OfficeBench
  5-task subset when the office environment is available.

## Success criteria

1. **Accuracy parity** with stock on the medium suite.
2. **Token win**: lower prompt tokens, mean and median.
3. **Steps parity or better**; wall time reported, not required to win.
4. Installable and default-mode behavior verified; no DSH source edits.
5. The composition path is the live path, not a core-only contract.

## Current evidence

- Local 20-task, 2 reps, **live envelope/compose**: **40/40 both arms**, prompt
  **25,105 → 12,561 (−50.0% mean; −48.6% median)**, steps **4.2 → 4.0** (median 4 = 4). This is the
  product-line signal.
- Wall mean/median is slightly worse (+9.4% / +4.2%); not claimed as a win.
- The live scheduler now calls `selectEnvelopeForTask` + `synthesizeComposition` in dynamic mode;
  the bounded verify → diagnose → edit → verify repair is installed on verification failure.
- OfficeBench 5-task probe is prepared; it needs the OfficeBench Docker environment and action
  mapping.

## Non-goals

- Solving every Terminal-Bench hard task; that is the [stress line](STRESS-LINE.md).
- A general agent framework or a new model.
- Beating the stock loop on tasks the model cannot solve.
