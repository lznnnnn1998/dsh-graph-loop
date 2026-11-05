# 01 — Seam inventory: what a plugin can control, what it cannot, and what that forces

> Task: decide whether a graph loop can be built **without touching DSH source**, and if the answer
> is "a full replacement needs a fork", write the precise replacement inventory.
> Every claim carries `path:line` against `/Users/zhinan/deepseek-harness` @ `22ddee3792` (v`0.2.1-rc.3`).
> MEASURED = a probe in `spikes/seam-probe/` executed it; TYPED = proven by the published types;
> READ = read from source/docs only.

---

## 0. Bottom line (read this if you read nothing else)

| Question | Answer | Evidence |
|---|---|---|
| Can a plugin control the **tool set per step**? | **Yes**, via `ctx.tools.register(def,{when})`, `ctx.tools.restrict`, agent-scoped registrations. | MEASURED probe A + C; `core/tools/src/index.ts:128,162,264` |
| Can a plugin control the **prompt per step**? | **Yes**, all three mechanisms (section / context / variable), including `complete:true`. | MEASURED probe A; `core/system-prompt/src/index.ts:483,518,566` |
| Can `agent/pre-step` change tool schemas? | **No.** It can only replace the message batch. Tools are resolved *before* the waterfall. | TYPED probe A (`@ts-expect-error`); `agent-loop/src/agent.ts:285-305`; `agent/src/runtime-types.ts:138-146` |
| Can a plugin **add a second AgentFactory**? | **No.** `setFactory` throws when one is registered. | `core/agent/src/index.ts:383-385` |
| Can a **preset** replace the loop? | **No.** The host shares the loop; presets compose agent-scoped plugin trees. | `preset/agent-preset-registry/README.md:56`; `docs/architecture.md:150` |
| Can a **bundle/profile** replace the loop? | **Yes — but "replace" means "disable + insert", not "rename".** A patch's `name` is a guard, never an override. | MEASURED probe B; `vendor/include/src/index.ts:115-118` |
| Can a new loop import `agent-loop`'s internals? | **No.** The agent-loop package export map exposes only the root. | MEASURED `ERR_PACKAGE_PATH_NOT_EXPORTED`; `core/agent-loop/package.json:19-24` |
| Can a plugin add a durable event type that survives restart? | **No.** Only `ignorable` plugin records survive; `Session.append` cannot set `ignorable`. | READ `session-format-v3-to-v4/src/validation.ts:59-63`; `core/session/src/index.ts:806-861` |
| So which architecture? | **(A) control plane** works today and is measured. **(C) full replacement** is possible but is a **fork of 2 122 LOC** plus the private inbox/prompt/runtime-context folds. **(B) nodes-as-subagents** works today for fan-out. | §0 below, §6, §7 |

The user's premise — "the loop is very LangChain-like, replace it" — is **half right**. DSH is not a
chain library; it is a Cordis plugin tree where the loop is one swappable row
(`packages/bundle/base/cordis.patch.yml:513`). That makes replacement *supported*, not impossible —
and it makes the replacement *large*, because the row owns a state machine DSH deliberately keeps private.

**The architecture this forces.** The seams split cleanly along one line: everything the loop *asks of
other subsystems* (tool admission, prompt assembly, model calls, persistence, projections) is public
and reusable; everything that decides *when* to ask (turn/step phases, prompt admission order,
cancellation, tool-result recovery, inbox claim policy) is private. A graph engine therefore has two
honest shapes, and one dishonest one:

- **(A) graph as control plane** — the graph decides node transitions and expresses each node as
  `when` gates + prompt sections + pre-step/turn-stopping listeners; the stock loop keeps the step
  machine. Works today, measured end-to-end in probe C. Node granularity is limited to step/turn
  boundaries.
- **(B) graph of agents** — one child agent per node via `ctx.agents.create({setup})`, orchestrated
  by a plugin. Works today, gives every node its own tools/prompt/session/structured output, costs a
  fresh prompt cache and an approval-pinned `never` per node.
- **(C) graph as the loop** — a new `AgentFactory` row. The only shape that makes a node a *step*.
  Requires forking 2 122 LOC and re-registering three projections; no wrapper is possible because
  the class and its module paths are sealed.
It is not possible to "extend" the stock loop into a graph: there is no seam that inserts, removes,
or reorders steps.

---

## 1. Extension points a control plane can use (all no-source-change)

Legend: **Scope** = who can register it (global vs `agent.ctx`); **Timing** = when the loop evaluates it.

