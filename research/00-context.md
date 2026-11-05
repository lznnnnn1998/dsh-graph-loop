# Shared context — DSH graph-loop evaluation

> Read this first. It is the Lead's reconnaissance, not the final answer. Verify anything
> you plan to cite; file:line evidence beats prose.

## Workspace / repo

- Workspace (write here): `/Users/zhinan/Documents/dsh_workspace/dsh-graph-loop`
- DSH checkout (READ-ONLY reference): `/Users/zhinan/deepseek-harness` @ git `22ddee3792`, version `0.2.1-rc.3`
- Toolchain: Node v26.0.0, pnpm 11.28.5, npm registry reachable, repo already has `node_modules`.
- **Hard rule**: do not modify, format, install into, or generate files inside the DSH checkout.
  All artifacts go under the workspace. Running read-only commands against it is fine.
- Approval prompts are disabled; never request sandbox escalation.

## The user's proposal (verbatim intent, condensed)

Replace parts of the current agent loop (described by the user as "very LangChain-like") with a
LangGraph-based loop. At initialization there is a registry **graph** recording tools, plugins,
agents and their similarity/relations. When a task arrives the harness computes one **match**,
picks the most suitable **sub-graph** as the task loop, and adds/removes nodes on demand, to raise
completion efficiency/accuracy and cut instruction assembly and token cost. Do not change DSH
source.

## What DSH actually is (verified so far)

DSH is not a LangChain-style library; it is a **Cordis plugin tree**. Every subsystem is a
replaceable plugin/service. There is no privileged core to patch: extensions mount beside others
and registrations are reversible effects.

Key facts:

- `docs/architecture.md` — turn flow, events, seams, "where new behavior goes" table.
- The loop is itself a plugin: `packages/core/agent-loop` provides `ctx.agentLoop` and registers an
  `AgentFactory` on `ctx.agents` (`packages/core/agent/src/index.ts:383 setFactory`).
- Public seam: `AgentFactory.createAgent(ownerCtx, options)` / `.resume(...)`
  (`packages/core/agent/src/index.ts:175-210`). Consumers depend on `dsh-agent`, never on the loop.
- `setFactory()` **throws if a factory is already registered**. So a replacement factory must be
  composed by patching out the `agent-loop` row, not by registering beside it.
- Base composition mounts the loop as row id `agent-loop` in `packages/bundle/base/cordis.patch.yml:513`.
  A profile `cordis.patch.yml` can target that row by id (patch replaces the row) — this is config
  composition, not a source change.
- Turn = 0+ steps; step = one model request + the tools it calls.
  Durable events: `turn/start`, `step/start`, `request/header`, `request/context`, `system/message`,
  `developer/message`, `user/message`, `assistant/message`, `assistant/attempt`, `tool/call`,
  `tool/result`, `step/end`, `turn/end`. Live waterfall events: `agent/pre-step`, `agent/request`
  (deprecated), `llm/stream`, `tools/pre-execute|execute|post-execute`, `tools/result`;
  serial `agent/turn-stopping`.
- `agent/pre-step` is a waterfall with decision `{kind:'reject'} | {kind:'enter', messages,
  startsRequestSeries?}` — it can replace the message batch entering the step, but **tool schemas
  are already resolved before it** (assembly supplies `context.toolSet`).
- Tool gating per step exists without source changes:
  - `ctx.tools.register(definition, { when })` — condition evaluated once per model step with
    `{agent, modelSelection, signal}`; false removes the tool from schemas/executor for that step.
  - `resolve({agent, modelSelection, signal})` → step-owned `ResolvedToolSet`; `ctx.tools.execute(batch)`
    takes it; `schemas(scope, toolSet)`.
  - `ctx.tools.restrict(filter)` — allow/deny mask for one agent scope (intersecting).
- Prompt assembly per step: `ctx.systemPrompt.assemble(context)` **before** `agent/pre-step`;
  sections can be static or `text({scope, toolSet})` dynamic; variables `{{name}}`; a `complete:true`
  section replaces the whole prompt; agent-scoped registrations shadow globals.
