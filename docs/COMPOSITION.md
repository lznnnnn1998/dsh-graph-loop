# Composition layer — decision record and v0.2 contract

Status: **active direction** (2026-11-06). This document supersedes the "replace the loop first"
framing in [`docs/archive/explore-mode-plan.zh.md`](archive/explore-mode-plan.zh.md), which remains as historical
research. Topology heuristics remain valid in [`docs/reference/DYNAMIC-TOPOLOGY.md`](reference/DYNAMIC-TOPOLOGY.md) and
[`docs/reference/TOPOLOGY-OPTIMALITY.md`](reference/TOPOLOGY-OPTIMALITY.md).

> 中文摘要：0.2 的方向不是「图循环打败线性循环」，而是**组合层**——用 LangGraph 式的类型化图，
> 把 DSH 的插件能力（工具、技能、preset、子代理、上下文）组合成**每轮一张图 + 每轮一个能力包络**。
> 图可看（Graph tab）、可查（checkpoint 落在 `storageDomain`）、由 harness 执行；不默认 fork loop。
> fork 只在 2 个以上触发条件成立时才重新考虑。

---

## 0. Value and end state

**One sentence.** A DSH-native, tool-agnostic orchestration plugin that is measurably better than
the official default experience on a public benchmark, and that external users actually install,
use and extend.

**Personal value.** Community contribution: leave something the DSH ecosystem uses and extends. Not
a business, not a résumé piece, not a general agent framework.

**What “final result” means.** There is no 1.0 gate; the project is milestone-driven and the first
hard decision point is the Terminal-Bench 4.0 subset (§5). When it is working, three states hold together:

- **product + evidence** — one-command install plus a public head-to-head report;
- **ecosystem** — third parties publish designs against the role / artifact / template contract;
- **sustainable OSS** — releases, CI, contributors, and a DSH upgrade strategy.

**Adoption funnel.** Public evidence → external installs / real use → external issues, PRs and
templates → official listing or recommendation (optional). “Liked” means installs/activity/feedback
first, stars/forks second, official listing third.

**If the core claim fails.** Two assets remain worth keeping: the Graph tab (observability product)
and the reusable composition contract (infrastructure). The repo is not a paper and should not be
kept alive as a consolation prize.

**Non-goals.** Not a general agent framework (no LangGraph/LangChain competition); not a craft or
domain toolset; not fork-first (control plane first, fork only on 2+ triggers); not a research
project (evaluation is a means, not the product).

---

## 1. Why the direction changed

The first plan optimized for an abstract graph-loop-versus-stock-loop duel with cost gates. The
evidence did not support that framing (structural A/B added steps on non-trivial tasks; the real A/B
was never run), and the cost story contradicted the cache evidence. What survived is the
architectural motivation: **LangGraph's design is a better way to compose a harness than a flat tool
surface plus one linear loop.** The 2026-11 value review kept that motivation but changed the claim:
the repo must beat the **official default experience** on a public benchmark, measured across three
arms (D14/D15) — composition is the mechanism, the comparison is the proof.

| Old assumption | Decision now | Why |
|---|---|---|
| "Graph beats linear" as an abstract claim | Compose plugins into a per-turn graph, then beat the official default on a public benchmark | Composition is the mechanism; a three-arm comparison is the proof (D14/D15) |
| Replace `agent-loop` first | Control plane over the stock loop first | Fork maintenance and upstream risk; fork only on evidence |
| Per-step tool gating shrinks context | Per-turn capability envelope; tools stable inside the turn | Per-step schema changes invalidate the prefix cache |
| Graph state is projected from the log | Checkpoints are authoritative for graph state; the log is the conversation | Durability and replay without abusing the session format |
| Plugin records are an acceptable exception | Use `storageDomain` instead | Upstream-safe, public API, no format-policy debt |
| All parallelism modes are equal | Parent log is single-writer; branches are child sessions | Preserve stock conformance and session invariants |
| Plugins may contribute node executors | Harness owns every executor | Replay, checkpointing and auditability |
| Cost is a hard gate | Accuracy is the veto; speed, cost and experience are secondary | The value claim is measured, not assumed |
| Mid-turn crash resume | v1 closes interrupted turns like stock; design for later | Stock repair semantics are relied on everywhere |
| Long-term memory | Context selection only; durable memory is a third-party plugin | Scope and ownership |
| Fork is the product | Composition bundle first; loop bundle later | Control-plane risk and maintenance |

