# Evaluator pass — 2026-11-09 22:03 +08 (post-audit `20261109-1319`, HEAD `0a6d668`)

Fresh evaluator on `/Users/zhinan/Documents/dsh_workspace/dsh-graph-loop`. Snapshot 22:03–22:06 +08.
HEAD `0a6d6686cd382c04f0425bcce02598f984851d38` (`docs+bench: record aborted product20 and ship
routing/GRAPH_FAILED contracts`, on top of the non-doc fix `4561008`). The tracked tree was clean
before this pass (untracked files were the five preserved evidence dirs only). Writes in this pass:
this note, `ci-local.log`, and the P0-1 close of `../2026-11-09-product20b/README.md`. Nothing pushed,
published, rebuilt into `dist/`, or started; the aborted run's `rows.jsonl`/`raw/`/`jobs/`/`runner.pid`,
Docker images/containers, `/tmp` markers and the DSH checkout were read only.

## Live-run guard — all false; no benchmark is live

| Predicate | Value |
|---|---|
| `docker ps --filter name=__env` | **0 containers**; `docker ps -q` = 0 |
| `/tmp/product20-shard-full.log` | `product20b running pid=61129 started=2026-11-09T17:19+08:00 out=bench/official/results/2026-11-09-product20b` then **`_EXIT`** (mtime 19:43) |
| `/tmp/product20-shard{A,B,C,D}.log` | end `A_EXIT=0` / `B_EXIT=0` / `C_EXIT=0` / `D_EXIT=0` (Nov 8 evidence) |
| `results/2026-11-09-product20/runner.pid` | `38616` — **dead** |
| `results/2026-11-09-product20b/runner.pid` | `61129` — **dead** |
| Processes | no `harbor`, `run-subset`, `run-product20` or `product20` process |

The marker is closed and names a dead PID; no `runner.pid` anywhere under `results/` names a live
process. **No benchmark in progress.** No marker close/truncate action was needed or performed.

## Gate

`bash scripts/ci-local.sh` → **PASS, exit 0** (full 333-line log: [`ci-local.log`](ci-local.log)).
Steps: typecheck; `npm test` **277 pass / 0 fail / 0 skipped** (three engines); `npm run build` →
`lib matches a fresh build of the source` (`build:check`); fork-surface guard pinned at
`22ddee3792` with the expected 10 local files. This confirms the improver's stated trail on this HEAD.

**Smoke was deliberately not run.** `run-smoke.sh` defaults `DSH_PLUGIN_TARBALL` to
`dist/dsh-graph-loop-bench.tgz`, which is still the pre-fix bundle (below); a smoke now would install
the old loop and could not validate `4561008`/`0a6d668`. Replacing `dist/` is outside the evaluator's
write scope, and audit `20261109-1319` §8 forbids starting a Harbor job before P0-2/P0-3.

## Readiness (product20) — **not ready**

| Item | State (verified now) |
|---|---|
| 20/20 env images | **Yes** (`tb-arm64-<task>-env:latest` ×20) |
| 20/20 verifier images | **Yes** (`tb-arm64-<task>-verifier:latest` ×20) |
| `tb-dsh-base` + medical sidecar | **Present** (`tb-dsh-base:latest`, `tb-arm64-medical-claims-sidecar:latest`) |
| Task dirs in `/tmp/tb-arm-dsh` | **20/20** from `subsets/product20.json`; extra `payments-pipeline-fix` (not in the manifest — harmless, audit P2) |
| Colima / disk | Running (aarch64, docker); `/var/lib/docker` 148G, **41G avail (72% used)** |
| Docker daemon proxy | Colima service conf = `http://192.168.196.127:8899`; `ipconfig getifaddr en0` = `192.168.196.127` — **matches** |
| `dist/dsh-graph-loop-bench.tgz` | **STALE / pre-fix** — 223,458 B, sha256 `f7a961a797ca5e17fdd68d52c0bd6dfeec50ec4151f42d84bbd7405069b12064`; `grep -c toolSucceeded` in its `package/lib/index.js` = **0** |
| HEAD pack (for comparison) | `npm pack` from this HEAD → **225,595 B**, sha256 `45de85397ac0d07fa2b836290375bfec31c499c723bc4d98157b4d22b84070dc`, `toolSucceeded` = **5** (scratch pack in `/tmp`, removed) |
| Smoke | Last pass `../2026-11-09-smoke-sandbox/` (oracle/graph/stock 1.0) installed the **pre-HEAD** `f7a961…` tarball; **not re-run on this HEAD** |
| Four-task pre-run diagnostic | `../2026-11-09-prediag-fixes/README.md` exists; all 8 rows `n_trials: 1` — per the role the old gate is "complete", but it predates `da3d598`/`4561008` and is **not** a post-HEAD pre-run |
| Post-HEAD bounded real-model pre-run (P0-3) | **Missing** |
| Completed product20 / aggregate | **None**; aborted `product20b` is not completed, its 5 rows are **not citable** |

