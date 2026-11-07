# Docs

One voice: **architecture B** — the dedicated graph loop in `packages/loop` replaces the stock
`agent-loop` through DSH's `AgentFactory` seam. Start with the root
[README](../README.md) and [STATUS.md](STATUS.md).

## Active

| Doc | What it is |
|---|---|
| [STATUS.md](STATUS.md) | One-page facts: what works, exact kernel coverage, evidence status, gaps, next |
| [MERGE-LANGGRAPH.md](MERGE-LANGGRAPH.md) | Three-way ownership (DSH / LangGraph / this repo), coverage, migration status |
| [EVALUATION.md](EVALUATION.md) | Evaluation protocol; product suite is defined but **not run** |
| [STRESS-LINE.md](STRESS-LINE.md) | Terminal-Bench stress line: purpose, findings, not the default gate |
| [PUBLISHING.md](PUBLISHING.md) | Package names, release steps |
| [reference/DYNAMIC-TOPOLOGY.md](reference/DYNAMIC-TOPOLOGY.md) | How the legacy dynamic topology is synthesized |
| [reference/TOPOLOGY-OPTIMALITY.md](reference/TOPOLOGY-OPTIMALITY.md) | Why the topology is heuristic, not optimal |

## Evidence

- [`bench/archive/agent-eval/`](../bench/archive/agent-eval/) — legacy local 20-task harness and
  **non-reproducible** results (historical only; see its provenance note)
- [`bench/official/subsets/`](../bench/official/subsets/) — product suite: 10 easy + 10 medium
  Terminal-Bench tasks (defined, unrun)
- [`bench/official/`](../bench/official/) — stress-line Terminal-Bench harness and results
- [`research/`](../research/) — original evidence base

## Archive (kept for history)

| Doc | Why archived |
|---|---|
| [archive/COMPOSITION.md](archive/COMPOSITION.md) | Retired 0.2 "control plane / composition layer" decision record (D12/D13); superseded by architecture B |
| [archive/PRODUCT-LINE.md](archive/PRODUCT-LINE.md) | Original product line; no reproducible evidence; −50% figure is historical only |
| [archive/explore-mode-plan.zh.md](archive/explore-mode-plan.zh.md) | Original 922-line graph-loop plan |
| [archive/IMPLEMENTATION.md](archive/IMPLEMENTATION.md) | 0.1 implementation status |
| [archive/RETROSPECTIVE.md](archive/RETROSPECTIVE.md) | 0.1 retrospective |
| [archive/AB-STRUCTURAL.md](archive/AB-STRUCTURAL.md) | 0.1 structural A/B |
| [archive/DSH-COMPAT.md](archive/DSH-COMPAT.md) | 0.1 DSH compat audit |
| [archive/COMPLIANCE.md](archive/COMPLIANCE.md) | 0.1 publishing audit |
| [archive/PROGRESS-0.1.md](archive/PROGRESS-0.1.md) | 0.1 build log |
| [archive/bundle/](archive/bundle/) | 0.1 A/B skeleton bundles; superseded by `packages/` + the installer |
| [archive/design/](archive/design/) | 0.1 pre-implementation contracts and measurements |

`PROGRESS.md` at the repository root is the historical 0.2 build log; it carries a banner and is not
normative.