---

## 2. Decisions (normative for 0.2)

| ID | Decision |
|---|---|
| D1 | The unit of composition is a **hybrid executor node** (`step`, `tool-batch`, `subagent`, `context`). Individual plugins stay untouched. |
| D2 | The **harness owns all execution**. Third parties contribute capabilities and templates, never node executors. |
| D3 | A graph lives for **one turn**. State resets per turn; the conversation is the shared memory. |
| D4 | The **per-turn capability envelope** is chosen at turn start and is stable inside the turn. |
| D5 | Tools stay stable within the turn; **prompt sections and memory selection may vary per node**. |
| D6 | Graph state is **typed channels** (JSON-only). **Checkpoints are authoritative**; the session log records the conversation. |
| D7 | Checkpoints live in a **`storageDomain` sidecar**, keyed by session / turn / node. No plugin records, no workspace files. |
| D8 | The parent session is **single-writer**. Parallel branches are **child sessions**; joins are injected summaries. |
| D9 | In-step tool batches (stock `maxParallelToolCalls`) are allowed; concurrent writers in the parent log are not. |
| D10 | v1 **closes interrupted turns** on restore exactly like stock; checkpoints remain for replay and the Graph tab. The contract stays resumable in principle. |
| D11 | **Memory = context selection** over what is already in the conversation. Durable memory is out of scope. |
| D12 | Build the **control plane over the stock loop first**; fork only if 2+ triggers in §7 fire. |
| D13 | The **first upstream artifact is a composition bundle**, not a loop replacement. A loop bundle is a later proposal. |
| D14 | The **product line** is evaluated on **10 easy + 10 medium Terminal-Bench tasks** — tasks within model capability. The hard Terminal-Bench subset is a separate stress line (see STRESS-LINE.md), not the default gate; the local 20-task suite is archived. |
| D15 | The product A/B uses **stock vs composition** on medium tasks; success = accuracy parity + token/steps win. The stress line uses stock vs composition on Terminal-Bench only to expose reliability gaps. No 1.0 gate. |
| D16 | Ecosystem designs ship as **npm template packages** plus a curated index, bound by **abstract roles + concrete implementations**. |
| D17 | Maintenance follows **DSH main**, fixing breakage continuously; every coupling sits behind an adapter. |
| D18 | Package identity stays: `dsh-graph-loop` becomes the composition bundle. The driver patch stays experimental; the Explore **mode** ships actively and is installed as the default preset for new sessions. |
| D19 | The composition layer is **tool-agnostic**: no product or craft name is built into the default role vocabulary. Any registered tool becomes routable through data (annotations, artifact contracts, template implementations, task hints, or the active preset). |
| D20 | The repo's value is a **community contribution**: a plugin the DSH ecosystem uses and extends, not a business, résumé piece or general framework. |
| D21 | Non-goals are explicit: no general agent framework, no craft/domain toolset, no fork-first path, no research project. |
| D22 | Adoption is a funnel (public evidence → external installs → external contributions → optional official listing). If the core claim fails, keep the **Graph tab** and the **composition contract** as the hedge. |

---

## 3. Scope

**In scope (0.2)**

- Per-turn capability envelope: role resolution, tool universe, prompt sections, memory policy.
- Graph composition: `step`, `tool-batch`, `subagent`, `context` executors; typed state; budgets.
- Authoritative checkpoints in `storageDomain`; replay view; Graph tab data path.
- Control plane over the stock loop, preserving stock session/event conformance.
- Template package format: manifest, role binding, validation, dry-run preview.
- **Product evaluation**: 10 easy + 10 medium Terminal-Bench tasks.
- **Stress evaluation**: Terminal-Bench smoke + fixed subset (diagnostic only).
- A public head-to-head subset report and the `docs/EVALUATION.md` protocol.
- Upstream compatibility work; an RFC/PR is optional, not a success criterion.

