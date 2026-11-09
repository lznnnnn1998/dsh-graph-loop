# This run is NOT CITABLE — stopped at 31/40 rows

Stopped 2026-11-09 13:51 +08 after the `20261109-0528` audit found two instrument
defects. The rows are preserved as evidence of the broken instrument, not as a product result.

- 6 rows are DSH `TRANSPORT` crashes recorded as ordinary 0.0.
- 6 rows (intrastat ×2, roy ×2, vpp ×2) are capped by the default `workspace-write` sandbox
  rooted at `/app`; the tasks must write `/workspace/out`, `/results` or installed
  site-packages. `freight-dispatch-shift` would be capped too.
- At invalidation time the marker `/tmp/product20-shard-full.log` ended `_EXIT`; PID 38616 / harbor
  child 58165 were stopped by the Lead. The shared marker was later truncated by the corrected run's
  launcher, so it now names `product20b` (PID 61129) — **this file**, not the marker, is this run's
  close record. Do not append `_EXIT` there on account of the dead PID 38616.

The instrument was fixed after this stop (adapter: shared `sandbox-policy:
danger-full-access` for both arms, LLM retries 3, `agent_exit`/`transport_failed` metadata;
`run-subset.sh` records those fields). The citable rerun goes to
`bench/official/results/2026-11-09-product20b/` with a new OUT_DIR; do not merge these rows
into it.