**P0-2 remains open — the single blocker for a rerun.** The documented default tarball is the
pre-`4561008` loop; the role requires a HEAD repack (and a recorded new sha) before any rerun, and the
audit says a run started from the current `dist/` would measure the pre-fix routing bug. The evaluator
cannot repack (`dist/` is outside its write scope); this must land with the improver/Lead, followed by
P0-3 (smoke + bounded real-model check on the new tarball, including a shell-write/routing task).

## Rerun predicate and product20 status

- There is **no completed product20** (the 31-row `2026-11-09-product20/` run is invalid per its
  `INVALID.md`; `product20b` aborted at 5/40), so the "no product20 result exists" branch holds and
  the docs-only-vs-instrument filter is not what blocks a rerun.
- HEAD does contain **non-documentation instrument changes** since the aborted run's executed commit
  `da3d598`: `4561008` touches `packages/` and `bench/official/terminal-bench/{dsh_agent.py,run-subset.sh}`;
  `0a6d668` also touches `bench/official/terminal-bench/run-subset.sh`. A rerun is therefore
  *authorized in principle* by the non-doc-change rule.
- **Full product20 was NOT started**: the role's readiness gate fails on the tarball (P0-2) and on the
  missing post-HEAD bounded pre-run (P0-3). No PID/OUT_DIR/rows were created; nothing is live.

**Product20 status: not started, no benchmark live, no aggregate, no product claim.**

## Aborted `product20b` — 5 rows, not citable

`rows.jsonl` = exactly 5 rows (`html-js-filter` graph/stock, `photonic-waveguide-routing` graph/stock,
`music-harmony` graph), each `n_trials: 1`, `n_errors: 0`, executed commit `da3d598…`. No `summary.json`,
no `graph_failed` field (the pre-HEAD adapter wrote none; the graph rows' stdout carries
`dsh: GRAPH_FAILED: … at node "n_mutate"`). Three 0.0 rows — html graph 1/2, music graph 0/13, photonic
graph 13/14 near-miss — and two stock 1.0 rows (html 2/2, photonic 14/14); stock music never ran. These
are evidence of the routing bug, not capability, and must not be merged. P0-1 residual
closed: `../2026-11-09-product20b/README.md` is now a closed-run record ("aborted 5/40", dead PID,
`_EXIT`), matching `ABORTED.md`; its identity and evidence files are unchanged.

## `GRAPH_FAILED` wiring (HEAD contract) — static check only

- `bench/official/terminal-bench/dsh_agent.py`: `GRAPH_FAILED_RE = re.compile(r"(?m)^dsh: GRAPH_FAILED:")`,
  anchored so prose cannot turn a transport crash into a valid trial; metadata records
  `agent_exit`, `transport_failed`, `graph_failed` for both arms.
- `bench/official/terminal-bench/run-subset.sh`: the summary separates `graph_failed` rows per arm
  (`graph_failed`, `graph_failed_rows`), excludes them from the capability mean, sets
  `meta.citable = len(graph_failed_rows) == 0 and agent_invalid_total == 0`, and warns that such a row
  is a graph/kernel fault making the run non-citable; `bash -n` is clean. No Harbor run was made, so
  this is not an end-to-end validation.

## Remaining (unchanged by this pass)

P0-2 HEAD tarball repack + recorded sha; P0-3 bounded post-HEAD real-model pre-run (smoke + a
shell-write/routing task); both before any full product20. P2 doc/classifier items from the audit are
still open and are not readiness blockers. No product result is claimed or citable from this note.
