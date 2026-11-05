# DSH `explore` 模式：用 LangGraph 重写 agent loop 的可行性评估与实施路径

> 状态：评估完成（5 份源码取证 + seam / LangGraph / token 三组可运行 PoC + 1 份真实 token 基线）。
> **未验证**：还没有一个「节点 → 真实 LLM → session log」的端到端 vertical slice；P2 的第一件事就是它。
> 目标版本：DSH `0.2.1-rc.3` @ `22ddee37`。所有 DSH 结论都带 `path:line`，所有数字标注
> MEASURED / DERIVED / ESTIMATE。
>
> **一句话结论**：可以做，而且 `agent-loop` 本来就是可替换的一行插件；但「直接写一个图循环替换它」
> 会同时踩三个坑——① 模式（preset）换不了 loop，真正的替换单位是 bundle+profile；② 初始化时的
> 静态相似度图不存在，只能是运行时能力图 + 每轮一次匹配；③ 按节点动态裁剪工具/指令不会省 token，
> 按实测价格比（hit:miss = 1:50）推导要 **946–2,218 步**才回本（极端「只留 2 个工具」场景 260 步），
> 典型 session 只有 17–86 步。把这三条纠正后，路径是清晰的：**session 级能力包络 + 2~4 个
> fresh-context 子代理节点 + LangGraph 内核**。

---

## 0. 先回答你最关心的四个问题

### Q1：可以吗？

**可以，而且不需要改 DSH 源码。** 四个事实：

| 事实 | 证据 |
|---|---|
| `agent-loop` 只是 base 组合里的一行，id 为 `agent-loop` | `packages/bundle/base/cordis.patch.yml:513` |
| 替换 loop 的官方接缝是 `AgentFactory` 接口 | `packages/core/agent/src/index.ts:175-210` |
| 同一时刻只能有一个 factory；patch 的 `name` 是守卫、不是改名（所以是「禁用 + 插入」） | `agent/src/index.ts:383-385`；PoC `spikes/seam-probe/src/probe-b-patch.ts` 在真实 base 层上跑通 97→98 行、0 warning |
| 所有上层（Web/ACP/headless/SDK/subagent/webhook）都只依赖 `ctx.agents`，无人直接依赖 `ctx.agentLoop` | `research/01-seams.md` §0/§6 |

代价也要说清楚：这是一个 **2,122 源码行的 fork**（`agent-loop/src` 全部文件），不是 wrapper。
`inbox` 投影、prompt admission、turn 状态机都是包私有的，export map 只暴露根入口（实测
`ERR_PACKAGE_PATH_NOT_EXPORTED`），所以「复用它、只换调度」在技术上做不到；只能 fork 后改调度层。

### Q2：要替换/新增多少个插件？

**直接替换 2 个包（2,333 行源码），41 个包必须保持契约不变，25 个包原样复用，1 个包和 5 类工具面退役。**
影响面 69 个包（全仓库 363 个），另有 131,661 行测试钉住这些契约。明细见 §3。

### Q3：怎么变成一个新的「模式」？

DSH 现在 Web 里的 `minimal / standard / cordis / ptc` **是 preset（agent 级插件组合），不是 profile**。
preset 在 Host 的 Agent loop 之下运行，永远换不了 loop（`packages/preset/agent-preset-registry/README.md:56`
「The Host continues to share the Agent loop.」）。所以 `explore` 要分两层交付：

- **`explore` preset（今天就能用，不换 loop）**：图编排 + 精简工具面，作为 Web 里可选的一个模式。
- **`explore` profile + bundle（真正换 loop）**：新 bundle 禁用 `agent-loop` 行、插入 `graph-loop` 行；
  用户用 `dsh plugin --profile explore add ./bundle/b-loop` 建一个独立 profile。
  由于 `PROFILE_TEMPLATES` 是源码里的字面量（`packages/util/official-bundles/src/bundles.ts:10-26`），
  无法零改源码注册成 `dsh explore` 这种内置模板；安装脚本可以做到「一条命令初始化 profile」。

### Q4：图能改善「明明有合适的队友，Lead 却重新 spawn」吗？

**能，但修法不是 loop 本身，而是「agent 作为注册表一等节点 + 匹配结果绑定执行者」。**
今天 roster 只暴露 `name/description/status`，任务没有和成员做能力匹配，复用完全靠模型自觉；
图把每个 agent 变成带能力/历史/可用性的节点，让匹配器在「spawn 新手」和「唤醒老手」之间做显式打分，
默认 `prefer-fresh`，只在同一产物线/同一工作流时复用。详见 §4.11。
**今天就能做的零源码修法**：在 `tools/pre-execute` 上拦截 `spawn_teammate`（有高置信 idle 候选时
返回候选列表），再在每步注入 roster 摘要——这两件事 P1 就能落地；图运行时的自动绑定是 P3。

---

## 1. 需求 ↔ DSH 概念对照，以及三个必须纠正的假设

| 你的提案 | 在 DSH 里对应什么 | 现实约束 |
|---|---|---|
| 「agent loop 很像 LangChain，换成 LangGraph」 | 一个实现 `AgentFactory` 的 Cordis 插件；LangGraph `StateGraph` 只做**调度内核**，不做消息/记忆/持久化 | `agent-loop` 是事件溯源状态机，不是链；fork 面 2,122 行 |
| 「初始化时注册表里有一张图」 | 运行时**能力图**：`ctx.tools` + `tools/change`、`systemPrompt`、`ctx.skills`、presets、subagent providers、插件清单 | 工具是异步注册的（MCP 运行时才出现、`when` 每步求值），图必须**活构建 + 快照**，不可能冻结在 init |
| 「记录工具/插件/agent 的相似度」 | 类型化能力边（produces/requires/alternative/conflict）+ 少量可学习权重 | 描述向量余弦是弱信号，不能做路由主信号；见 §4.3 |
| 「调用时算一次匹配，选最合适的 sub-graph」 | 每轮（turn）一次任务指纹 → 模板匹配 → 实例化为可编译子图 | 匹配必须确定性、可缓存、可回放；低置信度回退默认图 |
| 「内部增减节点」 | 只在**两次运行之间**重编译子图（LangGraph 编译后不能 addNode，实测）；运行中重规划 = 重编译 + 从 checkpoint 恢复 | 需要 checkpoint 与「节点纯函数」约束 |
| 「减少 instruction 组装和 token」 | session 级能力包络 + fresh-context 子代理节点 | per-step 工具裁剪会击穿 prefix cache，推导亏损 6–55×（典型 40 步任务） |

**三个必须纠正的假设**

1. **「模式 = preset，所以 explore 可以像 minimal/standard 一样加一个 preset」** —— 对一半。
   作为**图编排能力**可以（preset 能挂图工具、图指令、精简工具面）；作为**loop 替换**不行，
   preset 作用域里没有 factory 槽。真正的替换必须是 bundle/profile。
2. **「初始化时一张静态图」** —— 做不到也没必要。正确形态是：**组合时快照 + 变更事件增量更新**；
   每个 session 第一次请求时取最新快照做匹配。MCP 工具、conditional tool、preset 切换都会改变图。
3. **「按节点裁工具省 token」** —— 与实测相反。prefix cache 命中率 95.7–98.9%，改一次工具集就
   从第一个变化的 schema token 起整段失效；按实测价格比推导，回本要 **946–2,218 步**
   （极端「只留 2 个工具」260 步），而典型 session 是 17–86 步。能省的是**会话开始时选小能力包络**、
   以及**只增不减**的工具激活。

---

## 2. 现状取证：loop 和「相关编排」到底是什么

### 2.1 一次 step 的真实时序（要被替换的东西）

```
turn/start
  claim inbox batch                    agent.ts:280
  tools.resolve({agent, modelSelection, signal})   agent.ts:285   ← 工具集在此冻结
  systemPrompt.assemble(...)                        agent.ts:287
  agent/pre-step waterfall → reject | enter{messages}  agent.ts:289  ← 只能改消息
  step/start                                        agent.ts:354
  refreshContext / 投影 system/message              agent.ts:439-454
  admit messages → user/message                     agent.ts:456-470
  request/header（initial|change|series）            agent.ts:668-684
  developer/message（tool addition/removal）         agent.ts:685-699
  request/context                                   agent.ts:710-716
  llm.stream → assistant/message | assistant/attempt agent.ts:483-576
  tools.execute({toolSet}) → tool/call, tool/result agent.ts:583-590
  step/end                                          agent.ts:381
  agent/turn-stopping（serial，可 steer 续命）       agent.ts:389
turn/end                                            agent.ts:415
```

