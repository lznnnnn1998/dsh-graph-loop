# Lead analysis backbone (working notes — not the final deliverable)

## 0. The one-sentence verdict

可行，但要把用户提案里的三个隐含前提拆开纠正：
1. DSH 的 agent loop 不是 LangChain 式的「可替换链」，而是一个**事件溯源的状态机插件**；"换掉 loop" 有两种完全不同的含义（换 driver vs 换决策层），成本和风险差一个数量级。
2. 初始化注册表里的 "graph" 不可能是静态的相似度图；它必须是**由运行时注册表实时构建的类型化能力图**，加上每轮一次的任务匹配。
3. "动态选子图 + 按节点裁剪工具/指令" **不会自动省 token**；在单 session 内按 step 换 tool schema 会击穿 prefix cache，可能反而更贵。真正的省法来自**上下文隔离**（fresh subagent node）与会话级能力包络，而不是 step 级工具开关。

推荐路线：**L0 图注册表 → L1 单 session 图控制面（step 策略）→ L2 节点=结构化 subagent（上下文隔离/并行）→ L3 可选自研 AgentFactory 完全替换 driver**。L1/L2 全部是插件 + profile patch，不碰源码；L3 也只需 patch 掉 `agent-loop` row，但要复刻 session 事件契约，风险最高，收益增量最小，放到最后且有 kill criteria。

## 1. What the loop actually is (evidence)

- 一切皆 Cordis 插件；loop 本身是 `@deepseek-ai/dsh-agent-loop`，注册 `AgentFactory` 到 `ctx.agents`。
- `AgentFactory` 是公开接口 (`packages/core/agent/src/index.ts:175-210`)；`setFactory()` 已注册则抛错 (`:383`)。
- base profile 以 row id `agent-loop` 挂载 (`packages/bundle/base/cordis.patch.yml:513`)；profile patch 可整行替换 → 换 driver = 配置组合，不是改源码。
- turn = 0+ step；step = 一次模型请求 + 它发起的工具。持久事件：`turn/start, step/start, request/header, request/context, system/message, developer/message, user/message, assistant/message, assistant/attempt, tool/call, tool/result, step/end, turn/end`。
- `agent/pre-step`（waterfall）只能返回 `reject` 或 `enter{messages, startsRequestSeries}`；**工具集在 assembly 时已经确定，pre-step 改不了工具** (`packages/core/agent/src/runtime-types.ts:139-146,350`)。
- 工具按 step 动态可见的官方机制：`register(def, {when})`、`resolve()/ResolvedToolSet`、`ctx.tools.restrict()`；`when` 在**每次模型 step** 求值 (`packages/core/tools/src/contracts.ts:...`)。
- prompt 每 step 在 pre-step 之前 assemble；section 可动态 `text({scope,toolSet})`；`complete:true` 可整体替换 prompt；agent-scoped 注册 shadow global。
- 每步模型可见内容必须进 session log；`deriveMessages()` 从 log 投影。未知事件只有 `ignorable:true` 的 `plugin:*` 记录能存活，且外部插件"must not"调用 `appendPluginRecord`（文档策略）。
- 已有 orchestration 原语：subagent（`startActivation` 支持 `agentPreset` + `outputSchema` + `delivery:'caller'`，spawn provider fresh、capabilities 全开）、`workflowEngine`、`agentTeams`、`ctx.goals`、presets。
- `tool-ralph` 已经证明"自定义 loop 作为插件"可行：固定脚本 + 每轮 fresh structured child + 只传递 bounded report。**graph 只是 ralph 的泛化**。

## 2. Three architectures

### A. Graph control plane over stock loop (nodes = steps in one session)
Mechanism: plugin state machine; conditional tools per node; dynamic prompt section per node; transitions in `tools/result`/`step/end`; `agent/turn-stopping` steers to keep turn alive; model select per node.
+ No session-format risk; approvals/compaction/UI/inbox all work; turn-level durability free.
+ Cheap to build; can ship in weeks.
− No true context isolation (history grows); per-node tool/section changes invalidate prefix cache; no parallel nodes; node boundaries not durable (per-turn state).
− "Loop" is still the stock driver; user may feel this is not what they asked.

### B. Graph orchestrator with structured subagent nodes (nodes = fresh child sessions)
Mechanism: node = `ctx.subagents.startActivation({agentPreset, outputSchema, delivery:'caller'})`; graph runtime awaits `result`; state handoff explicit.
+ Real token savings (fresh context per node, stable node prefix → cross-run cache reuse); parallel fan-out; isolated failure; per-node model/tool/prompt; durable child sessions; visible in UI.
+ ralph already proves the pattern; presets give per-node composition without code.
− Per-node overhead (new session, prompt assembly, no shared history — need explicit state handoff); latency; sessions multiply (UI clutter, cost accounting).
− Graph state still per-turn; cross-node artifacts must be serialized in state (size limits).

### C. Custom AgentFactory replacing agent-loop
Mechanism: patch out `agent-loop` row; mount plugin implementing `AgentFactory.createAgent/resume`.
+ Full control of assembly (per-node prompt/tools without polluting history), native node boundaries, can keep tool set stable per node, parallel steps possible.
− Must reproduce: session create/open write handle, inbox + modelSelection projections, turn/step machine, prompt admission rules, request header/context logging, tool result recovery, cancellation, compaction integration, persistence flush, UI live events. Very large conformance surface; one bug bricks all sessions.
− `setFactory` exclusivity means all sessions change at once; no per-session A/B without separate profile.
− Highest maintenance cost across DSH versions.