**Out of scope (0.2)**

- Fork-first loop replacement; per-step tool gating; concurrent writers in the parent session.
- Third-party node executors; custom node ABI.
- LangGraph interrupts / human-in-the-loop gates.
- Long-term memory and cross-session learning.
- Mid-turn crash resume; cross-process graph continuation.
- Cost as a hard gate; per-change public benchmark runs.
- A craft-first demo (doc → deck, report → deck → video) as the proof of value; craft plugins remain
  genericity fixtures.
- Renaming or unpublishing the 0.1.x packages.

---

## 4. Architecture

### 4.1 Turn lifecycle

```
user message
  → fingerprint + route            (deterministic, no model call)
  → choose capability envelope     (per turn; stable from here)
  → compile composition plan       (template | synthesis | model proposal)
  → execute nodes                  (harness-owned executors)
      step → tool batch → step ... → subagent branches → join
  → answer / terminal node
  → checkpoint at every node boundary
  → turn/end
```

Routing is deterministic and cached per turn. Low confidence falls back to a single stock step
(no graph). Every decision — envelope id, plan digest, confidence, fallback reason — is recorded in
the checkpoint and the trace.

### 4.2 Capability graph and roles

The capability graph is a **live snapshot**, never a frozen init table. Sources already covered by
`packages/core/src/registry.ts`: tools, skills, presets, agent roles, subagent providers, prompt
sections, plugins. Rebuild on `tools/change` and `system-prompt/change`.

Ecosystem templates bind to **roles**, not tool names:

```ts
interface CapabilityRoleSpec {
  readonly role: string                                  // e.g. "produces:file.text"
  readonly required?: boolean
  readonly implementations?: readonly string[]           // e.g. ["acme_render"] — optional hints
  readonly match?: { readonly tags?: readonly string[]; readonly produces?: readonly string[] }
}
```

Resolution: role → installed implementations → validated concrete tools. A template is installable
only if every required role resolves in the target profile. This is the hybrid model (D16).

#### 4.2.1 Tool-agnostic participation

The default role library names **capabilities**, never products: `workspace-read`,
`workspace-search`, `workspace-write`, `shell`, `verification`, `web`, `delegation`, `planning`,
`delivery`. There is no `craft` role and no built-in product name.

Any tool — a DSH core tool, an MCP tool, a third-party plugin, or a craft — becomes composable
through one of five data paths:

| Path | Mechanism | Who supplies it |
|---|---|---|
| Annotation | `CapabilityAnnotation` by tool name or package: `tags`, `accepts`, `produces`, `permission` | plugin author, template package, or user config |
| Artifact role | `produces:<artifact-type>` / `accepts:<artifact-type>` derived from declared artifacts | task fingerprint + registry |
| Template implementation | explicit `implementations: ["acme_render"]` in a template role | template author |
| Task hint | the user names a tool in the request; it is kept in the envelope | the user |
| Preset baseline | the active preset's tool list, kept when `includePresetTools: true` | the profile |

Unannotated tools are **not silently dropped**: they stay reachable through hints, preset baseline,
or an explicit template binding. If the router cannot cover a task with resolvable roles, it falls
back to the stock loop instead of running a graph with a missing capability. Craft plugins are one
genericity fixture, not the vocabulary of the system and not the evaluation.

```ts
// Data-only annotation for an arbitrary tool; no code change in the tool or the harness.
const annotations: CapabilityAnnotation[] = [{
  package: '@acme/widgets',
  tags: ['filesystem', 'search'],
  produces: [{ type: 'file.text', required: true }],
}]
const { tools, unmatched } = applyAnnotations(sources, annotations)
```

