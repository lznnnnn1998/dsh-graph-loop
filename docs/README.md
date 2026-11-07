# Docs

Start with the two lines: **product** (composition layer) and **stress** (Terminal-Bench).

## Product line

| Doc | What it is |
|---|---|
| [STATUS.md](STATUS.md) | One-page snapshot: what works, evidence, gaps, next |
| [PRODUCT-LINE.md](PRODUCT-LINE.md) | Original intent, scope, medium-task evaluation, success criteria |
| [COMPOSITION.md](COMPOSITION.md) | Decision record + v0.2 composition contract (D1–D22) |
| [MERGE-LANGGRAPH.md](MERGE-LANGGRAPH.md) | Three-way ownership (DSH / LangGraph / this repo) and migration plan |
| [EVALUATION.md](EVALUATION.md) | Product-line evaluation + stress-line pointer |
| [PUBLISHING.md](PUBLISHING.md) | Package names, release steps |
| [reference/DYNAMIC-TOPOLOGY.md](reference/DYNAMIC-TOPOLOGY.md) | How the current dynamic topology is synthesized |
| [reference/TOPOLOGY-OPTIMALITY.md](reference/TOPOLOGY-OPTIMALITY.md) | Why the topology is heuristic, not optimal |

## Stress line

| Doc | What it is |
|---|---|
| [STRESS-LINE.md](STRESS-LINE.md) | Terminal-Bench purpose, rules, findings; not the default gate |
| [bench/official/](../bench/official/) | Harbor preflights, DSH adapter, smoke task, hard-subset results |

## Evidence

- [`bench/archive/agent-eval/`](../bench/archive/agent-eval/) — legacy local 20-task harness (history)
- [`bench/official/subsets/`](../bench/official/subsets/) — product suite: 10 easy + 10 medium Terminal-Bench tasks
- [`bench/official/`](../bench/official/) — stress-line Terminal-Bench harness and results
- [`research/`](../research/) — original evidence base
- [`design/`](../design/) — original design contracts (historical)

## Archive (0.1.x, kept for history)

| Doc | Why archived |
|---|---|
| [archive/explore-mode-plan.zh.md](archive/explore-mode-plan.zh.md) | The original 922-line graph-loop plan; superseded by COMPOSITION |
| [archive/IMPLEMENTATION.md](archive/IMPLEMENTATION.md) | 0.1 implementation status |
| [archive/RETROSPECTIVE.md](archive/RETROSPECTIVE.md) | 0.1 retrospective |
| [archive/AB-STRUCTURAL.md](archive/AB-STRUCTURAL.md) | 0.1 structural A/B |
| [archive/DSH-COMPAT.md](archive/DSH-COMPAT.md) | 0.1 DSH compat audit |
| [archive/COMPLIANCE.md](archive/COMPLIANCE.md) | 0.1 publishing audit |