| # | Seam | Scope | Timing | Constraint / gotcha | Evidence |
|---|---|---|---|---|---|
| 1 | `agent/pre-step` (waterfall) | agent | once per **step**, after tool resolve + prompt assemble | decision = `{kind:'reject'} \| {kind:'enter', messages, startsRequestSeries?}` — **messages only**, `UserMessage[]` | `agent/src/runtime-types.ts:350`; `agent-loop/src/agent.ts:289` |
| 2 | `agent/turn-stopping` (serial) | agent | when the model owes no response | listener **steers** (`agent.steer`) to force another step; does not stop a tool loop | `agent/src/runtime-types.ts:417`; `agent-loop/src/agent.ts:389` |
| 3 | `agent/request-error` (waterfall) | agent | on a failed attempt | `{kind:'retry'}` only; cannot rewrite content | `agent/src/runtime-types.ts:389` |
| 4 | `agent/request` (waterfall, **deprecated**) | agent | before call prep | controls only; provider/model/effort already fixed → throws on diff | `agent-loop/src/agent.ts:628-633` |
| 5 | `tools.register(def,{when})` | global **or** agent | `when` awaited once per `resolve()` (per step) | `when` is async-capable; removal takes effect **next** step (see §2.3) | `tools/src/index.ts:128,273` |
| 6 | `tools.resolve({agent,modelSelection,signal})` | caller | per step | returns a step-owned `ResolvedToolSet`; dispose after batch | `tools/src/index.ts:264` |
| 7 | `tools.restrict({allow,deny})` | **agent only** | continuous (view fold) | throws on unscoped ctx; own registrations exempt; intersects down the scope chain | `tools/src/index.ts:162-189,214` |
| 8 | `tools.guard(fn)` / `tools/pre-execute` | global/agent | per call | monotonic denial, does not change schemas | `tools/src/index.ts:384` |
| 9 | `systemPrompt.section({name,order,text,complete})` | global/agent | every `assemble()` (per step) | scoped shadows global by name; **>1 effective `complete` throws** | `system-prompt/src/index.ts:483,657-661` |
| 10 | `systemPrompt.context({name,order,text,required})` | global/agent | assemble + `refreshContext` | materialized as a durable user-role snapshot | `system-prompt/src/index.ts:518,587`; `agent-loop/src/agent.ts:439-470` |
| 11 | `systemPrompt.variable(name, fn)` | global/agent | assemble | `{{name}}` strict; undefined value throws at render | `system-prompt/src/index.ts:566,369-377` |
| 12 | `agent.ctx.*` (scoped registration) | agent | at setup / runtime | is **what a node is**: tools+prompt+listeners for one agent | `agent/src/index.ts:103-122`; probe A |
| 13 | `agent.inject/steer/followup` | caller | next step / next turn | `inject` does not wake; `steer` claims at next step | `agent-loop/src/agent.ts:163-182` |
| 14 | `agent.runMaintenance(task)` | caller | from true idle only | used by compaction and the subagent manager | `agent-loop/src/agent.ts:192`; `compaction-basic/src/index.ts:414` |
| 15 | `ctx.agents.create({setup})` | any | creation | setup receives the **unpublished** agent's scoped ctx | `agent/src/index.ts:66-123` |
| 16 | `ctx.subagents` providers | any | per child | `outputSchema` + `agentOptions` + preset; **no tool-set field** | `subagent/src/types.ts:132-179` |
| 17 | `ctx.workflowEngine` | any | per run | JS script: `agent()/parallel()/pipeline()/phase()` | `workflow/workflow/src/index.ts:33,159` |
| 18 | `ctx.agentTeams` (experimental) | any | continuous | durable roster/tasks/inbox over subagents | `docs/architecture.md:140` |
| 19 | `ctx.sessionProjections.register(def)` | any | per committed event | pure sync fold; `wire` view for the client | `session/session-projection/src/index.ts:74,398` |
| 20 | `appendPluginRecord(session,type,data)` | any (policy) | per append | `ignorable`, invisible to the model, survives resume/fork | `core/session/src/index.ts:495,861` |
| 21 | `ctx.storageDomain` | any | continuous | host-side KV sidecar; invisible to model **and** loop | `storage/storage-domain/README.md` |
| 22 | `session/event`, `agent/status`, `agent/assistant-stream` | any | live | what the UI consumes | `api/session-controller/src/history.ts:54`; `index.ts:225` |