### 4.3 Router and triage

- **Fingerprint** (`packages/core/src/matching.ts`): intent class, mutating/read-only, artifact
  types, surface, context bucket, workspace facts.
- **Envelope**: base workspace roles, write/shell/verify for mutating work, web for research, one
  `produces:<artifact>` role per declared output, plus template roles and task hints. Tools that the
  task does not justify are left out — that is the token win; anything the router cannot cover
  falls back to stock.
- **Plan**: a template, capability-driven synthesis (`compose.ts`), or a validated model proposal
  (`graph_plan`).
- **Fallback**: below `confidenceAbsMin` / `confidenceMarginMin`, run `t_stock` (single step).
- **Cache**: routing decisions cached per `(taskHash, registryVersion, envelopeId)`.

#### 4.3.1 Capability-driven synthesis

`packages/core/src/compose.ts` replaces the 0.1.x tool-name templates; `templates.ts` and
`topology.ts` are legacy for the 0.1 driver path only. The synthesizer knows **stages**, not products:

```
discover → inspect → mutate → author → verify → deliver → answer
```

Each stage is filled by the cheapest tool in the envelope universe that satisfies data predicates:
`tag:search|discovery`, read-only `filesystem`, `tag:mutation`, `produces:<artifact>`,
`tag:verification`, `tag:delivery`. Multiple requested artifacts produce multiple `author` nodes.
When no stage matches, the plan degrades to a single generic `step` (`t_generic`) that still exposes
the whole envelope — an unannotated tool stays usable, and the task is never dropped because the
synthesizer did not recognize a product name.

### 4.4 Per-turn capability envelope

```ts
interface CapabilityEnvelope {
  readonly id: string
  readonly roles: readonly { readonly role: string; readonly nodeIds: readonly string[] }[]
  readonly tools: {
    readonly universe: readonly string[]        // concrete, resolved tool ids
    readonly deny: readonly string[]
    readonly schemaTokens: number               // measured/estimated cost of the selected schemas
    readonly unstable: readonly string[]        // conditional/dynamic tools kept on request
  }
  readonly skills: readonly string[]
  readonly promptSections: readonly string[]
  readonly memory: { readonly mode: 'conversation-only' | 'selected'; readonly maxBytes: number }
  readonly model?: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }
  readonly budget: RunEnvelope
}
```

Application inside the stock loop:

- **Tools**: a turn-scoped set consumed by tool `when` predicates. Stable for the whole turn, so the
  request prefix (tool declarations) does not change between nodes. One cache miss per turn is
  accepted; zero per step is the goal.
- **Prompt sections**: a late-ordered `composition:node` section whose text provider reads the
  current node. Node instructions never enter the message history.
- **Memory**: `systemPrompt.context` is materialized as a durable user-role snapshot, so per-node
  memory uses a **section**, not a context contribution. Context contributions are reserved for
  stable session facts.
- **Skills**: loaded through the existing skill tools; the envelope only decides availability.

Measured per turn: `toolCount`, `toolSchemaBytes`, `systemPromptBytes`, `envelopeBytes`,
`cacheReadRatio`, `billedInputUnits`. The envelope is successful only if it is smaller **and**
quality is not worse.

### 4.5 Executors (harness-owned)

| Executor | Runs in | Contract |
|---|---|---|
| `step` | parent session | One model request + its tool batch; prompts scoped by node; durable `step/start … step/end`. |
| `tool-batch` | parent session | Parallel tool calls already supported by stock `maxParallelToolCalls`; no model request. |
| `subagent` | child session | `ctx.subagents.startActivation({ provider, label, request, delivery: 'caller' })` with an object-rooted `outputSchema`; result is one injected summary. |
| `context` | parent session | Selects / summarizes / compacts what the next node sees; writes a checkpoint boundary, not a model request. |

Mapping from the existing `PlanNodeKind` union:

