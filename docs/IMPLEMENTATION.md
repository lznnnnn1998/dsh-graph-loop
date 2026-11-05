# Implementation status (prototype)

This is the working implementation that accompanies
[`explore-mode-plan.zh.md`](explore-mode-plan.zh.md). It is a prototype: it runs
end-to-end, but the "not implemented" list below is real.

## What is built

| Layer | Package | What it does |
|---|---|---|
| Model / matcher | `packages/core/src/{graph-schema,matching,replan}.ts` | typed capability graph, task fingerprint, template instantiation, confidence gate, fallback, replan primitives |
| Registry | `packages/core/src/registry.ts` | deterministic `RegistryGraph` snapshot from live tool facts (curated artifact/permission table, sha256 digest, dynamic/conditional warnings) |
| Templates | `packages/core/src/templates.ts` | `t_investigate`, `t_edit_test`, `t_bugfix`, `t_research`, `t_doc`, `t_stock` fallback |
| Step executor | `packages/core/src/step-graph.ts` | walks a `TaskPlan` one node at a time (`current/advance/done`) |
| Driver | `packages/loop/src/loop/` | fork of `dsh-agent-loop` (2,122 LOC) with one added seam: turn loop asks the graph for the next node; everything else keeps stock behavior |
| Scheduler | `packages/loop/src/scheduler.ts` | per-turn `match → plan → step-graph`, fallback plan, node model selection |
| Plugin rows | `packages/loop/src/{registry,router,tools}.ts` | `ctx.graphRegistry`, `ctx.graphRouter`, `graph_status` tool |
| Dynamic topology | `packages/core/src/topology.ts` | synthesizes arbitrary DAGs from the capability graph; frontier executor supports fan-out, bounded cycles and runtime node/edge mutation |
| Model-authored topology | `packages/core/src/proposal.ts` + `graph_plan` | the model submits any node/edge graph; the harness validates and the driver adopts it |
| Kernel | `packages/loop/src/kernel/` | `KernelPort` implementations: minimal stepwise (default) and a LangGraph 1.7 adapter behind a lazy import |
| Graph tab | `packages/graph-ui/` | Web conversation-view tab (`conversation.view` slot) next to Chat/Trajectory; reuses the whole chat shell and reads the graph-chat API |
| Graph-chat page | `packages/loop/src/graph-chat.ts` + `assets/graph-chat.html` | live page `/graph-chat`: chat on the left, current turn topology on the right; new-chat/send APIs; polls the graph runtime |
| Bundle A | `packages/mode/` | `explore` preset (standard preset minus delegation), policy section, idle-roster context, `suggest_executor`, `spawn_teammate` duplicate guard |
| Bundle B | `packages/loop/cordis.patch.yml` | disables row `agent-loop`, inserts graph registry/router/loop/tools |

## Verified by running

- `npm test` — 71 unit tests (core registry/templates, matcher→plan, step graph, scheduler, reuse scoring/guard, kernel minimal + LangGraph).
- `npm run e2e` — real DSH headless profile with `--patch`, scripted mock LLM:
  `turn/start → 3 × step/start → 3 × "[graph node …]" → turn/end completed`.
- `scripts/e2e-subagents.sh` — parallel subagent branches (`{d_search,d_fetch}`) in one turn.
- `scripts/e2e-replan.sh` — `bash` verify fails → recovery subgraph runs.
- `scripts/preview.mjs /tmp/dsh-graph-traces preview` — offline topology preview panel.
- `scripts/e2e-graph-chat.sh` — real Web host + standalone graph-chat page/API; screenshots `preview/graph-chat-live.png`.
- `scripts/e2e-graph-tab.sh` — installs both packages into a throwaway web profile, drives the real UI with Puppeteer, asserts the Graph tab, clicks a node to check the tool-call inspector, screenshots `preview/graph-tab-live.png`.
- `scripts/e2e-conformance.sh` — stock vs graph event invariants on real session logs (`conformance-diff.mjs`).
- `bash scripts/e2e-installed.sh` — creates a profile from the headless template,
  `dsh plugin add packages/loop`, runs the same task through the installed bundle
  (no `--patch`), same result.
- `--dump-config` composition checks: stock `agent-loop` row disabled, `graph-loop`
  inserted; bundle A adds `preset-explore` with 23 child rows and leaves the stock
  loop untouched.

## Early measurement (same scripted mock task)

| arm | steps | tools in request |
|---|---:|---:|
| stock loop (headless, no patch) | 2 | 24 |
| graph loop (explore profile, installed bundle) | 3 | 26 |

The graph arm adds the template's terminal step and the `graph_status` tool. This is the
expected overhead on a 2-step task; the design's savings require long tasks and fresh
subagent nodes (`research/04-tokens.md`: break-even 34–53 steps for a 2–4 node split).
Subagent nodes are designed but not wired yet, so **do not read this table as a verdict**.

## Not implemented (honest list)

1. **Node tool gating is soft** — `toolAllow` is prompt guidance, not schema removal.
   Hard per-step gating is deliberately avoided (KV-cache math in `research/04-tokens.md`).
2. **Node instructions are logged user messages** — one per step; a prompt section
   would avoid history growth.
3. **Subagent nodes / parallel fan-out / replan execution** — designed in
   `design/runtime.ts` and `design/replan.ts`, not wired into the driver.
4. **`graph_run` tool** — run a full plan inside one tool call using `runPlan`.
4b. **Replan triggers are narrow** — only verify-tool failure; unexpected-artifact/budget triggers are not wired.
5. **Conformance replay-diff** — the 16 obligations are documented in
   `packages/core/src/conformance.ts`; the automated diff is not built.
6. **Cross-loop resume** — a stock-written session resumed by the graph driver is untested.
7. **LangGraph is not the driver's default kernel** — the turn loop needs one node per
   DSH step with control inversion, so it uses the step-graph executor; the LangGraph
   adapter implements the same `KernelPort` (26 kernel tests, including one-node-per-
   `next()` semantics) and is exercised by tests and `runPlan`. Switching the driver to
   it needs the executor round-trip described in `design/runtime.ts`.

## Reproduce

```sh
bash scripts/link-dsh.sh
npm test
npm run e2e
bash scripts/e2e-installed.sh
```