**What is not on this list, and why it matters:** there is no seam for "the loop should call the model
twice in one step", "the loop should skip a step", or "the loop should run node N before node M".
Step/turn shape is `ReactLoopAgent`'s private state machine (`agent-loop/src/agent.ts:45-53,320-426`).

---

## 2. Replacing the loop: the `AgentFactory` contract

### 2.1 The public seam

`AgentFactory` is declared on `dsh-agent`, not on the loop, precisely so consumers never depend on
the loop:

```ts
interface AgentFactory {
  createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle>
  resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle>
}                                                    // core/agent/src/index.ts:175-210
```

`AgentRegistry.create/resume` are thin `Reflect.apply` delegations to the registered factory
(`:416-441`). **Every product surface already consumes only this seam**: ACP (`acp/src/session.ts:119,138`),
Web session controller (`api/session-controller/src/agent.ts:324,378,453`), headless bundle
(`bundle/headless/src/index.ts:291,389`), SDK server (`sdk/server/src/server.ts:492-508`), the
subagent manager (`subagent/src/manager.ts:906-928`), webhook sessions
(`experimental/webhook/src/session.ts:110`). Replacing the factory therefore does **not** require
touching any of them — that is the strongest argument for architecture (C) being viable at all.

### 2.2 Coexistence is impossible

```ts
setFactory(factory) {
  const dispose = this.ctx.effect(() => {
    if (this.factory !== undefined) throw new Error('an agent factory is already registered')
    ...
```
`core/agent/src/index.ts:383-392`. Registration is an effect on the registry singleton, so the stock
loop and a graph loop cannot both hold it. The stock row must be **disabled** before the graph row
mounts — see §7. (A disposal-order accident could leave both loaded; whichever initializes second
fails loudly at activation.)

### 2.3 What the stock loop actually does per step (the thing being replaced)

```
turn/start                                         agent.ts:329
  claim inbox batch   -> agent/inbox/claimed       agent.ts:280
  tools.resolve({agent, modelSelection, signal})   agent.ts:285   <-- toolSet FIXED here
  systemPrompt.assemble(...)                       agent.ts:287
  agent/pre-step waterfall  -> {reject|enter}      agent.ts:289   <-- cannot touch toolSet
  step/start                                       agent.ts:354
  systemPrompt.refreshContext + project -> system/message   agent.ts:439-454
  admit decision.messages -> user/message          agent.ts:456-470
  request/header (initial|change|series)           agent.ts:668-684
  developer/message tool-addition / tool-removal   agent.ts:685-699
  request/context                                  agent.ts:710-716
  llm.stream -> assistant/message | assistant/attempt       agent.ts:483-576
  tools.execute({toolSet}) -> tool/call, tool/result        agent.ts:583-590
  step/end                                         agent.ts:381
  agent/turn-stopping (serial)                     agent.ts:389
turn/end                                           agent.ts:415
```

MEASURED consequence (probe C): flipping a node mid-turn changed the step-2 request's tool list to
`[]`, and the log gained a second `request/header` with `reason:"change"` **plus** a
`developer/message` carrying `tool-removal`. That is the price of dynamic tool gating, and it is
also why gating should happen at **node boundaries, not every step**: "Changing a retained tool
definition or rebuilding declarations invalidates reuse from the first altered request token"
(`core/agent-loop/README.md:164`).

### 2.4 Contract checklist — classified

Classification: **PUBLIC** = exported from a package's `exports` map; **FORK** = package-internal to
`dsh-agent-loop` (must be copied); **EVENT** = an event or log contract others already consume.