| Existing kind | 0.2 executor | Note |
|---|---|---|
| `agent-step`, `terminal` | `step` | A terminal node is a step with no continuation. |
| `tool-call` | `tool-batch` | Bounded by `maxParallelToolCalls`. |
| `skill-load` | `context` | Loads skill text into the next node's section. |
| `parallel` | `subagent` fan-out | Every node in a parallel superstep must be `subagent`. |
| `subgraph`, `map` | bounded composition | `maxIterations` required; no unbounded cycles. |
| `gate`, `human-interrupt` | out of scope in 0.2 | Approvals still ride the existing tool/approval path. |
| `replan` | boundary action | Compiles a new plan version at a node boundary. |

### 4.6 Graph state

Reuse the typed channels in `packages/core/src/graph-schema.ts` (`GraphState`): task hash, plan
identity/version, superstep, next node, status, facts, artifact refs (never bodies), child session
ids, bounded journal, budget, replans. JSON-only; `assertJsonSafe` before every checkpoint write;
`GRAPH_STATE_LIMITS.maxCheckpointBytes` (64 KiB) is enforced.

### 4.7 Checkpoints

```ts
interface GraphCheckpoint {
  readonly sessionId: string
  readonly turnId: string
  readonly nodeId: string
  readonly seq: number
  readonly boundary: 'node-start' | 'node-end'
  readonly state: GraphState
  readonly planDigest: string
  readonly envelopeId: string
}

interface CheckpointStore {
  put(checkpoint: GraphCheckpoint): Promise<void>
  latest(sessionId: string, turnId: string): Promise<GraphCheckpoint | undefined>
  list(sessionId: string, turnId: string): Promise<readonly GraphCheckpoint[]>
  prune(sessionId: string, keepTurns: number): Promise<void>
}
```

Implementation: `@deepseek-ai/dsh-storage-domain` with a zod-validated domain (`checkpoints` table),
keyed by `${sessionId}/${turnId}/${seq}/${nodeId}`. Writes happen only at node boundaries — after
`step/end` or after an injected join result, never mid-step. If `storageDomain` is not mounted, the
composition row **fails loudly**; there is no silent in-memory fallback.

Resume policy (D10): on restore, interrupted turns are closed exactly like stock. Checkpoints remain
readable for the Graph tab and replay. A future resume feature must add the
reopen-turn/UI/inbox work explicitly; the checkpoint contract already supports it.

### 4.8 Parallelism

- Parent session is single-writer: only `step`, `tool-batch`, `context` write there.
- A parallel superstep fans out **child sessions** (subagent nodes), bounded by budget and depth.
- Join: one injected summary message in the parent; child results are referenced, not pasted whole.
- No concurrent LLM nodes in the parent log in 0.2.

### 4.9 Control plane over the stock loop

| Need | Seam |
|---|---|
| Tool envelope | `ctx.tools.register(def, { when })` + turn-scoped state |
| Tool narrowing (soft) | `ctx.tools.restrict({ allow, deny })` on the agent scope, or `toolAllow` guard |
| Node instruction | `ctx.systemPrompt.section({ name: 'composition:node', order: <late>, text })` |
| Memory selection | a section reading the composition state, not `systemPrompt.context` |
| Node boundary | `step/end` / `tool/result` hooks + checkpoint write |
| Keep a turn moving | `agent/turn-stopping` + `inbox.nextStep` only when a node cannot continue via a tool call |
| Route/model per node | model selection seam (`agent/model-selection`) |
| Parallel branch | `ctx.subagents.startActivation({ delivery: 'caller' })` |
| Session truth | the durable session log (unchanged) |

The control plane never injects a user message for a node instruction. The one exception is a
continuation prompt at a boundary where the model produced no tool call; those bytes are counted as
`orientationBytes`. If that mechanism becomes common, it is a fork trigger (§7).

### 4.10 Observability

- **Graph tab** (existing `packages/graph-ui`): live snapshot via `graphRuntime` + SSE, plus
  checkpoint-backed turn history after reload.
