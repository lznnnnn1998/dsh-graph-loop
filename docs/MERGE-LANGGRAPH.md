# Absorbing LangGraph — ownership and merge plan

Status: **active reference**. LangGraph is now the default kernel; the live driver uses it for
kernel-drivable plans, with `FrontierTopology` as the fallback. See
[`docs/STATUS.md`](STATUS.md) for the current snapshot and
[`bench/archive/agent-eval/RESULTS.md`](../bench/archive/agent-eval/RESULTS.md) for the evidence.

> 中文摘要：DSH 负责 harness（session、turn/step、prompt、tools、审批、压缩、持久化、UI）；
> LangGraph 负责图运行时（StateGraph/Pregel、channels/reducers、checkpoint、Send/Command、
> subgraph、retry、stream）；本 repo 只负责**接缝 + 组合大脑**（能力图、envelope、router、
> DSH 节点执行器、模型-authored topology、Graph tab、conformance）。两边已经有的，不再实现。

---

## 1. Principle

Three owners, one rule: **do not implement a concern twice.**

| Layer | Owns | Does not own |
|---|---|---|
| DSH | session log, turn/step machine, prompt assembly, tool registry/execution, approvals, compaction, persistence, projections, UI, subagents | graph control flow, graph checkpoints, typed channels |
| LangGraph | StateGraph/Pregel execution, channels + reducers, checkpointer/resume/time travel, Send/Command, subgraphs, retry/cache, streaming primitives | session/event log, prompt admission, tool registry, DSH approvals, UI |
| This repo | capability graph, task fingerprint/router, per-turn envelope, DSH node executors, model-authored topology + validator, Graph tab, conformance, template ecosystem | a second session log, a second prompt assembler, a second tool pipeline, a second approval system |

The plugin still duplicates DSH's loop (the fork) and uses a frontier engine for plans the kernel
cannot route. Both are tracked as debt, not hidden.

---

## 2. Three-way comparison

| Concern | DSH stock loop | Native LangGraph | Current plugin | Target owner |
|---|---|---|---|---|
| Session/event log | **Yes** — event-sourced, persisted, projected | No | Fork keeps it | DSH |
| Turn/step state machine | **Yes** | No (has graph supersteps) | Fork copies it | DSH |
| Prompt assembly / admission | **Yes** | No | Fork keeps it | DSH |
| Tool registry / execution / approvals | **Yes** | No (tools are plain functions) | Fork keeps it | DSH |
| Subagents / presets | **Yes** | Prebuilt patterns only | Fork keeps it | DSH |
| Compaction / resume-close / projections | **Yes** | No | Fork keeps it | DSH |
| Graph as data | No | **StateGraph** | Custom `TaskPlan`; kernel drives linear plans | LangGraph |
| Superstep/Pregel semantics | No | **Yes** | `KernelTopology` pause-before-node bridge | LangGraph |
| Typed channels + reducers | No | **Annotation.Root / StateSchema** | Plain `GraphState` object | LangGraph (M2) |
| Durable checkpoints | No (session log only) | **Checkpointer + thread_id** | `MemoryCheckpointer` only | LangGraph + DSH storage (M3) |
| Resume / time travel | Turn-boundary only | **getStateHistory / updateState** | No | LangGraph + Graph tab |
| Send / dynamic fan-out | Subagents only | **Send from conditional router** | Frontier fallback | LangGraph (M4) |
| Command / dynamic goto | No | **Command(goto)** | Frontier fallback | LangGraph (M4) |
| Subgraph as node | No | **Yes, with state mapping** | Placeholder kind | LangGraph (M4) |
| Interrupt / HITL | Tool-level approvals | **interrupt() + Command(resume)** | Not adopted | DSH tool approvals |
| Streaming primitives | Session events + UI | values/updates/custom/debug/tasks | Graph tab SSE (custom) | LangGraph → DSH events |
| Retry / cache policy | Inner retry loop | **RetryPolicy / CachePolicy** | `PlanNode.retry` declared, not executed | LangGraph (M5) |
| Long-term memory | storageDomain, session-query | **BaseStore** | Context selection only | DSH storage |
| Graph visualization | No | Studio / mermaid | **Graph tab + preview** | This repo |
| Capability graph / routing / envelope | No | No | **Yes** | This repo |
| Model-authored topology + validation | No | No (graphs are code) | **Yes** (`graph_plan`) | This repo |
| DSH session conformance | Yes (stock) | No | **Yes** (fork) | This repo (tests) |