这张表决定了两件事：

- **节点 = step 是天然映射**：一个节点就是一次模型请求 + 它的工具批。
- **工具集在 `agent/pre-step` 之前就冻结了**：`PreStepDecision` 里没有 tool 字段
  （`agent/src/runtime-types.ts:138-146`，PoC `probe-a` 用 `@ts-expect-error` 证实），
  所以「按节点换工具」只能在**下一个 step** 生效，且每次生效都有 header + cache 代价。

### 2.2 谁在消费 loop 的契约

| 依赖面 | 包数量 | 说明 |
|---|---|---|
| 依赖 `@deepseek-ai/dsh-agent`（Agent 接口/注册表/事件） | 91 | 替换 factory 后必须继续满足 |
| 依赖 `@deepseek-ai/dsh-session`（事件词汇/日志） | 145 | 事件顺序和字段不能变 |
| 引用 `agent/*` 事件 | 50 | compaction、plan-mode、hooks、goal、subagent、workflow、UI、API… |
| 直接依赖 `@deepseek-ai/dsh-agent-loop` | 4 | loop 本身、testkit、cordis 工具目录、设置卡 |

这解释了为什么「换 loop」看起来只改一行、实际回归面是整个产品：**factory 是唯一入口，事件是唯一出口**。

### 2.3 三种「模式」的真实区别

| 形态 | 作用域 | 能否换 loop | 现有例子 |
|---|---|---|---|
| agent preset | 单 session 的 agent 子树 | ❌（Host 共享 loop） | `minimal / standard / cordis / ptc` |
| bundle | profile 的配置层，可插入/覆盖任意行 | ✅（禁用 `agent-loop` + 插入新行） | `dsh-base`、`dsh-web-app` |
| profile | 进程级组合（bundle 列表 + 用户 patch） | ✅ | `web / headless / sdk / acp / sdk-minimal` |

补充两条实测事实：
- **patch 不能改行的 `name`**：`name` 是守卫，不匹配就整条 patch 跳过（`vendor/include/src/index.ts:115-118`）。
  所以只能是 `- id: agent-loop, disabled: true` + `insert: {id: graph-loop, ...}`。
- **`agent-loop` 在 required id 列表里，但「被禁用」不影响启动**（`app-boot/src/index.ts:1137-1140`：
  「Required ids absent from the tree, and disabled required entries, are ignored.」）。
  → 副作用：如果 `graph-loop` 行加载失败，应用仍会启动，只是第一次创建 agent 时才报
  「no agent factory registered」。**注意：不要承诺「启动自检」**——`AgentRegistry.requireFactory`
  是私有的（`core/agent/src/index.ts:402-406`），公共 API 查不到 factory 是否存在。正确做法是把
  检查放到**组合时**：`bundle/verify/verify.sh` / `--dump-config` 断言 `agent-loop` 已禁用且
  `graph-loop` 存在且启用，并把它作为发布门禁；运行期只在 `agent/created` 监听里打一条诊断日志。

---

## 3. 插件替换清单（核心）

统计口径：`src/**/*.ts` 行数；「包」按 `packages/<group>/<name>` 计。

### 3.1 数量总览

| 类别 | 数量 | src LOC | 说明 |
|---|---|---:|---|
| **REPLACE**（必须 fork/重写） | **2 个包** | **2,333** | `dsh-agent-loop`（2,122）+ `agent-loop-testkit`（211） |
| **KEEP-CONTRACT**（必须回归验证、不改代码） | **41 个包** | **47,545** | compaction / plan / goal / subagent / workflow / team / session / UI / API… |
| **REUSE**（完全复用、无 loop 耦合） | **25 个包** | **24,938** | agent / tools / system-prompt / session / persistence / approval… |
| **RETIRE**（explore 内退役） | **1 个包 + 5 类工具面** | **314** | `ui-settings-agent-loop`（命名空间消失后自动隐藏）+ subagent/workflow/ralph/team 的模型面工具 |
| **NEW**（新增） | **2–3 个 npm 包 / 8 个逻辑模块** | **~6,000–8,700** | 见 3.3 |
| 受影响包合计 | **69 个**（全仓库 363 的 19%） | 75,130 | 另有 **131,661 行测试**钉住这些契约 |

> 这组数字就是「大工程」的量化：**driver 只有 2.3k 行，消费它的生产代码约 72.8k 行、测试约 131.7k 行**。
> 替换本身不难，难的是让这 41 个 KEEP-CONTRACT 包一行不改地继续工作。

### 3.2 REPLACE：fork 面（2,333 行）

| 文件 | LOC | 职责 | 替换风险 |
|---|---:|---|---|
| `core/agent-loop/src/agent.ts` | 738 | turn/step 状态机、prompt 准入、工具派发、取消、失败恢复 | turn 形状、maxTokens 粘性、tool-result 补齐 |
| `core/agent-loop/src/index.ts` | 837 | factory、发布编排、声明式 agents、销毁顺序 | 会话/句柄泄漏、重复 announce、发布前事件丢失 |
| `core/agent-loop/src/inbox.ts` | 232 | 持久 inbox splice 折叠 + claim 策略 | resume 后投影不一致、steering 丢失 |
| `core/agent-loop/src/runtime-context.ts` | 169 | system prompt / runtime context 投影 | 重复或丢失 system 消息、`in-history` 失效 |
| `core/agent-loop/src/assistant-stream.ts` | 140 | 实时流帧 + settle | Web 不流式、被取消 attempt 丢记录 |
| `core/agent-loop/src/constants.ts` | 6 | 默认并发 | 可忽略 |
| `test-support/agent-loop-testkit` | 211 | 挂载 stock `AgentLoop` 的测试夹具 | 必须 fork 成 graph testkit，否则无法做契约测试 |
| **合计** | **2,333** | 其中约 1,240 行是真正私有的调度逻辑 | |

`ui-settings-agent-loop`（273 行 src，314 行含其它）**不需要 fork**：它只在 Host 提供 `agent-loop` 设置命名空间时渲染
（`whileServed(['agent-loop'])`），换成 `graph-loop` 行后卡片会**自动消失、不报错**
（`packages/client/ui-settings-agent-loop/src/client/index.ts:47`）。要暴露图配置时，另写一个
out-of-tree 的 `dsh.client` 卡片（约 350 行 + 构建脚本）。

### 3.3 NEW：新增 8 个逻辑模块（可落成 2–3 个 npm 包）

> 说明：模块划分按职责，不强制一模块一包。`bundle/` 里的可运行骨架用**单包 + subpath exports**
> （`@dsh/explore-loop/registry`、`/router`、`/runtime`、`/tools`），这样 profile 里只装一个包，
> 但每行仍是独立的 Cordis 插件、可单独禁用。下面的 LOC 是逻辑规模。

| 模块 | 职责 | 预估 LOC |
|---|---|---:|
| `explore-loop`（bundle 入口） | `dsh.bundle` 清单 + patch；`AgentFactory` 注册 | 150 + YAML |
| `graph-agent-loop` | fork 的 driver；turn/step 与图运行对接 | 1,800–2,600 |
| `graph-kernel` | LangGraph 适配层，实现 `design/kernel.ts`（compile/invoke/stream/checkpoint/interrupt） | 500–700 |
| `graph-registry` | 能力图构建 + 快照 + `tools/change` 增量更新 | 700–1,000 |
| `graph-router` | 任务指纹、模板库、匹配评分、缓存、校准 | 900–1,300 |
| `graph-runtime` | 节点执行器（step / subagent）、replan、预算、状态 | 1,200–1,800 |
| `graph-tools` | 模型面工具：`graph_status`、`graph_plan`（可选）、观测/调试 | 300–500 |
| `graph-testkit` | 契约测试、golden trace、bench 接线 | 400–600 |
| **合计** | | **~6,000–8,700 行**（约等于 3 个 stock loop） |

### 3.4 KEEP-CONTRACT：41 个包必须不改代码继续工作（47,545 行）

按契约面分组（完整 41 包 / 47,545 行清单见 `research/05-bundle.md` §7.3；`research/01-seams.md` §6.3 是 seam 级子集，25 行，两者口径不同）：

