# Evaluation — cycle `20261108-1525` (HEAD `f28de84`)

Fresh evaluator pass for `/Users/zhinan/Documents/dsh_workspace/dsh-graph-loop`.
Commit `f28de848b2c728272a8c7395e71b0987b15d7918` ("graph: classify every composed stage, order
joins, fail before budget"), clean source tree; the only untracked paths after this pass are the two
new evidence directories. No product source edited, no push/publish, no DSH source edit, **no
product20/Harbor run** (readiness only), no token or product claim.

> **Post-eval note.** After this pass, `63b5f20` narrowed `verificationRan` to the node's planned
> verification tool (a verify step that ran only `read` now repairs); the tree is **256/256** at the
> cheap gate (`npm run typecheck`, `npm test`). That commit did not go through this evaluator gate
> or the smoke, and the tarball below has not been repacked — it is still the `f28de84` build. The
> evaluator record in this note is `f28de84` only.

## Verdict

| Item | Result |
|---|---|
| `bash scripts/ci-local.sh` | **PASS**, exit 0 |
| `npm test` gate | **253 pass / 0 fail / 0 skipped** (claim verified) |
| Transition matrix | **66/66**, 17 rows on each of frontier/minimal/langgraph |
| Smoke gate | **PASS** — oracle 1.0, graph 1.0, stock 1.0 |
| Tarball | present, correct sha256, code-identical to the `f28de84` build, used by the smoke |
| Join barrier / stage-exit live regression | **none found**; one intended-but-costly live behaviour noted below |
| product20 | **NOT run and not ready**; no aggregate exists |

## Readiness (product20 gate)

| Item | State |
|---|---|
| 20 env images `tb-arm64-<task>-env:latest` | **20/20 present**, linux/arm64; all 20 prepared `/tmp/tb-arm-dsh/<task>/task.toml` exist and point at the local env/verifier tags |
| 20 verifier images | **19/20**; `formal-crypto` missing |
| `tb-dsh-base:latest` | present, 2.15 GB |
| Node/DSH overlay on env images | **19/20**; `shadow-relay` env has no `/opt/node` or `/opt/dsh` (verified by running the image; its adapter would bootstrap Node+DSH over the network at trial start) |
| `dist/dsh-graph-loop-bench.tgz` | **223,372 B**, sha256 `4893f9344a1bbb62f1aaa7777f488c5e919cd9217ed6b1512fee1ea046f20749`; extracted `lib/*` equals the fresh build after stripping esbuild entry comments; contains `verificationRan` and the frontier barrier code |
| Disk (colima) | 99 G total, **84 G used, 11 G free (90 %)**; 4 dangling images (~5.3 GB) are held by stopped builder containers, so pruning would reclaim nothing without removing containers (not done) |
| CPU / memory | VM **4 vCPU / 8,307,163,136 B** (host has 15 cores but colima is fixed at 4) |
| Docker proxy | **not configured and dead**: `192.168.1.5:8899` CONNECT times out; direct `registry-1.docker.io` also times out; `api.deepseek.com` is reachable (the smoke's model calls worked) |

### Blockers (product20 must stay closed)

1. **8 CPUs on a 4-CPU VM**: `formal-crypto` and `shadow-relay` `task.toml` request `cpus = 8` for
   both env and verifier. Container start fails with
   `range of CPUs is from 0.01 to 4.00`. (`payments-pipeline-fix`, not in product20, also asks for 8.)
2. **`formal-crypto` verifier image missing.** Building it is not worth retrying while the source
   task is CPU-capped at 8 > 4: the documented readiness attempt aborted after ~22 min at 26–85
   KB/s on the Miniforge installer and had already failed a layer export on a 90 %-full disk. With
   Docker Hub/proxy egress down now, a rebuild cannot start either.
3. **`shadow-relay`**: env image is missing the Node+DSH overlay *and* requests 8 CPUs; its network
   bootstrap path is unavailable while Docker/proxy egress is down.
4. **Unchanged known blockers** (from the role/partial-run evidence; not rerun): `medical-claims-processing`
   needs MCP servers the adapter does not start, `heat-pump-warranty` missed sidecar images/Docker Hub
   TLS, `freight-dispatch-shift` images ship Node 20.19.2 (cannot import `node:sqlite`).
5. **11 GB free disk** is tight for a multi-GB SageMath verifier build even if the network recovered.

Because of 1–5, the 20-task suite cannot be run end-to-end; no product20 was started.

## Gate — PASS

`bash scripts/ci-local.sh` (log: [`ci-local.log`](ci-local.log)) exit 0:

- typecheck pass;
- `npm test`: **253 tests, 253 pass, 0 fail, 0 skipped** (~0.6 s);
- bundle build; `build:check` → “lib matches a fresh build of the source”;
- fork surface guard pass: 10 expected local files, upstream pin `22ddee3792`, patch surface matches
  expectations.

### The 253-test claim is real, not a reduced gate

- `204 → 253` tests: the transition matrix grew `18 → 66` (17 rows each on frontier/minimal/
  langgraph, including langgraph — the optional `@langchain/langgraph` is installed, so **0 skips**
  and the langgraph rows actually execute); `condition-routing` gained the sticky-facts row.
- The four changed fixtures were strengthened or adjusted, not weakened: `core-compose.test.ts` now
  asserts the per-stage success key, the matching no-progress exit, “no unconditional stage exit”
  and failure-before-budget ordering; `scheduler.test.ts` supplies the `read`/`edit` facts the new
  guards read; the matrix's non-verify exit-code fixture also does an `edit` so it still isolates
  exit-code handling. No assertion was deleted without a stronger replacement.
- Matrix-only run: [`matrix-1525.log`](matrix-1525.log) — 66/66, 0 skipped.

## Smoke — PASS (details in [`../2026-11-08-smoke-1525/README.md`](../2026-11-08-smoke-1525/README.md))

`OUT=…/2026-11-08-smoke-1525 bash bench/official/terminal-bench/run-smoke.sh`, using the repacked
`dist/dsh-graph-loop-bench.tgz` (no temp tarball): oracle **1.0**, graph **1.0** (14 s), stock
**1.0**; every verifier `reward.txt` is 1.

The graph arm was **not** a happy-path-only run. Its session log shows the composed plan executing
live: `n_inspect` (write) → `n_inspect_repair` (read) → `n_inspect` (text, no tool) →
`n_inspect_repair` (read) → `n_inspect` (glob) → `n_mutate` (write) → `n_verify` (bash `od`) →
`n_answer` — 8 steps, 6 tool calls, score 1.0. The two inspect repairs are the new exclusive
no-progress exit firing; mutate/verify pass on their new step-scoped facts. (At `823aa68` the
inspect stage had no failure guard, so this repair sequence also proves the installed tarball is
`f28de84` code, not a stale copy.)

The smoke composition is linear, so it does not exercise a **fan-out join**. Join ordering was
checked by the 66/66 matrix and by a probe against the built bundle (identical to the tarball):
deep diamond `a,b,c,c2,d`; inverted join `a,b,d,c`; join-in-cycle twice per iteration; fan-out with
retried branch `entry,a,b,a,join,answer` — every join runs exactly once per iteration and after its
inputs ([`join-probe.txt`](join-probe.txt), script [`join-probe.mjs`](join-probe.mjs)).

## Regression evaluation for `f28de84`

**No live regression found in the join barrier or the stage exits.** Code review plus the probes
show: the barrier requires every *entered* predecessor to complete and holds a join while a queued
node can still reach it, tolerates never-entered guarded branches, still re-enters on explicit
back-edges, and cannot deadlock (a fully-blocked queue falls back to the oldest node; `maxSteps`
bounds the run; `done()` waits for detached batch nodes). The stage exit tables are exhaustive
(every success/failure fact is written on every step), the success exits are exclusive, and the
failure exits are declared before the budget exit, so a failed stage at the reserve boundary
repairs instead of becoming the answer. The smoke passed on the shipped tarball and the direct
engine probe produced the expected orders.

Two live-behaviour notes (residual risk, not gate failures):

1. **Repair steps cannot complete their stage.** A repair node always returns unconditionally to
   the stage, and the stage's success fact is recomputed on the stage's own step; a `read` done on
   `n_inspect_repair` does not satisfy `n_inspect`. The smoke shows the cost: the model wrote on
   its inspect step and then needed two more inspect rounds + repairs (4 of 8 steps) before a
   `glob` on the stage step advanced it. Correct per the classifier design and bounded by
   `maxSteps`, but a model that ignores the stage's tool contract can burn budget on repair loops.
2. **`verificationRan` means “some tool ran”, not “the verification tool ran”.** A verify step
   filled by a non-shell tool (e.g. `read`) would pass the success exit as long as no tool output
   carries a non-zero `[exit code: N]`. This is wider than the audit wording (“verification ran”),
   was not exercised by the smoke (verify used `bash`), and the matrix only tests the no-tool case.
   It is still strictly better than the pre-fix “no tool is a pass”, so it is a residual design
   risk, not a regression introduced by this commit.

## product20

**Not run.** Readiness is incomplete (19/20 verifier images, two tasks CPU-capped at 8 on a 4-CPU
VM, `shadow-relay` without the Node/DSH overlay, Docker registry/proxy egress down, MCP/sidecar/
old-Node blockers unchanged). Only the existing `../2026-11-08-product20-partial/` evidence is
present; it is not an aggregate and no accuracy/parity/token/cost number may be cited from it.

## Result paths

- This evaluation note and gate/probe logs: `bench/official/results/2026-11-08-eval-1525/`
  (`README.md`, `ci-local.log`, `matrix-1525.log`, `join-probe.txt`, `join-probe.mjs`).
- Smoke evidence (README + per-arm logs + raw `jobs/`): `bench/official/results/2026-11-08-smoke-1525/`.
- HEAD at this pass was `f28de84`; source tree clean, evidence dirs untracked; tarball sha unchanged
  by this pass.