| # | Contract | Class | Why / evidence |
|---|---|---|---|
| 1 | `AgentFactory.createAgent/resume` signatures | PUBLIC | `agent/src/index.ts:175-210` |
| 2 | `Agent` runtime face (`options, session, model, inbox, status, ctx, cancel, whenIdle, runMaintenance, send, followup, steer, inject`) | PUBLIC | `agent/src/runtime-types.ts:190-271` |
| 3 | Session write handle: `persistence.create(header,…)` / `open(id,'write')`, `handle.read/append/close` | PUBLIC | `session-persistence/src/index.ts:159,174` |
| 4 | Crash repair: `interruptedTurnClosers(events)` | PUBLIC | `session/src/repair.ts:209`; used at `agent-loop/src/index.ts:801` |
| 5 | Unpublished-session wrapper `SessionPreparation` | PUBLIC | `session/src/preparation.ts:20-49` |
| 6 | Store publication `sessions.enter(session)` + `sessions.announce(session)` | PUBLIC | `agent-loop/src/index.ts:626-627` |
| 7 | Registry publication `agents.enter(agent, owner)` + `agents.announce(agent, source, signal)` | PUBLIC | `agent/src/index.ts:484,562` |
| 8 | `turnBoundary` projection | PUBLIC (by service) | registered by `AgentRegistry` itself (`agent/src/index.ts:298`); read via `ctx.agents.turnBoundaryOf` (`:306`) — **no fork needed** |
| 9 | `modelSelection` projection definition | PUBLIC | exported `agent/src/index.ts:23`; registered by loop at `agent-loop/src/index.ts:334` |
| 10 | **`inbox` projection definition** | **FORK** | `inboxProjectionDefinition` is exported by `agent-loop/src/inbox.ts:26` but **not from the package root** (`index.ts` exports only `DEFAULT_MAX_PARALLEL_TOOL_CALLS` + class), and the export map forbids `./src/*` → MEASURED `ERR_PACKAGE_PATH_NOT_EXPORTED`. Copy 232 LOC. Event vocabulary is public (`agent/src/types.ts:110`). |
| 11 | **`ReactLoopInbox`** (durable splice policy, claim rules) | **FORK** | `agent-loop/src/inbox.ts:73` |
| 12 | **`SystemPromptProjection` + prompt admission/reconciliation** (`system/message`, series starts, `in-history`) | **FORK** | `agent-loop/src/runtime-context.ts:68`; driven at `agent.ts:446-454,665-684` |
| 13 | **`RuntimeContextProjection`** (runtime-context snapshot admission, dedupe) | **FORK** | `agent-loop/src/runtime-context.ts:119`; `agent.ts:443,459-470` |
| 14 | **`AssistantStreamAttempt`** (live chunk frames, settle on commit) | **FORK** | `agent-loop/src/assistant-stream.ts:18` |
| 15 | **Turn/step state machine** (phases, wake latch, cancellation, max-tokens stickiness) | **FORK** | `agent-loop/src/agent.ts:45-53,261-426` |
| 16 | **Tool-call recovery** (`ToolCallRecovery` re-emitting results after a step error) | **FORK** | `agent-loop/src/agent.ts:356-382`; `session/src/tool-history.ts` |
| 17 | `runMaintenance` publication path (used during setup) | FORK | `agent-loop/src/index.ts:620` |
| 18 | `agent/status`, `agent/assistant-stream`, `agent/error`, `agent/created`, `agent/disposed` | EVENT | UI/consumers: `api/session-controller/src/history.ts:54`, `index.ts:225`; subagent manager, agent-team, goal |
| 19 | `request/header`, `request/context`, `system/message`, `developer/message` log shape | EVENT | `session/src/known-event-types.ts:22`; compaction/title/token-meter read them |
| 20 | `tool/call`, `tool/result`, `turn/*`, `step/*` durable shape | EVENT | same |
| 21 | `agent.answer`… approval / ask-user contracts | EVENT | approval events are log-only (`known-event-types.ts:25-27`) |

**Estimate (ESTIMATE):** a faithful replacement forks `core/agent-loop/src` **2 122 LOC** of which
~1 240 LOC is genuinely loop-private (agent.ts 738 + inbox.ts 232 + runtime-context.ts 169 +
assistant-stream.ts 140 = 1 279, minus the ~40 LOC that are public helpers), plus re-registration of
three projections and the publication choreography. Everything below the loop (tools, prompt,
session, persistence, llm) is reused unchanged — that is ~15 kLOC of behaviour a new loop inherits.

---

## 3. Durable graph state: three options, ranked

| Option | Durable across resume | Across fork | Model-visible | Survives compaction | Tooling / policy | Evidence |
|---|---|---|---|---|---|---|
| **A. `appendPluginRecord`** (`plugin:<owner>/<rec>`) | ✅ carried with log | ✅ doc says fork carries it | ❌ never enters the surface | ✅ untouched by compaction | Documented as **experimental-packages only**; repo gate `verify-plugin-record-callers` only scans the DSH checkout's `git ls-files` (`scripts/verify-plugin-record-callers.ts:37,104,251`) → an out-of-tree plugin is not rejected, but the policy says "must not" | `session/src/index.ts:475-500`, `:861`; `types.ts:544` |
| **B. New `SessionEventMap` type** | ⚠️ only if also in `KNOWN_SESSION_EVENT_TYPES` | ⚠️ same | ✅ if a projection renders it | ✅ | `restoreReleasedV4Artifact` **throws** `SessionFormatUnsupportedMigrationError` for an unknown non-ignorable type; and `Session.append` has no `ignorable` parameter → an out-of-tree type is unreadable after restart | `session-format-v3-to-v4/src/validation.ts:59-63`; `session/src/index.ts:806-847` |
| **C. `ctx.storageDomain` sidecar** | ✅ host KV, keyed by *your* key (use `session.id`) | ❌ new session id → copy yourself | ❌ invisible to model and loop | ✅ | Cleanest documented external path; but not session-format-versioned and not exported with the session | `storage/storage-domain/README.md` ("host-side state … remains invisible to the model and agent loop") |