- **Trace**: per-turn `{ envelope, plan, trail, rationale, confidence, fallback, checkpoints }`.
- **Replay**: rebuild the view from checkpoints; never feed graph state back to the model unless a
  node explicitly renders it.
- No plugin records; no new session event types in 0.2.

### 4.11 Ecosystem: template packages

A template package is an npm package with a manifest and YAML templates:

```json
{
  "name": "dsh-graph-template-press-kit",
  "version": "0.1.0",
  "dshGraphTemplates": { "schemaVersion": 1, "dir": "templates" }
}
```

```yaml
schemaVersion: 1
id: t_press_kit
version: 0.1.0
title: Research → deck
description: Read a source document, outline it, build a deck, export a PDF.
entry: n_read
terminals: [n_export]
nodes:
  - { id: n_read, role: workspace-read, executor: step }
  - { id: n_outline, role: drafting, executor: step }
  - { id: n_deck, role: presentation-author, implementations: [deckcraft], executor: step }
  - { id: n_export, role: presentation-export, executor: step }
edges:
  - { from: n_read, to: n_outline }
  - { from: n_outline, to: n_deck }
  - { from: n_deck, to: n_export }
envelope:
  roles: [workspace-read, drafting, presentation-author, presentation-export]
  memory: conversation-only
budget: { maxNodes: 8, maxSteps: 12 }
```

Validation on install and load: schema, role resolvability, acyclic entry/terminal reachability,
budget bounds, and a **dry-run preview** showing nodes, instructions and resolved implementations.
The curated index reviews listings before they appear. Templates never execute code.

---

## 5. v0.2 plan

| Milestone | Work | Exit signal |
|---|---|---|
| M0 | This decision record; README/PROGRESS update; freeze driver + preset | Repo states the new direction consistently |
| M1 | Envelope + role resolution + capability-driven synthesis (pure core) + tests | Deterministic envelope/plan for a representative task; unknown tools still compose |
| M2 | `CheckpointStore` over `storageDomain` + contract tests | Put/latest/list/prune; JSON guard; fail-loud when absent |
| M3 | Control plane: step nodes, prompt section, boundaries, checkpoints, annotation/preset feed | One composition turn runs ≥3 nodes over the stock loop; ordinary chat conformance holds; adapters ready for Terminal-Bench |
| M4 | **Live envelope/compose + verify repair**; Terminal-Bench easy10 + medium10 product run | Accuracy parity, token/steps win |
| M5 | Terminal-Bench product suite + product head-to-head report; 0.2.0 | Report published with config/commit/model; product claim tested |

**Definition of done (chosen):** product accuracy parity + token/steps win on medium tasks, plus a public product report; stress results are separate. The public
head-to-head report is the value proof; if it fails, the decision gate turns to the hedge (Graph tab
+ composition contract), not to a longer benchmark campaign.

**Why the craft demo was removed:** craft plugins are one author's plugins, not the benchmark. They
remain useful as genericity fixtures, but they cannot prove "better than the official experience".

**Inner loop (per change):** unit tests with the mock LLM; structural/envelope accounting; a single
real smoke turn only when the change touches the adapter. **No public benchmark per change.**

**Benchmark protocol:** see [`docs/EVALUATION.md`](EVALUATION.md). Probe first (5 tasks, three arms),
then the full subset, each recorded in `bench/results/` with command, profile, commit and model.
Thresholds are read after the run, not tuned per change.

---

## 6. What this replaces in the repo

| Artifact | Status in 0.2 |
|---|---|
| `packages/core` registry/matching/topology/proposal | **Seed** — extended with envelope, roles, checkpoints |
| `packages/graph-ui` | **Seed** — Graph tab, trace, preview |
| `packages/loop` driver (fork) | **Frozen experimental** — `driver.patch.yml`, not the default bundle |
| `packages/mode` Explore preset + reuse guard | **Active mode** — installed by default; sets `agent-preset-registry.default = explore` |
| `packages/loop/src/kernel/*` | Kept as the LangGraph/Minimal kernel reference; not the 0.2 default |
| `docs/archive/explore-mode-plan.zh.md` | Historical research; superseded by this document |
| `design/*` | Historical contracts; useful as design evidence |