- Session log is the only source of model history: `deriveMessages()` projects it. Every
  model-visible input must be logged. Plugins can register `ctx.sessionProjections` units and
  `ctx.sessions.registerMessageProjection()`.
- Durable custom state: `appendPluginRecord(session, type, data)` appends an `ignorable: true`
  event with type `plugin:<owner>/<record>`; docs say it is **for packages under
  `packages/experimental/` only and external plugins "must not" call it** (no runtime gate found
  yet). Unknown ignorable events survive restore (`KNOWN_SESSION_EVENT_TYPES` + ignorable).
  Any other new `SessionEventMap` type is compile-time only and is checked by repo tooling.
- Token measurement already exists: `ctx.tokenMeter.measure(session)` gives `totalTokens`,
  `surfaceTokens`, per-node tokens; projection `contextBreakdown` = `{systemTokens, toolsTokens,
  messageTokens}`; `contextPressure` = `{pressureTokens, projectedTokens, contextWindow}`;
  `tokenUsage` = `{uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}`.
  Deterministic replay-based heuristic, no model calls. Great for A/B measurement.
- KV-cache warnings are explicit in the docs: changing visible tool definitions, their order, or
  prompt text can invalidate prefix reuse "from the first changed schema/prompt token"
  (`packages/core/system-prompt/README.md`, `packages/core/tools/README.md`,
  `packages/core/agent-loop/README.md#model-experience`). **This is the main risk to the
  "dynamic tool gating saves tokens" claim.**
- Existing orchestration that a graph could reuse instead of rebuilding:
  - Subagents: `ctx.subagents`, `ctx.agents.create({ setup })` with per-agent scoped tools/prompt,
    `packages/subagent/*`, `packages/tool-subagent`.
  - `ctx.workflowEngine` (`packages/workflow/workflow`) — JS orchestration scripts with
    `agent()/parallel()/pipeline()/phase()`; tool `workflow`.
  - `ctx.agentTeams` (experimental) — durable roster/tasks/inbox.
  - Agent presets: per-session plugin composition, `packages/preset/agent-preset-registry`.
- Out-of-tree plugin packaging is documented: `docs/user/develop/basic/publish.md`
  (`dsh.bundle` manifest + `cordis.patch.yml`; install with `dsh plugin --profile X add ./pkg`).
  Local dev: `--patch ./file.yml` with absolute TS module path.
- Available LLM helper packages: `packages/llm/llm`, `llm-deepseek`, `llm-pi-ai`, and
  `packages/test-support/llm-replay` (deterministic replay adapter — check whether it can drive
  headless tests without an API key).

## Evaluation stance the Lead wants

Be adversarial and evidence-driven. Two claims must be tested, not assumed:

1. **"Replace the loop with a graph"** — decide between (A) graph as control plane over the stock
   loop, (B) graph nodes as subagents, (C) full custom `AgentFactory` replacing `agent-loop`.
   Weigh capability, risk, session-format fidelity, UI/approval/compaction compatibility.
2. **"Matching + dynamic sub-graph cuts instruction/token cost"** — quantify baseline and delta,
   including the KV-cache penalty and per-node overhead. If the numbers do not support it, say so.

Also treat "similarity between tools/plugins/agents" as an open design question: description
embedding similarity is one weak signal; schema overlap, artifact pre/post-conditions, co-occurrence
in past sessions (`ctx.sessionQuery`), cost/risk are stronger. Prefer explicit typed edges plus a
small learned/heuristic score over "embed everything and cosine".

## Artifact conventions

- Everything in English or Chinese; final user-facing plan is Chinese.
- Cite DSH claims as `path/to/file.ts:LINE` or `docs/...md#anchor`.
- Mark estimates as ESTIMATE and measurements as MEASURED with the command used.
- Do not edit files outside your assigned write scope. Report file paths back to the Lead.