**Recommendation:** C (sidecar keyed by `session.id`) for graph position/edge state + A (plugin
record) only if the graph must travel with a forked/copied session transcript. **Do not** declare a
new `SessionEventMap` type — it compiles and then fails at first restart.

**How the model sees the graph node:** not through state at all — through a `systemPrompt.section`
whose provider reads the sidecar at assembly time. MEASURED probe C: the section text changed
between the two steps with no re-registration, and the prompt is re-assembled every step
(`agent-loop/src/agent.ts:287`), so compaction cannot lose it (compaction only replaces the
message surface — `compaction/src/types.ts:75-80`).

**Durability limit to design around:** `appendPluginRecord` throws when a store-owned session is
unentered or its creation announcement is incomplete (`session/src/index.ts:872-884`), i.e. you may
not write graph state before `session/created` completes. Register a `systemPrompt.section` (safe at
setup) for anything needed on the first step.

---

## 4. A node as a scoped subagent (with its own tools + prompt + structured output)

**Yes — and this is public API.** The exact path the in-process subagent backend uses:

```
ctx.agents.create({                              // subagent/src/manager.ts:913-928
  sessionId, parentAgent: parent,
  meta: childSessionMeta(parent, depth, seeded, preset),   // child-agent.ts:133-155
  agentOptions: resolveChildAgentOptions(...),             // child-agent.ts:107-130
  setup: async (childCtx, child) => {                      // child-agent.ts:191-232
    applyChildComposition(childCtx, parent, { agentPreset, persona, toolFilter })
    //   -> presets.mount / composeFrom, systemPrompt.context/section, tools.restrict
    if (outputSchema) attachStructuredRuntime(childCtx, outputSchema, canComplete)
  },
})
```

- **Own tool set:** `childCtx.tools.restrict({allow,deny})` and/or `childCtx.tools.register(...)`.
  (`child-agent.ts:224-232`; `tools/src/index.ts:128,162`)
- **Own prompt:** `childCtx.systemPrompt.section({complete:true})` shadows everything;
  `systemPrompt.context` for a runtime fact. (`child-agent.ts:204-222`)
- **Structured output:** `attachStructuredRuntime` registers a `structured_output` tool whose
  arguments are validated against the node's schema and captured after the authoritative result
  (`subagent/src/structured.ts:19-64,56`). Data must be plain host JSON.
- **Durable:** each node is its own Session, so its transcript is auditable and resumable.

Cost vs an in-session step (READ, not measured):

| Dimension | In-session step | Child agent per node |
|---|---|---|
| Model calls | 1 | ≥1 (fresh turn; usually ≥2 with the structured-output call) |
| Tokens | shared cached prefix | **new session = no prefix reuse**, own system prompt, own tool schemas |
| Latency | one request | spawn + create + publish + turn |
| Session log | same session | separate session (lineage `parentSession`, `origin:'subagent'`) |
| UI | same chat | child transcript, appears as a delegation |
| Permissions | parent's | approval pinned `never` (`child-agent.ts:248-260`) — a node **cannot** ask the user |

Use subagent nodes for **fan-out/parallel** or for nodes that must not contaminate the main context;
do not use one per graph step, or the token cost dwarfs whatever the graph saves.

---

## 5. Presets cannot replace the loop; a bundle/profile can

### 5.1 Preset boundary (verified)

> "Each declaration eagerly creates a registry-owned scope and an in-memory Loader tree. …
> Plugin registrations inherit the preset scope, and the Agent scope's parent link controls
> visibility. **The Host continues to share the Agent loop.**"
> — `packages/preset/agent-preset-registry/README.md:56`

Corroborated by `docs/architecture.md:150`: "Give one session a different capability set … a service
row there needs an `isolate` realm" — a new loop is a *host* service row, not an agent-scoped one.
The shipped presets (`minimal`, `standard`, `cordis`, `ptc`) insert one `@deepseek-ai/dsh-agent-preset`
declaration with a `plugins` list (`bundle/web-app/presets/minimal.patch.yml:4-16`). They cannot
carry the loop.