---

## 3. What to absorb from LangGraph, in order

### 3.1 Kernel: StateGraph/Pregel replaces the frontier executor

- `createKernel()` defaults to `langgraph`; `createLangGraphKernel` falls back to `MinimalKernel`
  when the optional dependency is absent.
- `KernelTopology` pauses the kernel before each node, lets DSH run the step, then resumes with the
  step outcome. One kernel superstep = one DSH step.
- Coverage today: linear plans with safe node ids and no subagent/conditional edges. Other plans
  fall back to `FrontierTopology` until the kernel route hook and parallel batching land.

### 3.2 Channels and reducers (next)

| Channel | Reducer |
|---|---|
| `messages` | append |
| `facts` | merge (last writer wins per key) |
| `artifacts` | merge by `(type, ref)`, keep newest hash |
| `children` | append session ids |
| `journal` | append, trim to `maxJournal` |
| `budget` | min/remaining, monotonic |
| `next/status` | replace |

LangGraph writes in completion order, so reducers must be order-insensitive (measured in
`research/03-langgraph.md` §“Parallel write ordering”).

### 3.3 Durable checkpointing (next)

- Implement a `BaseCheckpointSaver` backed by `storageDomain`.
- `thread_id = sessionId + turnId`; checkpoint at node boundaries, never mid-step.
- Strip `__pregel_*` channels; reject non-JSON state before write.
- Expose `getState` / `getStateHistory` to the Graph tab for replay and time travel.
- Cross-process resume remains a product decision: DSH closes interrupted turns today (D10).

### 3.4 Command / Send / subgraphs

- `PlanNode.kind = 'subgraph'` compiles a nested plan and maps parent/child channels through
  reducers; subgraph-only channels are dropped at the parent boundary.
- Dynamic fan-out uses `Send` from a conditional-edge router (the only valid form).
- `Command(goto)` replaces frontier `addNode/removeNode/addEdge` mutations.

### 3.5 Retry / streaming

- Map `PlanNode.retry` to LangGraph `RetryPolicy`.
- Map `streamMode` (`updates`, `custom`, `debug`) to DSH step boundaries and Graph-tab events. Do not
  create a second event stream.

---

## 4. What not to absorb

| LangGraph feature | Why not |
|---|---|
| `interrupt()` / `Command(resume)` for LLM nodes | The node body re-executes from the top after resume; an LLM call would run twice. DSH's `ask_user_question` + inbox is the right gate. |
| LangGraph Platform / deployment | Out of scope for a DSH plugin. |
| Long-term `BaseStore` memory | DSH has `storageDomain` and session-query; a second memory store splits truth. |
| Prebuilt `create_react_agent`, supervisor/swarm | DSH has presets, subagents and workflow. |
| A second session/event log | DSH owns it; checkpoints are not model-visible facts. |
| Cross-process mid-turn resume by default | Conflicts with DSH repair semantics (D10). |

---

## 5. What to retire from this repo

| Artifact | Action |
|---|---|
| `FrontierTopology` as the only executor | Replaced by the kernel for kernel-drivable plans; keep as fallback until coverage is complete. |
| `StepGraph` | Legacy for the frozen driver; not the live path. |
| `MinimalKernel` | Fallback/tests, not the product path. |
| Custom checkpoint contract (`checkpoint.ts`) | Keep the storageDomain schema/adapter; LangGraph owns the saver API. |
| `GraphState` plain object | Replace with channel definitions + reducers. |
| Forked DSH loop | Keep short-term; control plane would remove it. |