| 组 | 包 | 契约 |
|---|---|---|
| 压缩/上下文 | `compaction`、`compaction-basic`、`compaction-tool-result-pruner`、`command-compact`、`compaction-image-offload` | `agent/pre-step`、`agent/status`、`agent/request-error`、`session/event`、surface replacement |
| 计划/目标 | `plan-mode`、`goal`、`goal-round-driver` | `request/header`、`plan/mode`、`agent/created`、`agent/status` |
| 委派/编排 | `subagent`、`subagent-spawn-in-process`、`subagent-fork-in-process`、`tool-subagent`、`tool-subagent-control`、`workflow`、`workflow-ptc`、`tool-workflow`、`tool-ralph`、`agent-team`、`tool-agent-team` | `agents.create/resume`、`runMaintenance`、`agent/created`、`whenIdle` |
| 交互 | `tool-ask-user`、`user-questions`、`permission-presets`、`repeat-tool-reminder` | tool 调用即暂停/恢复；approval 事件 |
| 会话/UI/API | `session`、`session-projection`、`session-checkpoint-policy`、`session-persistence-jsonl`、`session-query`、`api/session-controller`、`client/ui-chat`、`client/ui-trajectory`、`sdk/server`、`acp` | `session/event`、`agent/assistant-stream`、`agent/status`、projection |
| 其它 | `tool-todo`、`tool-jobs`、`workspace-changes`、`hooks-claude-code`、`hooks-codex`、`session-title*`、`telemetry` | 事件/工具注册 |

**回归原则**：这些包一行都不改；新 loop 的验收标准就是它们的现有测试 + 事件黄金轨迹全部通过。

### 3.5 RETIRE：explore 内可退役的「模型面工具」

图吸收了这些能力，因此 explore preset/bundle 里可以不再挂它们的**工具行**（底层服务保留）：

| 工具面 | 被什么吸收 |
|---|---|
| `subagent`、`subagent_fork`、`list_subagent_models` | 图的 subagent 节点（`ctx.subagents.startActivation`） |
| `list_agents`、`send_message`、`interrupt_agent` | 图的多智能体边 + 控制面 |
| `workflow` | 图的 parallel / fan-out 子图 |
| `ralph` | 图的 fresh-context 循环节点 |
| Agent Teams 6 个工具 | 图的多 agent 协作（保留 `ctx.agentTeams` 服务） |

这同时是 token 收益的一部分：clean `standard` 前缀 9,150 tok → explore 7,046 tok（−23%）。

### 3.6 替换边界：哪些能复用，哪些必须 fork

| 能力 | 分类 | 依据 |
|---|---|---|
| `AgentFactory` / `Agent` / `AgentRegistry` / 事件 | PUBLIC | `agent/src/index.ts:175-210`、`runtime-types.ts:190-271` |
| 持久化写句柄、崩溃修复、SessionStore 发布 | PUBLIC | `session-persistence/src/index.ts:159,174`；`session/src/repair.ts:209` |
| `modelSelection` 投影、`turnBoundary` 投影 | PUBLIC | `agent/src/index.ts:23,298` |
| **inbox 投影 + claim 策略** | **FORK** | 只从 `inbox.ts` 导出，包根不导出，export map 封闭 |
| **prompt admission / system 节点重建** | **FORK** | `runtime-context.ts:68`；`agent.ts:446-454,665-684` |
| **runtime context 快照** | **FORK** | `runtime-context.ts:119` |
| **assistant-stream 帧与 settle** | **FORK** | `assistant-stream.ts:18` |
| **turn/step 状态机、取消、tool-call 恢复** | **FORK** | `agent.ts:45-53,261-426,356-382` |
| tools / system-prompt / session / llm / persistence | REUSE | 新 loop 只是调用方 |

---

## 4. `explore` 架构

### 4.1 总览

```
                        ┌──────────────────────────── profile: explore ───────────────────────────┐
                        │  bundle: @dsh/explore-loop                                               │
                        │   - id: agent-loop          disabled: true                               │
                        │   - id: graph-loop          name: @dsh/explore-loop                      │
                        │   - id: graph-registry/router/runtime/kernel/tools (@dsh/explore-loop/*) │
                        └──────────────────────────────────────────────────────────────────────────┘
                                                │
        user turn ──► GraphAgent (implements Agent) ──► turn/start
                                                │
                      ① match(task, registry) ──► RouteDecision {template, plan, confidence}
                                                │
                      ② compile(plan) ────────► LangGraph StateGraph (per turn)
                                                │
                 ┌──────────────────────────────┼───────────────────────────────┐
                 ▼                              ▼                               ▼
          step node (in-session)        subagent node (fresh)            gate node (ask_user)
          one model request + tools     child session + outputSchema     tool call = pause/resume
                 │                              │                               │
                 └──────────── onBoundary: step/end → step/start ───────────────┘
                                                │
                                          turn/end
```

### 4.2 能力图 registry（`@dsh/explore-loop/registry`）

**节点类型**：`tool`、`skill`、`agent`（preset/subagent provider）、`prompt-section`、`graph`（模板）、
`fact`（工作区事实，如 git/tests/语言）、`gate`（审批/人工）。

**边类型**（这是「关系」的真实内容，不是余弦相似度）：

| 边 | 语义 | 来源 |
|---|---|---|
| `produces` / `consumes` | artifact 前后置条件（`file.text`、`file.patch`、`test.result`、`doc.*`…） | 人工标注 + 从 tool output schema 派生 |
| `requires` | 权限、沙箱、审批、服务、模型能力 | 工具定义/插件 manifest |
| `alternative` | 可替代（`bash` vs `str_replace_editor`） | 人工等价类 + schema 重叠 |
| `conflict` | 互斥（PTC `run_code` vs native 工具声明） | 部署事实 |
| `same-domain` | 同域聚类 | 工具名/描述 |
| `sequence` | 历史共现（成功 session 的 bigram/trigram） | `ctx.sessionQuery` 挖掘，NPMI 收缩 |
| `gates` | 触发人工/审批 | 权限策略 |

**构建与更新**：组合时全量构建一次（`ctx.tools.definitions()`、`systemPrompt`、`skills`、presets、
`tools/change` 事件），之后增量更新；快照带 `version + digest + buildTick`，匹配缓存以
`(fingerprint, digest, weightsVersion, presetId)` 为 key。MCP 动态工具在 `tools/change` 后加入，
标注 `dynamic: true`，不参与首轮强匹配、只作候选。

### 4.3 匹配器（`@dsh/explore-loop/router`）

**为什么不是「embedding 余弦」**：工具描述向量无法区分 `bash` 和 `str_replace_editor` 在「改一行代码」
上的适用性，也无法表达「先读后写」这种前后置条件；它只能做同义改写检索。正确做法是分层：

1. **硬约束过滤**：权限、沙箱、模型能力、工具是否可用、是否 `dynamic`、preset 是否允许。
2. **任务指纹**（确定性，纯函数）：
   `intent`（code-question / code-change / bug-fix / research / document / data-analysis / …）、
   `artifactsIn/Out`、`mutating`、`parallelizable`、`risk`、`contextBucket`、`surface`、显式 `hints`、
   工作区事实（git/package.json/tests/languages）、文本长度。
3. **模板库**：每个模板是一张预编译子图（`code-investigate`、`code-edit-test`、`bug-fix-repro`、
   `research-web`、`doc-generate`、`data-analysis`、`multi-area-review`、`multi-agent-fanout`…），
   声明槽位（slot）与 artifact 前后置条件。
4. **实例化**：为每个槽位选真实工具（`produces/consumes` 必须闭合），生成 `PlanNode/PlanEdge`。
5. **打分**：
   `score = Σ wᵢ·featureᵢ + successPrior + cooccurrence − costPenalty − riskPenalty`
   其中 embedding 只作为 `alternative` 边的 tiebreaker（权重 ≤ 0.05，v1 不参与路由）。
6. **决策**：`confidence = softmax margin`；低于阈值 → 回退默认模板（`code-investigate` 或直通）；
   高于阈值 → 编译子图。
7. **缓存与回放**：纯函数；同指纹同 digest 必得同结果，可写测试。

**校准**：离线用历史 session 的「实际工具序列 vs 模板」做标注，网格/坐标上升学权重；
上线后按模板记录成功率，`setTemplateSuccessRate` 滚动更新（带阻尼）。

### 4.4 LangGraph 内核（`@dsh/explore-loop/kernel`）

选型结论：**用 `@langchain/langgraph@1.7.0`，精确锁版本，MIT，Node 26 ESM 可用**。
它只做调度，不做消息/记忆/持久化。实测（`spikes/langgraph/output.txt`）：