### 5.2 The shipped "modes" are profile templates, and that list is a literal

```ts
export const PROFILE_TEMPLATES: Record<string, ProfileTemplate> = {
  acp: {...}, web: {...}, headless: {...}, sdk: {...}, 'sdk-minimal': {...},
}                            // packages/util/official-bundles/src/bundles.ts:10-26
```

There is no `explore`, and adding one is a source change (forbidden). **Workaround (documented,
no source change):** ship `explore` as a **bundle** and let the user create a profile with
`dsh plugin --profile explore add ./graph-loop-bundle`. The first use initializes a base-backed
profile (base bundle first) and appends the bundle to `dsh.profile.bundles`
(`docs/user/develop/basic/publish.md`, "The profile manifest" / "Install into a profile");
`dsh --profile explore --dump-config` shows the layer before boot. The bundle's `cordis.patch.yml`
does the row surgery in §5.3. That gives the *experience* of an `explore` mode without editing
`PROFILE_TEMPLATES`.

### 5.3 Patch semantics: `name` is a guard, not an override (MEASURED)

```ts
const { id, insert, name, ...overrides } = patch
if (name && name !== target.name) { warn('patch: name mismatch …'); continue }  // include/src/index.ts:115-118
```

So `- {id: agent-loop, name: '@deepseek-ai/dsh-graph-loop'}` is **skipped** with a warning — it does
not repoint the row. `applyEntryPatches` is the one implementation shared by mounting and
`dsh --dump-config` (`vendor/include/src/index.ts:44-57`), so this is not a dump-only artefact.

**The working recipe** (`spikes/seam-probe/patches/graph-loop.patch.yml`, MEASURED by probe B):

```yaml
- id: agent-loop
  name: '@deepseek-ai/dsh-agent-loop'   # guard only; fails soft if the row changes owner
  disabled: true
- insert:
    - id: graph-loop
      name: '@deepseek-ai/dsh-graph-loop'
      config: { mode: explore, maxParallelToolCalls: 4, agents: [] }
```

Probe B results against the real base layer: 97 rows → 98, stock row disabled in place, graph row
inserted, zero warnings, no enabled stock row left.

**Two migration hazards this creates (both MEASURED in probe B):**
1. Overlays that configure `- id: agent-loop` (dozens of test fixtures, e.g.
   `apps/cli/tests/profiles/headless/tests/fixtures/cli.patch.yml:10`, and user profiles) keep
   addressing the row id — they now land on the **disabled** row and silently do nothing.
2. Inserting a second row with id `agent-loop` composes to two rows, and the Loader keys rows by
   `store[id]` (`vendor/loader/src/config/tree.ts:51-58,62-73`), so id-addressed patches become
   ambiguous. Choose deliberately: keep the graph row id `agent-loop` (overlay compatibility,
   duplicate-id risk) **or** rename and give users a migration note.

---

## 6. REPLACE / REUSE / KEEP-CONTRACT / RETIRE inventory

LOC = `src/**/*.ts` line count, MEASURED with `find … -exec cat {} + | wc -l`.
Risk = what breaks if a forked loop gets it wrong.

### 6.1 REPLACE (the fork surface)

| Package / file | LOC | Role | Risk if replaced wrong |
|---|---|---|---|
| `core/agent-loop/src/agent.ts` | 738 | turn/step state machine, prompt admission, tool dispatch | turn shape, cancellation, max-tokens stickiness, tool-result recovery |
| `core/agent-loop/src/index.ts` | 837 | factory, publication choreography, config agents, teardown order | leaked sessions/handles, double-announce, lost pre-publication events |
| `core/agent-loop/src/inbox.ts` | 232 | durable splice fold + claim policy | inbox projection diverges on resume; steering lost |
| `core/agent-loop/src/runtime-context.ts` | 169 | system-prompt + runtime-context projections | duplicate/lost system messages, broken `in-history` |
| `core/agent-loop/src/assistant-stream.ts` | 140 | live stream frames + settle | Web UI stops streaming; aborted attempts lose their record |
| `core/agent-loop/src/constants.ts` | 6 | default parallelism | trivial |
| **total** | **2 122** | | |

### 6.2 REUSE (public API; do not fork)

