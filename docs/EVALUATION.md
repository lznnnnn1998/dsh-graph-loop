# Evaluation — product line and stress line

Status: **two-track evaluation.** The product line is measured on tasks within model capability
(10 easy + 10 medium Terminal-Bench tasks).
Terminal-Bench is a separate stress line and is **not the default gate**.

## 1. Product line

**Hypothesis.** The composition layer — per-turn envelope, capability-driven plan, live envelope/compose
wiring — produces equal task outcomes to stock with fewer prompt tokens and steps. Accuracy is
parity, not a win on tasks the model cannot do.

| Arm | What runs |
|---|---|
| `stock` | stock `agent-loop`, same model/tools/budget |
| `composition` | this bundle; dynamic mode uses `selectEnvelopeForTask` + `synthesizeComposition` |

Both arms use the same model, tasks, tool policy, timeouts and container image. The graph arm sets
`toolPolicy: preset` only for stress-line harnesses; product-line runs use `toolPolicy: plan` to
measure the actual tool-surface reduction.

### 1.1 Primary product suite: Terminal-Bench easy10 + medium10

- 20 fixed tasks: [`bench/official/subsets/product20.json`](../bench/official/subsets/product20.json)
  (10 easy, 10 medium by expert estimate; fixed before running).
- Same Harbor/adapter/smoke infrastructure as the stress line; the **task selection** is what makes
  this the product line: tasks within model capability, not the hard stress subset.
- Gate: smoke 1.0, then all 20 tasks run stock vs composition; report accuracy, prompt tokens and
  steps. A task that cannot build natively is an infrastructure gap, not a replacement.
- **Status: defined; the 20-task product run is not executed yet.**

### 1.2 Legacy evidence (archived)

The old local 20-task suite is archived at
[`bench/archive/agent-eval/`](../bench/archive/agent-eval/). Its live-compose result (40/40, prompt
−50%) predates the product-suite switch and is **not** the current product claim.

### 1.3 Product success criteria

1. Accuracy parity with stock.
2. Lower prompt tokens (mean and median).
3. Steps parity or better; wall time reported, not required to win.
4. Installable/default-mode behavior verified; no DSH source changes.
5. The live path really uses envelope/compose, not only core tests.

## 2. Stress line: Terminal-Bench 4.0

- Harness: [`bench/official/`](../bench/official/); Docker/Harbor + DSH adapter, native arm64 images.
- **Smoke first**: `run-smoke.sh`; oracle/graph/stock must be 1.0.
- Hard fixed subset: 0.0 on every clean trial; graph ~5 steps vs stock 30–60 or timeouts. This is a
  reliability/model-capability finding, not the product gate.
- Rules and findings: [`docs/STRESS-LINE.md`](STRESS-LINE.md).
- Only fold a stress finding back into the product line when it improves normal-task reliability
  (e.g. bounded `verify → diagnose → edit` repair).

## 3. Repair and verification (product reliability)

The scheduler installs `repairTopology` when a **verification** node fails:

```
r_diagnose → r_edit → r_verify → r_answer
```

bounded by `maxReplans` (default 2 for composed plans). A failed non-verify node uses the existing
`recoveryTopology`. This is for normal-task robustness, not hard-benchmark score chasing.

## 4. Metrics and reporting

- **Product primary:** success/accuracy parity; prompt tokens; steps.
- **Product secondary:** output tokens, cache ratio, wall time, crash count.
- Report **mean and median** for every metric; identify outliers.
- Per-task table + aggregate + exact command/config/commit/model/harness digest.
- **Stress line:** score/harness diagnostics only; not part of the product aggregate.

## 5. Artifacts

- `bench/archive/agent-eval/` — legacy local 20-task harness and results (history).
- `bench/official/subsets/` — 10 easy + 10 medium product task manifests.
- `bench/official/` — stress-line Terminal-Bench harness, smoke and results.
- `docs/STATUS.md` — current snapshot.