| 能力 | 结果 |
|---|---|
| `StateGraph` 节点/条件边/子图/递归上限 | ✅ |
| 静态并行 fan-out + join | ✅ 真并发（30/5/15ms → 32ms） |
| 动态 fan-out `Send` | ✅ 但必须是**路由返回值**，不是节点返回值；v1 不需要 |
| `MemorySaver` / 自定义 saver / `getState` / `updateState` | ✅ |
| `interrupt()` + `Command` 恢复 | ✅ |
| 流式 `values/updates/custom/debug/tasks/checkpoints` | ✅ |
| checkpoint JSON 无损 | ❌ `Date→String`、`Map→Object`，且泄漏 `__pregel_tasks` |
| 恢复时节点重跑 | ❌ 节点体会从头重跑（interrupt 前有副作用就会重复） |
| 编译后 `addNode` | ❌ 拓扑固定 |
| 单次 invoke 开销 | 0.20–0.52ms；冷启动 +130ms；`@langchain/langgraph` 单包 4.4MB，隔离安装树 **65MB / 19 包** |

**五条不可放宽的约束**（写进 kernel 接口，测试守护）：

- **C1 状态只允许 JSON**：时间用 ISO 字符串，map 用 record；adapter 在**每次写 checkpoint 时**
  强制 JSON 校验（不能像 `design/kernel.ts` 那样把 `validateJson` 设成「生产关闭」），并通过
  `sanitizeCheckpoint()` 钩子剥掉 `__pregel_*` 内部 channel；测试要覆盖 `Date`/`Map`/
  `__pregel_tasks` 三种非法载荷被拒绝或清洗。
- **C2 一个节点 = 一个 DSH step**：节点内只做一次模型请求 + 它的工具批；superstep 边界必须对应
  `step/end` + `step/start`。
- **C3 session log 是唯一历史**：checkpoint 只是运行时索引（step 计数、planId、事实引用、子会话 id），
  绝不存 `Message[]`；消息只存 `messageId` 引用。
- **C4 人工门在节点边界或工具调用**：优先 `ask_user_question`（它本身就是「阻塞的工具调用 → tool/result
  → 下一步」），不要用 `interrupt()` 包住模型调用。
- **C5 不做跨进程 mid-turn 恢复**：DSH 在 restore 时会把中断的 turn 补齐并关闭
  （`session/src/repair.ts:209`），所以图运行天然是**每轮一次**；saver 用 in-turn 内存实现即可。
  真要持久化，用 `ctx.storageDomain` 侧车表，绝不新增 session 事件类型。

### 4.5 节点执行器（`@dsh/explore-loop/runtime`）

| 执行器 | 适用 | 机制 | 成本 |
|---|---|---|---|
| **step node** | 顺序推理、需要共享同一会话历史、步骤 ≤ ~30 | 在当前 agent 里跑一个 DSH step；节点指令走动态 `systemPrompt` section；工具集保持稳定 | 历史按步累积（42.5% 的账单是 history 重读） |
| **subagent node** | 长任务、可并行、需要干净上下文、需要结构化产物 | `ctx.subagents.startActivation({ provider, label, request: { parent, prompt, signal, agentPreset?, outputSchema? }, delivery: 'caller' })`；spawn provider 是 fresh、支持 `outputSchema`/`agentPreset` | 每个节点一次 prefix + 3k 左右 orientation；**DERIVED 模型**：68 步任务拆 2–4 节点省 24–28%（校准到 4 个真实 session，未实跑） |
| **gate node** | 人工确认/审批 | `ask_user_question` 工具，或 turn 边界 + inbox 消息；**只在父 session 跑** | 无额外模型调用 |

节点契约（`design/runtime.ts`）：输入是 `LoopState` 切片 + `HandoffEnvelope`（任务摘要、已读文件引用、
产物引用），输出是 `JsonUpdate`（facts/artifacts/journal），**不返回消息正文**；子节点结果通过
`outputSchema` 强校验，超出 **16 KiB 输入 / 8 KiB 输出（bytes）** 直接失败而不是截断
（`graph-schema.ts:513-520`，沿用 ralph 的成熟做法）。

**一个必须写死的安全规则**：in-process subagent 的审批策略被钉死为 `never`
（`packages/subagent/subagent/src/child-agent.ts:243-253`），子会话里审批类操作会被拒绝。
因此 **gate / 审批节点只能在父 session 执行**；subagent preset 里不要挂 `tool-ask-user` 和需要
approval 的工具，否则 P3 会在审批类任务上直接失败。

### 4.6 状态、恢复与 fork

- **每轮一次图运行**：`turn/start` 时 match + compile，`turn/end` 丢弃运行时 checkpoint。
- **恢复**：不做 mid-turn 恢复；进程重启后 DSH 关闭未完成 turn，下一次用户输入是新的一轮、重新匹配。
  这消除了「自定义持久事件」的整类问题，也不需要 sidecar 一致性。
- **fork**：DSH fork 的是 session log；图状态不参与 fork（新分支重新匹配）。如果未来要保留，
  用 sidecar `graph_checkpoint(thread_id, checkpoint_id, state_json)`，明确它不参与 model history。
- **幂等性**：有副作用的节点（编辑/命令/提交）必须声明 `idempotent:false`，重规划时只允许
  「检查后重试」或「换等价工具」，不允许盲目重放。

### 4.7 动态增减节点

- **运行前**：匹配得到 `TaskPlan`，`compile()` 成一次拓扑——这是「选子图」的唯一时刻（实测
  LangGraph 编译后不能 `addNode`）。
- **运行中**：只在预定义 replan 边界（工具失败、校验失败、预算、用户 steer、置信度跌破阈值）
  触发；动作限于：插入补救节点、替换等价槽位、跳过可选节点、终止。`maxReplans` 默认 2。
- **跨轮**：可以把「重编译后 resume 同一 checkpoint」作为实验特性（实测可行，前提是 channel 名不变），
  但 v1 不依赖。

### 4.8 模型分级与预算

- `agent.model.select()` 在 step 准备前生效，因此节点可以换模型：路由/校验用便宜模型，
  执行/长上下文用强模型。
- 预算：`maxNodes`、`maxSteps`、`maxTokens`、`maxWallMs`、`maxChildren`；超限走 `PauseReason:'budget'`，
  生成一份「已完成/未完成/建议下一步」的交接，而不是硬失败。
- 工具预算：同一 session 内**只增不减**（见 §4.9）。

### 4.9 Token 策略（这一节是整份方案的经济学核心）

实测基线（`research/04-tokens.md`，真实 session + 真实计费字段）：

| 指标 | 数值 |
|---|---|
| 你的 live web profile | 160 tools / 120,108 B schema / 30,031 tok；system prompt 20,237 字符 / 5,064 tok |
| 固定前缀 | **35,095 tok，每个 step 重发** |
| cache 命中率 | 95.7–98.9%（4 个 session，17–86 步） |
| 69 步 session 的账单构成 | prefix 13% / history 重读 42.5% / 新内容 44.5% |
| 其中 craft 家族占比 | system prompt 62.4%，tool schema 71.7% |

**四条规则**：

1. **不做 per-step 工具裁剪。** 改一次工具集 = 从第一个变化的 schema token 起 prefix 失效。
   回本步数 `T* = (1−ρ)(P+H)/(ΔS·ρ)`，取决于省下的 schema 量 `ΔS`、当时的 prefix+history `P+H`
   和实测价格比 `ρ = 0.02`（hit:miss = 1:50）。三组真实假设（**DERIVED**：输入是实测的，
   输出是算术）：

   | 场景 | ΔS | P+H | 回本步数 |
   |---|---:|---:|---:|
   | S1 `standard` → lean explore（去掉 delegation/team/workflow） | 2,545 | 49,150 | **946** |
   | S2 live profile 去掉 delegation/team/workflow | 3,354 | 151,848 | **2,218** |
   | S3 极端：只留 2 个工具 | 28,600 | 151,848 | **260** |

   三组都**远高于典型 session 的 17–86 步**；按 40 步任务算亏损 6–24×（S3–S2），
   S1 是 24×。早期设计稿里的「~120 步」用了 `ρ=0.1`（比实测乐观 5×）且只算了 P 不含 H，
   是**乐观上界**，不是保守值。所以默认策略是 `gatePolicy: cold`——只在 session 开始、compact 后、
   fork、切模型这些「prefix 本来就要重建」的时刻裁剪。