---

## 6. Target architecture

```
DSH host (unchanged)
  session log · turn/step machine · prompt assembly · tools · approvals · subagents · compaction
        │
        ▼
this plugin (composition bundle)
  capability graph ─ router ─ per-turn envelope
        │
        ▼
  LangGraph kernel (StateGraph / Pregel / channels / checkpointer / Send / Command / subgraphs)
        │  one superstep = one DSH step
        ▼
  DSH node executors: step · tool-batch · subagent · context
        │
        ▼
  Graph tab · trace · conformance · templates
```

---

## 7. Migration status

| Step | Work | Status |
|---|---|---|
| M1 | Kernel round-trip: scheduler uses `KernelPort`; LangGraph default, Minimal fallback | **Done for kernel-drivable plans**; 6-task eval 6/6, prompt −61%; unit suite green |
| M2 | Channel schema + reducers; order-insensitive parallel writes | Pending |
| M3 | `storageDomain` checkpointer; node-boundary writes; `getState`/history | Pending (`MemoryCheckpointer` today) |
| M4 | `Command`/`Send`/subgraph support | Pending (frontier fallback) |
| M5 | Retry policy + streaming mapping + Graph-tab history | Pending |

---

## 8. Decisions

1. **Kernel dependency — decided: LangGraph is the default.** Factory and live scheduler default;
   `MinimalKernel` fallback. Coverage is partial (see §7).
2. **Fork vs control plane — decided: keep the fork as the step executor for now.** Version tracking
   is automated; removing it remains a later control-plane option.
3. **Cross-process resume — out of scope for now.** DSH closes interrupted turns (D10).
4. **HITL — keep DSH tool-level approvals only.**

---

## 9. Install and default-profile contract

- **One command**: `bash scripts/install-explore.sh [profile]` (default `web`). It installs the
  Graph-tab bundle, the driver bundle and the **Explore mode**, then verifies:
  - `graph-loop`, `graph-ui`, `preset-explore` are present;
  - the stock `agent-loop` row is `disabled: true`;
  - `agent-preset-registry.default = explore`.
- **“Uninstall the stock loop” is not literal.** The shipped base bundle depends on
  `@deepseek-ai/dsh-agent-loop`; disabling the row is DSH's supported replacement mechanism.
- **“Default profile”**: DSH has no global default-profile setting; the CLI always takes
  `--profile <name>`. Installing into `web` makes `dsh web` use the graph loop; a custom profile is
  launched with `dsh --profile <name>`.
- **Mode vs driver**: the Explore preset composes tools/persona/policy for a session; it cannot
  replace the host loop. The driver bundle does that. Install both.
- **LangGraph availability**: optional dependency; normal npm install pulls it, local `link:` may
  not, in which case the kernel falls back to `MinimalKernel`.

---

## 10. Risks

- **Dual-package hazard**: `langgraph` ships CJS+ESM; assert a single `Command`/`BaseCheckpointSaver`
  instance at startup, never mix `require`/`import`.
- **Checkpoint identity**: ids/timestamps are not deterministic; resume identity is the triple, not
  the display id.
- **JSON loss**: `Date`/`Map` are not checkpoint-safe; keep `assertJsonSafe` at the boundary.
- **Node replay**: do not put model calls before an `interrupt()`.
- **Node-name limits**: LangGraph rejects reserved characters in node names; such plans stay on the
  frontier.
- **Dependency size**: 65 MB / 19 packages measured; keep the dynamic import and fallback.
- **Stream duplication**: map LangGraph streams onto DSH events; never write a second log.
- **Version drift**: pin exact versions and keep `MinimalKernel` as the escape hatch.