**Recommendation**: A first (fast, low risk, proves matching quality), B second (proves token/accuracy value), C only if A+B show value and a measurable gap remains. Never start with C.

## 3. Token economics (the part most likely to be wrong in the user's proposal)

- Per-step tool schema changes invalidate prefix cache from the first changed schema token (docs explicit). In a single session A-mode, changing tools per node can cost more than it saves.
- Prompt rewrite per node (system node 0) invalidates from token 0; `systemPromptUpdate:'in-history'` appends and keeps prefix but accumulates tokens.
- Therefore:
  - Savings source #1: **session/preset-level capability envelope** (fewer tools for the whole session) — stable prefix, real savings.
  - Savings source #2: **fresh subagent nodes** — each node only pays its own small prompt+tools; no accumulated history; repeated node types reuse a stable prefix across runs.
  - Savings source #3: **removing irrelevant instruction sections entirely** (not toggling per step).
  - Savings source #4: **model tiering per node** (`agent.model.select`), cheaper model for routing/verification.
- Primary metric must be **cacheRead ratio + total billed input**, not raw prompt tokens.
- Break-even: saving S schema tokens per step vs losing C cached prefix tokens for the rest of the session. If cache read price is ~1/10 input: lose 10*C_input-equivalent... formula needs real numbers from token-economist.

## 4. Registry graph & matching critique

- "初始化时一张图" is impossible as a frozen artifact: tools register asynchronously, MCP tools appear at runtime, conditional tools are per-step, presets change composition. Correct: **live capability graph** built from `ctx.tools` (+`tools/change`), `ctx.systemPrompt` sections, `ctx.skills`, `ctx.agentPresets`, subagent providers, plugin inventory; snapshot at composition, updated on change.
- Similarity: description embeddings alone are a weak router. Layer signals:
  1. hard typed edges: `contributes`, `requires` (services/sandbox/approval), `produces`/`consumes` (artifact types), `conflicts`, `alternative`.
  2. deterministic features: tool name/params/output schema overlap, co-occurrence in historical successful sessions (`ctx.sessionQuery`), cost/latency priors.
  3. optional embedding/LLM only as tiebreaker for `alternative` edges.
- Matching: task signature (intent class, artifact types, surfaces, risk, context size, workspace facts) → hard filter (available/permitted) → score graph templates → top-1 or fallback default. Deterministic, cached per turn, confidence threshold; low confidence = default loop (no graph). This is the safety valve against accuracy regressions.
- Dynamic add/remove nodes: only at defined replan points (tool failure, validation failure, budget), max N replans, monotonic budget, every mutation logged as tool call/result (visible) so replay works.

## 5. What to build (package layout, draft)

```
dsh-graph/                      (monorepo or single package with subpath exports)
  packages/registry/            capability graph builder + snapshot + change tracking
  packages/router/              task signature, templates, scoring, cache
  packages/kernel/              graph kernel interface + (optional) LangGraph adapter
  packages/runtime/             state machine, node executors (step | subagent), replan, budget
  packages/plugin/              Cordis plugin: services, tools (graph_run/graph_status), hooks
  packages/eval/                benchmark harness + metrics
```

Public surfaces: `ctx.graphRegistry`, `ctx.graphRouter`, `ctx.graphRuntime`; model-facing `graph_plan`/`graph_run` (optional), `graph_status`.
Config: `mode: off|observe|shadow|active`, `templates[]`, `confidenceThreshold`, `maxReplans`, `nodeExecutor: step|subagent`, `budget{maxNodes,maxTokens,maxWallMs}`.

## 6. Phases & gates

- P0 (1w): registry + snapshot + `graph_status` tool; **observe only**. Gate: graph covers ≥95% of registered tools; snapshot rebuild <50ms; no behavior change.
- P1 (2-3w): router + templates + A-mode control plane behind `mode: shadow` (decisions logged, not applied). Gate: match top-1 accuracy vs human labels ≥80% on 40 tasks; fallback rate <20%.
- P2 (2-3w): A-mode active for low-risk tasks. Gate: token A/B non-regression (primary: billed input incl. cache), success ≥ baseline, p95 latency ≤ +15%.
- P3 (3-4w): B-mode subagent nodes + parallel + replan. Gate: ≥20% billed-input reduction on multi-step tasks with success ≥ baseline.
- P4 (optional): C-mode AgentFactory with conformance suite; only if P2/P3 pass and gap justifies.

Kill criteria: cache-adjusted cost regression >5%; success drop >3pp; match accuracy <70%; p95 latency +30%.

## 7. Open questions for teammates / final doc

- exact baseline tool count/token bytes in web+headless profile (token-economist)
- pre-step message identity/freeze constraints; can plugin inject instruction messages safely? (seam)
- external plugin durable state options; is per-turn state enough? (seam)
- LangGraph JS real dependency size/behavior; kernel abstraction choice (langgraph)
- how presets compose tool sets; per-node preset authoring cost (graph-designer/seam)
- UI/clutter/observability for many child sessions; cost attribution (Lead)