2. **在 session 开始时选能力包络**（一次匹配，一个稳定 prefix）。clean `standard` 9,150 tok →
   explore 7,046 tok（−23%，**ESTIMATE**，由逐工具实测字节求和得出，explore preset 尚未实跑）；
   如果按任务把 14 个 craft 家族也裁掉，craft 单独贡献约 10.4k tok（35,095 − 24,673），
   再叠加 lean preset 才到 ~7k（−80%）。这是**当前部署里最大的单笔 token 收益**，
   而它只需要「匹配 + 选 preset/注册集」，不需要图循环。
3. **只增不减**：`deepseek-flash` 声明 `toolUpdate: 'addition-only'`、`systemPromptUpdate: 'in-history'`
   （`packages/llm/llm-deepseek/src/models.ts:10-18`）。加工具/改 prompt 是 append、保留 prefix；
   删工具才失效。图在运行中发现需要新工具时，允许**增加**，禁止移除。
4. **长任务用 2–4 个 subagent 节点**，不要更多。**DERIVED 模型**（校准到 4 个真实 session，
   未实跑）：68 步任务 2 节点 −24.2%，4 节点 −28.5%，8 节点 −16.0%；盈亏平衡在 34–53 步。
   节点 orientation 成本必须 < 3k tok，否则越拆越贵。

> 结论：**图循环的正当性是「能力 + 长任务成本」，不是「instruction 组装」**。
> 省钱故事只对 100+ 步任务成立；短任务上图是纯开销。

### 4.10 可观测性

- **v1 只做 live-only 视图**：从 `step/*` + `tool/*` + 进程内 `graph/step` 事件折叠出
  「当前轮次/模板/节点序列/子会话 id」。**不要**注册依赖图事件的 session projection——
  projection 只能折叠已提交的 session 事件，而图事件不落盘，重载后必然为空。
- 如果将来要在重载后仍能看到节点序列，再考虑两种方案之一：把节点 id 写进一个已有的
  model-visible 事件（有 token 代价），或用 `ctx.storageDomain` 侧车 + 客户端拉取；v1 不做。
- 调试工具：`graph_status` 默认 **host/plugin-only**（不进模型 tool set）；需要模型自诊断时，
  用配置 `debugTool: true` 单独打开。`graph_plan` 只在 dry-run/调试模式暴露。
- Web 客户端 v1 只显示「第几步 / 子会话链接」，节点可视化放 P3。

### 4.11 Agent 复用：图怎么修掉「明明有人却重新 spawn」

你观察到的现象是真的，而且在这套架构里有明确的结构性原因和修法。

**根因（不是模型笨，是接口没给出可决策的信息）**

- `spawn_teammate` 的入参只有 `name / description / prompt / context`；`list_agents` 返回
  `status / description / provider / model`（`packages/experimental/tool-agent-team/src/index.ts:52-65,192-219`）。
  **没有能力标签、没有历史任务、没有「这个任务和谁的相似度」**。
- 任务与成员之间没有绑定：`team_task_create` 产生的是无主任务，谁来做由 Lead 在对话里决定
  （`packages/experimental/agent-team/src/types.ts:71-84`）。
- 复用虽然被支持（`send_message` 会唤醒 inactive 成员并开一轮，`packages/experimental/tool-agent-team/src/index.ts:221-228`），
  但「先查 roster 再决定复用」完全依赖模型自觉；而 spawn 是单步动作、状态干净，模型自然偏向它。
- 成员的完成状态也不在成员快照里（`inactive` 只表示没有 turn 在跑，不表示任务完成）。
  → 模型没有可靠的「谁做过什么、做得怎么样」的记忆。

**图的修法（这是注册表图最直接的收益之一）**

1. `agent` 成为 registry 的一等节点：`id / name / description / preset / tools / skills /
   contextMode(fresh|fork) / status / history{completedTasks, successRate, avgCost, lastArtifacts}`。
2. 匹配的输出从「选模板」扩展为「选模板 + 给每个节点**绑执行者**」：槽位可以绑
   `fresh(preset)` 或 `reuse(agentId)`。这是和工具槽位同构的机制，但**当前 `Binding` 只有
   `{slot, tool}`**（`design/matching.ts`），P1 要新增 `AgentFacts`、`AgentBinding`、
   `RouteWeights.executorAffinity`，并新增 registry source（`ctx.agentTeams` roster +
   `agent/created`/`agent/disposed`）。
3. 绑定打分：`affinity(task, agent) + reuseBonus − contaminationRisk − coldStartCost − serializationPenalty`；
   默认 `prefer-fresh`，只在「同一工作流 / 同一产物线 / 需要延续上下文」时启用 reuse
   （配置项 `reusePolicy: prefer-fresh | prefer-reuse | same-lineage`）。
4. **执行池只有一个**：idle agent 只存在于 Agent Teams roster（`ctx.agentTeams`）；
   `ctx.subagents.startActivation` 的 spawn/fork **永远是 fresh child，没有 idle 池**。
   所以 reuse 只能绑 team 成员，且只对 `status === 'inactive'` 生效；`ctx.agents` 是注册表，
   不是消息 API。执行前必须**再查一次状态**（防止 match 后被别人占用），处理
   `provisioning`/`failed`，并明确「running 的目标会被 steer 进当前 turn」而不是排队。
5. 节点完成后回写能力记录（产物类型、涉及文件、结果摘要），供同一 run 的后续节点和跨 run 匹配使用；
   `sessionQuery` 可以挖「任务→代理」的历史共现，作为 affinity 的先验。注意冷启动：新成员没有
   history，第一轮复用决策只有 `name/description`——这正是我们在工具路由里判定为弱信号的东西。
   所以 v1 规则应是「同一 team / 同一产物线才允许 reuse」，**不要**承诺学习型 affinity。
6. **最关键的一点：必须有一个强制点，否则模型照样 spawn。** `suggest_executor(task)` 只是建议，
   同一个模型可以选择忽略。零源码的强制做法是在 `tools/pre-execute` / `ctx.tools.guard` 上拦截
   `spawn_teammate`：当存在高置信 idle 候选时，返回 deny + 候选列表（或要求 `force: true`）；
   同时在 `systemPrompt.context` 每步注入 roster 摘要，让模型「看得见」谁空闲。
   这两件事在 P1 就能做，不依赖 graph loop。

**边界与预期**

- 这不是「换 loop」的副产品：**P1（preset + router）就能先落地**——拦截 `spawn_teammate` 的
  `tools.guard` + 每步 roster 注入 + `suggest_executor` 排序，就能减少重复 spawn；
  P3 才把它变成图运行时的自动绑定。
- 度量：`spawnsPerTask`、`reuseRate`、`duplicateOrientationTokens`、`timeToFirstToken`、成功率；
  这些指标**目前不在 `bench/schema/results.schema.json`**，P1 要先把它们加进 schema，并补一个
  「两个任务共享同一产物线」的 fixture，否则「重复 spawn 率下降 ≥30%」没有基线。
- 反例要承认：如果被复用的 agent 上下文已经很长或已过时，reuse 可能比 fresh 更贵、更错。
  所以默认 `prefer-fresh`，reuse 必须由「同一产物线 / 明确延续」触发，并且可一键关掉。
- **范围诚实**：你观察到的 Lead 跑在 stock `web` profile 里，不是 explore profile；
  今天的即时修法是「guard + roster 可见性」，图循环的自动绑定是 P3。§4.11 不是「已经可用的功能」。

---

### 4.12 核心接口（设计文件里已可编译）

`design/` 下的 6 个文件都是 `tsc --strict` 通过的；实现时直接以它们为契约。

