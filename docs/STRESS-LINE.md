# Stress line — Terminal-Bench

> **Purpose: expose reliability gaps, not define the product.** Terminal-Bench is deliberately
> harder than the product-line suite. A 0 there is a finding about long-horizon robustness and
> model capability, not a verdict on the composition layer.

## What we use it for

- Long-horizon task budget and timeout behavior.
- `verify → diagnose → edit` repair loops and verification gates.
- Missing domain tools (PDF/music/cipher/sourcemap) and tool-surface gaps.
- Harness realism: Docker/arm64, sidecars, artifact collection.

## Current status (2026-11-07)

- Harness: Docker/Colima + Harbor + DSH adapter; native arm64 task images; smoke gate.
- Smoke `answer-42`: oracle/graph/stock all **1.0**.
- Hard fixed subset: **0.0 on every clean trial**. Graph runs ~5 steps; stock 30–60 steps or
  timeouts. The graph is too shallow and has no verification gate; this is the main lesson.
- Full infrastructure details and results live in [`bench/official/`](../bench/official/).

## Rules

1. **Smoke first.** `run-smoke.sh` must be 1.0 before any subset.
2. **Do not make Terminal-Bench the default product gate.**
3. **Do not keep investing in Docker/adapter infrastructure** unless it blocks a specific stress
   question. The harness is good enough; the agent is the issue.
4. Fold a stress finding back into the product line only when it improves **normal** reliability
   (e.g. the bounded repair loop), not when it only chases a hard-task score.
5. Report honestly: a 0 is a valid result; a timeout is not a score.