Package identity stays (D18). The 0.2 `dsh-graph-loop` bundle mounts the composition rows; the
driver patch is shipped separately for manual experimental profiles. The UI package is unchanged in
name.

---

## 7. Fork triggers

Reconsider the fork only if **two or more** of these fire, measured on the product medium suite:

1. Node instructions injected as messages exceed 10% of a turn's user-role bytes.
2. More than one node kind needs an `inbox.nextStep` continuation workaround, or one causes a
   conformance failure.
3. Joins, cycles or budget enforcement cannot be expressed without abusing step semantics
   (documented cases, not hypotheticals).
4. p95 turn latency degrades by more than 30% versus stock on the same task.

If triggered: write the loop-bundle proposal first; fork only after it is accepted. Until then the
control plane is the default path.

---

## 8. Upstream

Upstream is a **compatibility strategy, not a success criterion** (D13/D20). Official adoption is
not a goal.

- **Stage 1 (0.2): composition bundle.** Plugin rows, envelope service, template spec, Graph tab.
  File an RFC/PR only if it reduces compatibility risk or the maintainers ask; otherwise stay
  out-of-tree and track main.
- **Stage 2 (later): loop bundle.** Only if §7 fires.
- Follow DSH main; keep couplings behind adapters; run the compat/conformance suite on upgrades.

---

## 9. Risks and open questions

| Risk | Mitigation / status |
|---|---|
| No 1.0 gate → drift | Product medium suite is the decision gate; stress line is diagnostic |
| Probe measures completion, not envelope/conformance | Record envelope bytes, step counts, cache ratio and conformance in the same run |
| Product/Terminal-Bench product-suite environment integration | Terminal-Bench product suite is the de-risk; stress harness issues do not block the product |
| Default-profile comparison is confounded | Three-arm design: default profile, controlled stock, composition |
| Official adoption is not a goal | Upstream work is optional; do not block on an RFC |
| Template curation has no owner | Start with an internal allowlist; open review later |
| Ecosystem chicken-and-egg | First template is a graph for one of the probe tasks |
| `when` predicates interact with other plugins | Measure envelope size and schema stability in the trace |
| `storageDomain` absent in a profile | Fail loudly; document the dependency |
| Prompt-section tail invalidation | Keep `composition:node` late in the section order; measure cache ratio |

Open questions: exact envelope role taxonomy; annotation source (workspace file vs template package
metadata vs adapter overrides); template index hosting; whether GAIA is worth a later wave; whether
`tool-batch` needs its own node kind or is folded into `step`.

---

## Appendix A — current code map

| Concern | Today | Gap for 0.2 |
|---|---|---|
| Graph schema | `packages/core/src/graph-schema.ts` (`TaskPlan`, `GraphState`, `NodeExecutor`, limits) | Add `tool-batch`/`context` executors; envelope on the plan |
| Routing | `packages/core/src/matching.ts`; `packages/loop/src/router.ts` | Envelope selection; role resolution |
| Registry | `packages/core/src/registry.ts`; `packages/loop/src/registry.ts` | Roles/implementations; snapshot digest in checkpoints |
| Driver | `packages/loop/src/loop/*` fork; `GraphLoopDriver` | Control-plane adapter over stock loop |
| Kernel | `packages/loop/src/kernel/*` (`MinimalKernel`, LangGraph adapter) | Reference only in 0.2 |
| Checkpoints | `GraphLoopConfig.checkpoint` in-turn memory | `storageDomain` `CheckpointStore` |
| UI | `packages/graph-ui` Graph tab + `/graph-chat` | Read checkpoints; render envelope/roles |
| Synthesis | `packages/core/src/compose.ts` (capability-driven) | Extend stage set; wire into router |
| Templates | `packages/core/src/templates.ts` (0.1.x legacy) | npm template package + manifest + validation |