```ts
// 1) 唯一入口：替换 stock loop 的 AgentFactory（PUBLIC，packages/core/agent/src/index.ts:175-210）
interface AgentFactory {
  createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle>
  resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle>
}

// 2) 图内核（design/kernel.ts）：LangGraph 与 MinimalKernel 都实现它
interface GraphBuilder<S> {
  addNode(id: NodeId, run: NodeFn<S>, policy?: NodePolicy): this
  addEdge(from: NodeId | START, to: NodeId | END): this
  addConditionalEdge(from: NodeId, router: EdgeRouter<S>, ends?: readonly NodeId[]): this
  addFanOut(from: NodeId, router: FanOutRouter<S>, target: NodeId): this  // LangGraph Send[]
  compile<C extends CompiledGraph<S>>(options?: CompileOptions<S>): C
}
interface KernelPort {
  compile(plan: TaskPlan, state: GraphState): KernelRunHandle
  resume(plan: TaskPlan, state: GraphState): KernelRunHandle
  readonly checkpointer: { load(sessionId: string, atSeq: number): Promise<GraphState | undefined>
                           put(sessionId: string, atSeq: number, state: GraphState): Promise<void> }
}
type KernelResult =
  | { kind: 'boundary'; nodeId: string; boundary: NodeBoundaryRef; state: GraphState }
  | { kind: 'paused'; reason: 'user-input' | 'human-gate' | 'replan' | 'budget' | 'error'; state: GraphState }
  | { kind: 'done'; state: GraphState; terminal: string }
  | { kind: 'failed'; state: GraphState; error: NodeFailure }

// 3) 节点执行器（design/runtime.ts）
interface NodeExecutorPort {
  execute(ctx: NodeExecutionContext): Promise<NodeOutcome>   // step | subagent | gate
}
interface DshPort {           // 把 DSH 服务收成一个可 mock 的端口
  model: AgentPort; tools: ToolsPort; systemPrompt: SystemPromptPort
  subagents: SubagentsPort; session: SessionPort; projections: ProjectionPort
  tokenMeter: TokenMeterPort; checkpoint: CheckpointCachePort
}

// 4) 匹配（design/matching.ts）
interface RouteDecision {
  templateId: string
  plan: TaskPlan                 // 编译成图的那份
  bindings: Binding[]            // 每个槽位绑定到哪个 tool/agent
  confidence: number
  fallback: boolean
}
```

**step 执行器必须遵守的固定顺序**（`design/runtime.ts#STEP_PIPELINE_ORDER`，与 stock loop 一致）：

```
node.policy → tools.resolve → systemPrompt.assemble → agent/pre-step → step/start
→ llm.prepareCall → system/message → user/message → request/header → request/context
→ deriveMessages.freeze → llm.stream → tools.pre-execute → tools.execute
→ tools.post-execute → tool/result → step/end
```

这串顺序就是「为什么 41 个包能一行不改」：compaction、plan-mode、goal、hooks、token-meter 全都挂在这些
名字上。任何一步换序都是 conformance bug，不是风格问题。

## 5. 打包：`explore` 的三种形态

### 5.1 形态 A：`explore` preset（先落地，不换 loop）

- **装进你现在的 `web` profile 即可**，不需要新建 profile：bundle A 插入一行
  `@deepseek-ai/dsh-agent-preset`（`id: preset-explore`、`name: Explore (graph)`、`order: 5`），
  Web 的新建会话 chip 里就多出第五个模式；stock loop 不变，sessions/workspace/settings 天然共享。
- 实测（`bundle/verify/verify.sh`，throwaway home）：`web` 模板 195 行 → 装 A 后 **199 行** →
  `plugin remove` 后 **逐字节回到 195 行**；`preset-explore` 行存在，`agent-loop` 仍启用。
- preset 的 `plugins` 里只能**消费** Host 服务，不能提供全局服务（activation audit 会拒绝 leak）。
  所以 graph-registry/router/runtime 必须是 Host 行，preset 只挂 policy/tools。
- 图编排用现有接缝实现：条件工具 `when`（只在节点边界变化）+ 动态 section +
  `agent/pre-step`/`agent/turn-stopping` + subagent 节点。**不换 driver。**
- 价值：先验证「匹配 + 能力包络 + agent 复用」是否真的提升质量/省 token；数据决定要不要走形态 B。

### 5.2 形态 B：`explore` bundle + profile（真正换 loop）

`bundle/` 里已有可运行的骨架（`a-preset` / `b-loop` / `dev` / `verify`）。要点：

- **一个包、多个 subpath 插件**：`@dsh/explore-loop` 通过 exports 暴露
  `./registry`、`./router`、`./runtime`、`./tools`，profile 里只装一个包，但每行可单独禁用。
- **两个 bundle 必须分开装**：`explore-mode`（preset，保留 stock loop）与
  `explore-loop`（替换 driver）都会插入 `graph-registry/router/runtime` 行；装在同一 profile 会
  id 冲突。前者用于 P1，后者用于 P2+。实测 A 装进 web 后 199 行，B 装进独立 profile 后 200 行。
- **禁用而不是改名**：patch 的 `name` 是守卫，所以是 `- id: agent-loop, disabled: true` +
  `insert: {id: graph-loop}`。`disabled` 的 required id 不影响启动（`app-boot/src/index.ts:1137-1140`）。
- **默认 `mode: observe`**：新装 profile 不会立刻改变行为；规范枚举是
  `off → observe → shadow → active`，默认 `observe`。**注意**：`design/runtime.ts` 目前写的是
  `off | observe | stock | explore` 且默认 `explore`——实现前必须改成规范枚举并加测试
  `DEFAULT_GRAPH_CONFIG.mode === 'observe'`，否则新装即 active，与安全承诺矛盾。
- **`listedByDefault: false`**：不在插件市场默认列出；需要显式安装。
- **`engines.dsh`**：`^0.2.1-rc.3`，宿主版本不匹配时 bundle 被跳过并在 `skippedBundles` 里报告。
- **开发期 overlay**：`bundle/dev/overlay.patch.yml` 用绝对路径插件名，配合
  `dsh --profile web --patch ... --dump-config`，零安装即可验证组合。

```yaml
# bundle/b-loop/cordis.patch.yml（节选，已用真实 applyEntryPatches 验证）
- id: agent-loop
  name: '@deepseek-ai/dsh-agent-loop'   # guard
  disabled: true

- insert:
    - id: graph-registry
      name: '@dsh/explore-loop/registry'
      config: { document: !!js dshHomePath('graph/explore.graph.yaml'), snapshotTtlMs: 5000 }
    - id: graph-router
      name: '@dsh/explore-loop/router'
      config: { confidenceThreshold: 0.55, fallbackOnLowConfidence: true }
    - id: graph-runtime
      name: '@dsh/explore-loop/runtime'
      config: { mode: observe, nodeExecutor: subagent, maxReplans: 2, budget: { maxNodes: 12, maxSteps: 40 } }
    - id: graph-loop
      name: '@dsh/explore-loop'
      config:
        maxParallelToolCalls: 10   # 注意：行 id 变了，stock 设置卡不会读它（namespace = 行 id）
        agents: []
        mode: observe
    - id: graph-tools
      name: '@dsh/explore-loop/tools'
```

### 5.3 安装流程（一条脚本，零源码改动）

```sh
# 1) 从 web 模板创建一个独立 profile（不会碰 shipped profile）
dsh --profile explore --from-default-profile web

# 2) 安装 bundle（本地 checkout 或 pnpm pack 的 tarball）
dsh plugin --profile explore add ./bundle/b-loop

# 3) 验证组合：应看到 agent-loop disabled + graph-loop inserted
dsh --profile explore --dump-config | grep -A3 -E 'agent-loop|graph-loop'

# 4) 启动
dsh --profile explore
```

`bundle/verify/verify.sh` 已经实现「建 profile → 装 A → dump → 卸 A → 装 B → dump → 断言行」的
全流程（不启动进程，只跑组合）。

- **会话不隔离**：session 根目录是 `dshHomePath('sessions')`（`bundle/base/cordis.patch.yml:141`），
  与 web profile 共享。因此 explore 能打开旧 session；旧历史按事件回放，新 turn 用图循环。
- **一个必须知道的坑**：session 会记录它跑过的 preset id。在 `preset-explore` 下创建的 session，
  如果换到一个没有 bundle A 的 profile，resume 会报 `agent-preset/not-found`
  （`packages/preset/agent-preset-registry/src/index.ts:252`）。所以 **A 要装在 session 所在的地方**
  （建议就是 `web` profile），不要只装在 explore profile。
- **B 的 session 是 profile-locked**：图 loop 创建的 session 只有在事件契约测试通过后才能被 stock loop
  resume；在契约测试通过前，把它当作单向门，不承诺跨 profile 恢复。
- **设置卡**：`ui-settings-agent-loop` 依赖 `agent-loop` 命名空间；换成 `graph-loop` 行后卡片自动隐藏
  （`packages/client/ui-settings-agent-loop/src/client/index.ts:47`），不会报错。若要暴露图配置，
  另写 out-of-tree 的 `dsh.client` 卡片（约 350 行）。
- **`tool-cordis` 的服务目录**：Creator 模式的 API 目录会列出 `ctx.agentLoop`
  （`packages/extensions/tool-cordis/src/api-catalog.ts:136`）。新 driver 最好保留一个同名服务
  `agentLoop`（同样的 `create/createAgent/resume`），否则目录会「说谎」。
- **升级**：bundle 用 `engines.dsh` 拒绝不兼容宿主；`dsh plugin update` 走 pnpm；回滚 = 切换到
  `--profile web` 或删 profile。