| Package | LOC | Why reused | Coupling to the loop |
|---|---|---|---|
| `core/tools` | 3 710 | registry, `when`, resolve, execute pipeline, guards | none — the loop is just a caller (`tools/src/index.ts:264,375`) |
| `core/system-prompt` | 697 | sections/contexts/variables/tool providers, deterministic order | none |
| `core/session` | 3 353 | event log, surface, fork, repair, plugin records | none |
| `session/session-projection` | 932 | projection registry | none |
| `session/session-checkpoint-policy` | 83 | checkpointing policy | none |
| `core/agent` | 1 824 | `AgentFactory`, registry, turn-boundary projection, model selection, initiator scope | the loop is the *implementation* of its factory slot |
| `core/scope` | — | agent scopes (`createScope`) | none |

### 6.3 KEEP-CONTRACT (driven by events; must keep emitting/consuming the same shapes)

| Package | LOC | Contract | Evidence |
|---|---|---|---|
| `compaction/compaction` | 505 | service definition + `runMaintenance`-based condensing; checkpoint marker | `compaction/src/index.ts:85,146` |
| `compaction/compaction-basic` | 1 739 | auto-compaction on `agent/pre-step`/`agent/status`/`agent/request-error` + `session/event` | `compaction-basic/src/index.ts:157,177,207,213,414` |
| `compaction/command-compact` | 108 | `/compact` | — |
| `plan/plan-mode` | 538 | `agent/pre-step` gating + `request/header` inspection + `plan/mode` event | `plan-mode/src/index.ts:12,155` |
| `goal/goal` | 1 306 | `agent/created` + `session/event` (rounds, continuation) | `goal/src/index.ts:258,261` |
| `subagent/subagent` | 5 163 | consumes `agents.create/resume`, `runMaintenance`, emits `subagent/*` | `manager.ts:906-928,1069` |
| `subagent/tool-subagent` + `-control` | 1 030 + 286 | model-facing delegation | — |
| `subagent/subagent-spawn-in-process` / `-fork-in-process` | 59 / 83 | provider registration only | — |
| `workflow/workflow` + `tool-workflow` + `workflow-ptc` | 383 + 615 + 1 336 | `agent()`/`parallel()`/`pipeline()`; children via agents factory | `workflow/src/index.ts:159` |
| `experimental/agent-team` + `experimental/tool-agent-team` | 2 172 + 432 | `agent/created`/`agent/disposed` + `ctx.agents` | `tool-agent-team/src/index.ts:423` |
| `experimental/tool-ralph` | 477 | injects `tools, workflowEngine, subagents, systemPrompt` | `tool-ralph/src/index.ts:18` |
| `todo/tool-todo` | 271 | tool + projection only | — |
| `interaction/tool-ask-user` | 327 | tool + approval events | — |
| `preset/agent-preset` + `agent-preset-registry` | 30 + 1 083 | agent-scoped composition (never the loop) | README:56 |
| `client/ui-settings-agent-loop` | 273 | settings card for `maxParallelToolCalls` | `agent-loop-card-controller.ts:21-50` — breaks if the new row drops the config key |
| `test-support/agent-loop-testkit` | 211 | mounts the **stock** `AgentLoop` (`testkit/src/index.ts:31,103`) → a fork needs its own testkit | — |
| `api/session-controller` | 8 320 | consumes `agent/assistant-stream`, `agent/status`, `session/event` | `history.ts:54`, `index.ts:225` |
| `bundle/base` (patch) | 531 | row `agent-loop` at `:513` is the swap point | — |
| `bundle/web-app` (patch) | 592 | presets + `ui-settings-agent-loop` row (`:447`) | — |

### 6.4 RETIRE (or leave dead)

| Item | LOC | Note |
|---|---|---|
| `core/agent-loop` (once the fork ships) | 2 122 | keep the package installed only if a legacy profile may still boot it |
| `client/ui-settings-agent-loop` | 273 | replaced by a graph settings card, or repointed at the new config |
| `test-support/agent-loop-testkit` | 211 | fork into a graph testkit |
| `bundle/base:513` row config `agents: []` | — | config shape changes to `{mode, nodes, entry, agents}` |

---

## 7. What is impossible without source changes

1. **Register a second AgentFactory** alongside the stock loop — `setFactory` throws
   (`core/agent/src/index.ts:383-385`).
2. **Repoint a row's plugin by patch** — `name` is a guard (`include/src/index.ts:115-118`). The
   loop can only be *disabled*, then replaced by a new row.
