# Benchmark result files

All rows come from `bench/archive/agent-eval/run.mjs`; each row carries `arm`, `task`, `rep`, `ok`,
steps, tool calls, usage tokens and wall time. Read both **mean and median**:
`node bench/archive/agent-eval/summarize.mjs <file> --per-task`.

| file | suite | notes |
|---|---|---|
| `2026-11-07-compose-live-20-2x.json` | 20 local tasks, 2 reps | **live envelope/compose** run; 40/40 both, prompt −50%, billed total +16.8% (dirty worktree — see provenance) |
| `2026-11-07-local-20-2x.json` | 20 local tasks, 2 reps | legacy `synthesizeTopology` run; kept for comparison; dirty worktree |
| `2026-11-07-local-2x.json` | 6 local tasks, 2 reps | earlier inner-loop run |
| `2026-11-07-installed.json` | 6 local tasks | installed-profile path |
| `2026-11-07-kernel-live.json` | 6 local tasks | first kernel-live run; wall sample has 82–92 s API stalls |
| `2026-11-07-local.json` | 6 local tasks | first single-rep run |

Model: `deepseek-flash` = DeepSeek V4.1-Flash-1017. The official Terminal-Bench 4.0 and
NL2Repo-Bench scores are **not** in this directory; they are gated on Docker/Modal and the DSH
adapters described in [`../../../official/README.md`](../../../official/README.md).

## Provenance (post-hoc, 2026-11-07 audit)

Both 20-task runs executed on **dirty worktrees** and are **not reproducible from their recorded
`pluginCommit`**:

- **Live run** — the manifest records `pluginCommit: 388f1f1`, but that commit contains no live
  composition code: `packages/loop/src/scheduler.ts` at 388f1f1 calls `synthesizeTopology` only and
  has zero `selectEnvelopeForTask`/`synthesizeComposition` calls. The run started
  `2026-11-07T23:11:22+08:00` and wrote its raw results at 23:21; the live envelope/compose code was
  committed as `b861a52` at 23:22:21, after the run. The manifest now carries a `provenanceNote`
  field recording this determination (the note is post-hoc; no run-time field was rewritten). Note
  that the runner records `git rev-parse HEAD` only and never the worktree state, so
  `pluginCommit` is a HEAD pointer, not a claim about the code exercised; recording
  `git status --porcelain` at run time is a follow-up.
- **Legacy run** — its manifest already recorded `"pluginWorktree": "dirty at run time; final code
  committed after this run"` (`pluginCommit: 922a7f5`).

Consequences: cite these as *dirty-worktree local runs*, not as commit-bound evidence. Raw result
JSON is unchanged — the file blobs are identical to the ones added in `b861a52` and only moved by
`c384bb8`. The recomputed cost table lives in [`../RESULTS.md`](../RESULTS.md).

Recompute the aggregates from the tracked rows:

```sh
node bench/archive/agent-eval/summarize.mjs \
  bench/archive/agent-eval/results/2026-11-07-compose-live-20-2x.json --per-task
```