- **必须接受的限制**：无法注册成 shipped profile template（改动
  `official-bundles/src/bundles.ts:10-26` 才能让 `dsh explore` 免参数启动）。安装脚本可以封装成
  `npx dsh-explore init`。

### 5.4 不修改源码的合规清单

| 动作 | 是否改源码 | 说明 |
|---|---|---|
| fork `agent-loop` 到新包 | ❌（新代码在你自己仓库） | MIT，需保留版权头；不是修改 DSH |
| 禁用 `agent-loop` 行、插入新行 | ❌ | bundle patch |
| 新增 preset | ❌ | bundle patch 插入 `dsh-agent-preset` 行 |
| 新增 profile | ❌ | `--from-default-profile` + `dsh plugin add` |
| 新增 session 事件类型 | ✅ 需要 | **不做**；改用 storageDomain 侧车或每轮重算 |
| 注册 shipped profile template | ✅ 需要 | **不做**；用安装脚本替代 |
| 改 `agent-loop` 源码 | ✅ 需要 | **不做**；fork 到新包 |

---

## 6. 分阶段实施路径

总工期估算：**12–16 周**（1 名资深工程师 + 0.5 名测试/评测；不含 LangGraph 学习曲线）。
每个阶段都有独立可交付物和 kill gate，前一阶段不过不进入下一阶段。

### P0 — 能力图 + 观测（1.5 周）

| 项 | 内容 |
|---|---|
| 交付 | `@dsh/explore-loop/registry`：从 `ctx.tools`/`systemPrompt`/`skills`/presets 构图；快照/增量；`graph_status` 只读工具 |
| 文件 | `registry/{collector,snapshot,digest,events}.ts`、`tools/status.ts` |
| 测试 | 单测：注册/注销/`tools/change` 后 digest 变化；MCP 动态工具；preset 切换 |
| 验收 | 覆盖率 ≥95% 的已注册工具；快照重建 <50ms；**零行为变化**（`mode: observe`） |
| Gate | 图不完整或重建 >200ms → 停止，先修 registry |

### P1 — 匹配器 + `explore` preset（2 周）

| 项 | 内容 |
|---|---|
| 交付 | router（指纹/模板/评分/缓存/校准）；`explore` preset（精简工具面 + 图工具）；**agent 复用三件套**（`spawn_teammate` 的 `tools/pre-execute` 拦截 + 每步 roster context + `suggest_executor(task)` 排序）；A/B 基线跑通 |
| 文件 | `router/{fingerprint,templates,match,calibrate,executor-match}.ts`、`bundle/a-preset/cordis.patch.yml` |
| 测试 | 40 条任务的 top-1 模板标注集；确定性测试（同输入同输出）；低置信度回退；复用排序的离线标注 |
| 验收 | top-1 ≥80%，回退率 <20%；preset 前缀 ≤ standard −20%；无准确率回退；重复 spawn 率下降 ≥30% |
| Gate | K1：billed input 降幅 <15% 且 prompt token 降幅 <25% → 「匹配省 instruction」前提作废，只保留 preset 能力 |

### P2 — graph-agent-loop 骨架（4 周）

| 项 | 内容 |
|---|---|
| 交付 | fork 2,122 行 → `@dsh/explore-loop`（driver）；LangGraph 内核适配（`/kernel`）；`step node` 执行器；P2 只发 4 个模板（`t_stock`/investigate/edit-test/research；完整库见 §4.3） |
| 文件 | `agent-loop/{factory,turn,inbox,prompt,stream}.ts`、`kernel/langgraph.ts`、`runtime/{state,step-node}.ts` |
| 测试 | 先做 vertical slice（createAgent → 一轮 → 一步 → step/end → turn/end，mock LLM，断言 C01/C02/C04/C07），再跑 fork 的 stock 测试套件（15,108 行）；补 3 条守护测试：`DEFAULT_GRAPH_CONFIG.mode === 'observe'`、LangGraph 单副本断言（`isCommand(new Command({}))`）、`inbox`+`modelSelection` 投影重注册后的 resume/fork 一致性 |
| 验收 | Web/headless/ACP/SDK 四种 profile 都能建 agent、跑通一轮、resume；`ui-chat`/`session-query`/`compaction` 回归全绿；组合门禁（`verify.sh`）断言 stock 行禁用 + graph 行启用 |
| Gate | 事件顺序/字段任一不匹配 → 停止；成功率和 p95 延迟不得劣于 baseline −5pp/+30% |

### P3 — subagent 节点 + replan（3–4 周）

| 项 | 内容 |
|---|---|
| 交付 | `subagent node`（spawn + outputSchema + handoff envelope）；replan 引擎；预算；模型分级；并行 fan-out |
| 文件 | `runtime/{subagent-node,replan,budget,handoff}.ts` |
| 测试 | 2/4/8 节点拆分对比；失败注入（工具失败/超时/子代理失败）；幂等性 |
| 验收 | 68 步任务 billed input −20% 以上、成功率不低于 baseline；100+ 步任务 −40% 以上 |
| Gate | K4：100+ 步任务打不过 baseline → 只发 preset，不发 loop |

### P4 — 并行与多智能体（3 周，可选）

| 项 | 内容 |
|---|---|
| 交付 | 并行子图（固定 fan-out + join）、多 agent 协作边、图可视化客户端、模板市场（可选） |
| 验收 | 并行分支的审批/取消/计费正确；子会话目录可导航 |

**里程碑关系**：P0 是所有阶段的地基；P1 可以独立发布（preset-only）；P2 是「真替换」的分水岭；
P3 决定图循环是否在成本上站得住；P4 是能力扩展。

---

## 7. 测试与兼容性

### 7.1 契约一致性（最高优先级）

`design/conformance.ts` 已经把契约拆成 **16 条必须逐字节保持的义务（C01–C16）** 和 **8 条有意差异（D01–D08）**，
测试就按这张表逐条建：

- **必须保持**：事件顺序/封装（C01）、`request/header` 快照与继承（C02）、路由变化时的 `request/context`（C03）、
  system prompt 准入（C04）、工具 schema 投影与顺序（C05）、tool result/error 渲染（C06）、
  工具变化时的 `developer/message`（C07）、inbox/注入语义（C08）、取消与未派发调用结果（C09）、
  失败 step 恢复（C10）、每 step 的持久模型选择（C11）、`agent/pre-step`（C12）、compaction 括号（C13）、
  持久化写句柄与 interrupted-turn closers（C14）、`agent/turn-stopping`（C15）、实时 UI 事件（C16）。
- **有意差异**：图驱动的 step 选择（D01）、按节点选模型（D02）、节点指令的注入方式（D03）等——
  每一条都要在测试里显式断言「差异存在且符合预期」，防止把 bug 当特性。
- **事件黄金轨迹**：用 stock loop 跑固定脚本（llm-replay / mock wire server），录 `turn/start … turn/end`
  的完整序列；graph loop 在同一脚本下必须通过「允许差异」校验。
- **宿主测试套件**：fork 后保留 `agent-loop/tests/*` 全部 15,108 行，不改断言。
- **投影测试**：`inbox`、`modelSelection`、`turnBoundary`、token-meter 的 `contextBreakdown` 在 resume、
  fork、compaction 后一致。
- **发布/销毁**：泄漏检测（session 不退场、句柄不关、scope 不释放）。

### 7.2 回归矩阵

| 面 | 用例 |
|---|---|
| Web UI | 流式输出、工具卡、轨迹、停止按钮、会话切换 |
| 持久化 | 冷启动 resume、坏尾部修复、fork、跨 profile 打开 |
| 压缩 | 自动压缩、`/compact`、tool-result prune、image offload |
| 审批 | `ask_user_question`、permission preset、plan mode |
| 委派 | subagent/workflow/ralph/agent-team 在 explore profile 下仍可用（即使工具面退役，服务仍在） |
| 模型 | DeepSeek / PI / replay；`toolUpdate`/`systemPromptUpdate` 能力差异 |
| 平台 | macOS/Linux（Windows 的 pwsh 路径至少单测） |

### 7.3 A/B 实验协议（预注册）

| 臂 | 组合 |
|---|---|
| `baseline` | stock loop + `standard` |
| `explore-preset` | stock loop + lean preset |
| `graph-control` | graph loop，单 session step 节点 |
| `graph-node` | graph loop，subagent 节点 |

