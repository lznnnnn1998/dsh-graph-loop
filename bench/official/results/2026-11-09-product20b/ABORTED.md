# ABORTED at 5/40 rows — graph routing bug, not a product run

Stopped 2026-11-09 19:44 +08. The corrected sandbox instrument was working (danger-full-access on both
arms, no transport rows), but the graph arm was failing in its own stage loop:

- `html-js-filter` graph: 26 steps, 10 `n_inspect ↔ n_inspect_repair` cycles, 37 tool calls, then
  `GRAPH_FAILED` at `n_mutate` — the repair loop consumed the step budget.
- `music-harmony` graph: 27 steps, 6 `n_mutate ↔ n_mutate_repair` cycles, no `write`, no
  `/app/harmony.mxl`; verifier correctly 0/13.
- `photonic-waveguide-routing` graph: 13/14 near-miss (not a routing loop).

These rows are valid trials but not a fair graph-vs-stock measurement; the graph design must be fixed
before another product20. Marker `/tmp/product20-shard-full.log` now has `_EXIT`; PID 61129/66524 are
stopped. Do not merge these five rows into a future citable run.