3. **Import `agent-loop` internals** (`inboxProjectionDefinition`, `ReactLoopAgent`,
   `SystemPromptProjection`, `AssistantStreamAttempt`) — root-only export map; MEASURED
   `ERR_PACKAGE_PATH_NOT_EXPORTED`.
4. **Ship a new `explore` profile template** — `PROFILE_TEMPLATES` is a literal
   (`official-bundles/src/bundles.ts:10-26`).
5. **Declare a durable custom session event type that survives restart** — unknown non-ignorable
   types are rejected on read (`validation.ts:59-63`) and `Session.append` cannot set `ignorable`.
6. **Change tool schemas inside `agent/pre-step`** — `PreStepDecision` carries messages only
   (`runtime-types.ts:138-146`), and the loop resolves tools before the waterfall
   (`agent.ts:285` vs `:289`). TYPED, probe A.
7. **Insert an extra model call, skip a step, or reorder nodes *inside* the stock loop** — no seam;
   the state machine is private (`agent.ts:45-53,261-426`).
8. **Make the model see unlogged content** — "Model-visible means logged"
   (`docs/architecture.md:128`). Graph state must arrive through a section/context (which is logged).
9. **Make a preset replace the loop** — `preset/agent-preset-registry/README.md:56`.
10. **Reuse the stock loop as a library inside a custom factory** (wrap, don't fork) — the class is
    not exported and the module path is sealed. A custom factory must *re-implement* the driver or
    mount a private copy of the package (a fork, not a wrapper).

---

## 8. Open questions for the Lead

1. **Is "explore" a profile or a bundle?** A true shipped mode needs `PROFILE_TEMPLATES` (source
   change). Recommend: bundle + user profile now; upstream the template later.
2. **What is the graph's unit — step, turn, or agent?** Step-level node transitions are cheap in
   control-plane terms but expensive in KV-cache terms (probe C). Turn-level is the sweet spot for
   (A); per-node agents is (B) and costs a fresh cache per node.
3. **Does the graph state need to travel with a forked session?** If yes → plugin records; if no →
   `storageDomain` sidecar (recommended).
4. **Should the replacement keep the `agentLoop` service name and `maxParallelToolCalls` config key?**
   `ui-settings-agent-loop` and `tool-cordis`'s API catalog assume them
   (`api-catalog.ts:136`); keeping them costs nothing.
5. **Who owns approval semantics for graph nodes?** Child-agent nodes are pinned to `never`
   (`child-agent.ts:248-260`), so an "explore" node that needs a user decision must stay in-session.
6. **Token claim still unquantified here.** Probe C gives the mechanism and the log cost, not a
   number; the token-meter comparison belongs to the token task
   (`ctx.tokenMeter`, `llm/token-meter/src/breakdown-projection.ts:144`).

**Confidence:** high on §1, §2, §5, §6, §7 (executed or read to a specific line); medium on the LOC
estimate for the fork (§2.4, ESTIMATE); medium-low on §4 cost ratios (read, not measured).

---

## 9. Reproduce

```sh
cd spikes/seam-probe
node src/probe-a-tool-gating.ts   # 12 checks: per-step tool/section gating, restrict, stale-set rules
node src/probe-b-patch.ts         # 12 checks: real patch composition, row surgery, name-guard, hazards
node src/probe-c-live-loop.ts     #  9 checks: real headless turn on the stock loop, per-step gating
node /Users/zhinan/deepseek-harness/node_modules/typescript/bin/tsc -p tsconfig.json   # exit 0
```

`node_modules/@deepseek-ai/*` are symlinks into the read-only checkout; nothing in the checkout was
modified. Probe C needs no API key (scripted `LlmAdapter`, `ctx.llm.registerAdapter(['mock'], …)`).

### What could NOT be run, and why

| Item | Why not |
|---|---|
| `dsh --profile explore --dump-config` against a real profile | `prepareProfile` writes `cordis.yml` into `$DSH_HOME/profiles/<name>` (`apps/cli/src/profile-boot.ts:198`), outside this task's write scope; a fresh profile would need a pnpm install. Probe B executes the same composition functions instead (`applyEntryPatches` is documented as shared by mounting and dump-config). |
| Mounting a real graph `AgentFactory` end-to-end | Needs a persistence backend + a driver; the skeleton (`plugin/graph-loop-factory.ts`) is compile-only and throws. |
| Subagent-node latency/token measurement | Needs a real model route; only the code path is documented here. |
| Compaction-over-graph-state observation | Would need a compaction backend plus a long session; argued from `refreshContext`/assembly ordering instead. |