- 数据集：`bench/tasks/tasks.jsonl`（8 任务，覆盖单工具/多工具改码/研究/文档/修 bug/长重构/多 agent/无工具）。
- 每格 ≥3 次重复，报中位数（token 分布重尾，W3 vs W4 差 13×）。
- 指标：`tools`、`toolSchemaBytes/Tokens`、`systemTokens`、`steps`、`toolCalls`、`promptTokens`、
  `cacheReadTokens`、`missTokens`、`cacheReadRatio`、**`billedInputUnits`**、`billedCostUsd`、
  `sessionCount`、`wallTimeMs`、`success`。
- 编码在 `bench/scripts/aggregate.mjs`；看结果后改阈值 = 作弊。

---

## 8. 指标、阈值与 kill criteria

### 8.1 基线（MEASURED；账单/均值是 DERIVED）

| 指标 | baseline |
|---|---|
| 固定前缀 | 35,095 tok（live web） / 9,150 tok（clean standard） / 5,457 tok（headless） |
| cache 命中率 | 0.985（4 session 中位；W2 为 0.984） |
| 69 步 session 账单 | billed input 371,331 units ≈ $0.094 |
| 每步平均 prompt | 151,848 tok（W2，DERIVED = 10,477,530 / 69） |

### 8.2 关键公式

- 单次工具集变更回本步数：`T* = 49 × (P + H) / ΔS`（hit:miss = 1:50，`P` prefix，`H` 历史，`ΔS` 省下的 schema）。
- 拆分收益：`saving ≈ H·(1 − 1/K) − K·orientation − parentDispatch`；`K` 建议 2–4。

### 8.3 验收阈值（全部满足才接受）

1. 每完成任务 billed input 中位数 ≤ baseline −15%；
2. prompt token 中位数 ≤ baseline −25%；
3. cacheReadRatio 下降 ≤20 个百分点；
4. 成功率 ≥ baseline −5pp；
5. 每完成任务 wall time ≤ baseline +30%。

### 8.4 kill criteria

| 编号 | 条件 | 动作 |
|---|---|---|
| K1 | `explore` preset 两项 token 阈值都不达标 | 「匹配省 instruction」前提作废，删掉这条叙事 |
| K2 | 任一臂 cacheReadRatio <0.78 且 billed input 上升 | 放弃动态工具 gating，只保留 session 级包络 |
| K3 | 图模式每任务多 >40 步或多 >15% 输出 token | 放弃该拆法 |
| K4 | `graph-node` 在 100+ 步任务上打不过 baseline | 只发 preset，不发 loop |
| K5 | fork 后事件契约测试失败且无法在 2 周内修好 | 退回 P1，loop 替换延期 |
| K6 | LangGraph 上游破坏 pinned 接口（连续 2 个 minor）或安装 >100MB | 切 `MinimalKernel`（~400 行，接口不变） |

---

## 9. 风险登记册

| # | 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|---|
| R1 | fork 漂移：DSH 升级后 fork 与上游行为分叉 | 高 | 高 | 只 fork 2,122 行调度层；每版本跑上游全量测试；把 diff 控制在 30% 内 |
| R2 | 事件契约破坏，UI/压缩/审批静默出错 | 中 | 极高 | 黄金轨迹 + 宿主测试套件 + 发布前 4 profile 冒烟 |
| R3 | 图匹配错误导致准确率下降 | 中高 | 高 | 置信度阈值 + 默认回退 + 只在高置信度启用；先 shadow 后 active |
| R4 | KV cache 被图打穿，成本反升 | 中 | 高 | §4.9 四条规则；cacheReadRatio 作为一等指标 |
| R5 | 子代理节点信息传递不足，节点重复劳动 | 中高 | 中 | handoff envelope + 文件引用而非正文；orientation 预算 3k |
| R6 | LangGraph 供应链/体积（65MB、langsmith、js-tiktoken） | 中 | 中 | 锁版本；ESM 单副本断言；禁用 tracing；保留 MinimalKernel 退路 |
| R7 | 需要新 session 事件类型时才发现的持久化需求 | 中 | 中 | v1 明确「每轮一次」，不跨进程恢复；必要时 storageDomain 侧车 |
| R8 | profile 切换后旧会话/设置不可见 | 低 | 中 | sessions 根共享；设置卡自动隐藏；文档说明 |
| R9 | 团队维护成本（8 个逻辑模块 / 2–3 个 npm 包） | 高 | 中 | 先只发 preset；loop 替换按 gate 推进 |
| R10 | 并行分支的计费/取消/审批语义 | 中 | 中 | v1 固定 fan-out；每个分支独立 session，审批走父 inbox |

---

## 10. 开放问题（需要你拍板）

1. **`explore` 的首发形态**：先发 preset（1 个月内可用，不换 loop），还是直接冲 bundle+profile？
   建议前者，数据决定后者。
2. **图节点粒度**：step 节点（共享历史、便宜、上下文会胀）vs subagent 节点（干净、贵、要传状态）。
   建议默认 step，长任务自动升级为 2–4 个 subagent 节点。
3. **是否接受「fork 2,122 行」的长期维护成本**：这是整个方案最大的固定成本，绕不开。
4. **会话/产品语义**：explore profile 与 web profile 共用 sessions 根，但 UI 是否要区分「这个会话是图跑的」？
5. **是否允许 storageDomain 侧车**：如果未来要跨重启恢复图状态，这是唯一不碰 session 格式的路。
6. **craft 工具面**：你当前部署 62% 的 system prompt / 72% 的 schema 是 14 个 craft 家族。
   是否接受「explore 默认不挂 craft，按任务动态加载」？这是最大的单笔 token 收益。
7. **Agent 复用策略**：默认 `prefer-fresh` 还是 `prefer-reuse`？复用能省重复 orientation，
   但会带来上下文污染和串行化；建议默认 fresh，只对同一产物线开放 reuse，并加开关。
8. **复用边界**：只复用同一 team 内的成员，还是也允许冷恢复历史 session（`resume`）？
   后者能跨 run 复用，但上下文更可能过时。

---

## 附录 A：证据索引

| 结论 | 证据 |
|---|---|
| loop 是可替换行 | `packages/bundle/base/cordis.patch.yml:513` |
| factory 接口 / 唯一性 | `packages/core/agent/src/index.ts:175-210, 383-385` |
| preset 不换 loop | `packages/preset/agent-preset-registry/README.md:56` |
| patch `name` 是守卫 | `vendor/include/src/index.ts:115-118`；PoC `spikes/seam-probe/src/probe-b-patch.ts` |
| 工具集在 pre-step 前冻结 | `packages/core/agent-loop/src/agent.ts:285,289`；`agent/src/runtime-types.ts:138-146` |
| required id 被禁用不影响启动 | `packages/boot/app-boot/src/index.ts:1137-1140` |
| 中断 turn 在 restore 时关闭 | `packages/core/session/src/repair.ts:209` |
| 只允许 ignorable 插件记录 | `packages/session/session-format-v3-to-v4/src/validation.ts:59-63` |
| sessions 根共享 | `packages/bundle/base/cordis.patch.yml:141` |
| profile 模板是字面量 | `packages/util/official-bundles/src/bundles.ts:10-26` |
| spawn 支持 preset + outputSchema + fresh | `packages/subagent/subagent/src/types.ts:123-183`；`subagent-spawn-in-process/src/index.ts:39-49` |
| ralph 已证明「插件级自定义 loop」 | `packages/experimental/tool-ralph/README.md` |
| LangGraph 实测 | `spikes/langgraph/output.txt`、`research/03-langgraph.md` |
| token 基线/盈亏平衡 | `research/04-tokens.md`、`bench/results/measured-web-sessions.jsonl` |

## 附录 B：交付物清单

```
research/00-context.md          共享背景
research/01-seams.md            seam 取证 + 替换清单（437 行，111 引用）
research/02-graph.md            图模型/匹配/重规划设计
research/03-langgraph.md        LangGraph 选型与集成设计（439 行）
research/04-tokens.md           token/缓存基线与 A/B（385 行）
research/05-bundle.md           bundle/preset/profile 打包
design/graph-schema.ts          图 DSL + 状态 + 校验（46KB）
design/matching.ts              指纹/模板/评分/校准
design/replan.ts                重规划
design/runtime.ts               driver 契约/节点执行器/DSH ports
design/kernel.ts                LangGraph 适配接口
design/example-graph.yaml       用真实工具名写的示例图
spikes/seam-probe/              33 项断言的 seam PoC
spikes/langgraph/               LangGraph 15 节 spike + 诊断
bench/                          token A/B harness + 实测基线
bundle/                         explore bundle 骨架
docs/explore-mode-plan.zh.md    本文件
```
