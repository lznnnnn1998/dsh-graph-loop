# 动态拓扑：核心思想与运行时机

> 这份文档回答两个问题：① 「自由、任意、自动发现」到底指什么；② 拓扑应该在什么时候发现——
> 运行中每一步，还是每一轮对话开始时。结论先说：**按轮发现、轮内冻结、只在明确边界重规划**。

## 1. 两个层次，不要混在一起

| 层 | 是什么 | 谁拥有 | 变化频率 |
|---|---|---|---|
| **能力图（registry）** | 工具箱的「连接法则」：每个 tool/skill/agent 能吃什么产物、产出什么、权限/风险/成本、可替代关系 | harness 在运行时构建（`tools/change` 增量） | 组合变化时（秒级） |
| **运行拓扑（topology）** | 本任务实际连出来的图：节点=一步（或一个子代理），边=控制/数据流，可分支、可循环、可嵌套 | 每轮由 matcher/synthesizer 或模型提案生成 | **每轮一次** |

你的「任意拓扑」对应的是**第二层**；第一层不是「固定的图」，而是**可连接的候选空间**。
好的系统不是「取消结构」，而是「结构按任务生成」：registry 保证任意连接是**有意义的**，
topology 保证任意连接是**为这个任务服务的**。

## 2. 三种拓扑生成方式（都已实现）

| 模式 | 谁决定拓扑 | 适用 | 证据 |
|---|---|---|---|
| `template` | 预置模板库（`t_investigate` 等） | 引导、A/B 对照、确定性兜底 | `packages/core/src/templates.ts` |
| `dynamic` | harness 从 registry **合成**：按 artifact 前后置 + intent 拼 DAG，可 fan-out（research）/串行（investigate）/inspect→edit→verify（mutating） | 默认；无需模型额外调用 | `packages/core/src/topology.ts`；e2e 4 节点 |
| `propose` | **模型**通过 `graph_plan` 提交任意 node/edge；harness 校验后采用 | 「创造力」：模型发明新形状 | `packages/core/src/proposal.ts`；e2e 中模型写的 `p1→p2` 真的执行了 |

`graph_plan` 是模型可调用的工具：节点可以是工具、agent-step、terminal；边可分支/循环；可指定
每节点模型。harness 只保留约束：节点 id 唯一、工具必须在 registry 里、入口/终端存在、节点数/步数/
instruction 长度有上限、预算达标。**模型画图，harness 校验，driver 执行。**

## 3. 关键设计问题：什么时候发现拓扑？

### 结论

**每轮对话开始时发现一次，轮内冻结；轮内只允许「预先声明的条件分支/有界循环」自适应；重规划只发生在明确边界（节点失败、预算、用户 steer、下一轮）。** 默认 `adoptPolicy: 'start-only'`：
模型提交的 `graph_plan` 只在**第一个工作节点完成之前**被采用（规划阶段）；一旦开始真正干活，
拓扑就固定，迟到的提案被忽略并记录原因。

### 为什么不是「每一步都重新发现」

1. **轮是用户意图的单位**：用户消息进来时意图最清晰；越往后，工具输出越多、噪声越大，
   按步重发现会把「任务拓扑」变成「最后一条工具结果的拓扑」——抖动、漂移、重复劳动。
2. **可观测/可回放**：DSH 的硬约束是「model-visible means logged」。轮内任意改图会产生
   无法从 session log 还原的决策状态；按轮生成则天然是一个可记录的计划版本。
3. **成本**：每次重发现要么多一次模型调用（propose），要么多一次规划计算；且节点指令/工具面
   变化会让请求前缀不稳定。按轮发现只付一次。
4. **错误传播**：运行中改图容易把一次工具失败放大成全局重排；按轮 + 条件边可以在局部恢复。
5. **既有语义**：DSH 在 restore 时关闭中断的 turn，跨进程的 mid-turn 恢复本身就不存在；
   按轮发现与这个事实一致，不需要自定义事件或 checkpointer。

### 为什么也不是「session 开始时发现一次」

对话会改变任务（用户纠偏、追加约束、换文件）；session 级冻结会让图越来越过时。
**轮**是「意图」与「上下文」都刚更新的最小边界，是正确粒度。

### 轮内保留的「自由」

- 预声明的条件边：`when: artifact / noArtifact / fact / callFailed / budget`；
- 有界循环（`maxSteps` 内可回边，例如 verify 失败回到 edit）；
- 模型可在**规划阶段**用 `graph_plan` 发明拓扑；运行中它仍然可以继续用工具完成任务，
  但改图请求留到下一个边界。

一句话：**拓扑是每轮重新发明的，不是每步重新发明的；自由在「形状」和「每轮重画」，不在「每步改图」。**

## 4. 实现映射

- `FrontierTopology`（`packages/core/src/topology.ts`）：保留 frontier，而不是单游标；
  一个节点完成后可入队多个后继（fan-out），支持运行期 `addNode/removeNode/addEdge`。
  这些 API 是给未来 replan 用的，不等于默认策略。
- `createGraphTurnDriver`（`packages/loop/src/scheduler.ts`）：`mode` 选 template/dynamic/propose；
  `adoptPolicy` 控制提案采用时机（默认 start-only）。
- `graph_plan` / `graph_status`（`packages/loop/src/tools.ts`）：模型画图 + 观察。
- e2e：`scripts/e2e-headless.sh`（dynamic 4 节点）、`scripts/e2e-propose.sh`（模型写图并执行）。

## 5. 子代理 = 图里的节点，依赖决定并发

- `PlanNode.executor` 有 `step` 与 `subagent` 两种。subagent 节点**不是**父会话里多一次模型调用，
  而是一次 `ctx.subagents.startActivation`（fresh child，`delivery:'caller'`）；子会话有独立 session log。
- 同一超步里入队的多个 subagent 节点会被 `takeSubagentBatch()` 取走并 **Promise.all 并发执行**，
  结果以 `[subagent <node>] …` 注入父会话，供 join 节点使用；依赖节点等待，不依赖的并行。
- 子代理**不会无限套娃**：`delegationDepth > 0` 时 `allowSubagents:false`，子图不再生成 subagent 节点
  （否则深度上限会触发一批失败，预览里能直接看到）。
- e2e：`scripts/e2e-subagents.sh` 的 research 任务生成 `d_entry → {d_search, d_fetch}(subagent) → d_answer`，
  两个子代理并发执行，父会话 2 步。

## 6. 边界重规划（已实现）

- 触发：verify 类工具（`bash`/`pwsh`）的 `tool/result` 为 `isError`，或节点显式失败。
- 动作：如果当前图有 `callFailed` 边就走恢复边；否则安装一个 `r_diagnose → r_retry → r_answer`
  的恢复子图（`recoveryTopology`），最多 `budget.maxReplans` 次，并记录 `replan N`。
- e2e：`scripts/e2e-replan.sh` —— 第 4 步 `bash false` 失败，driver 重规划，会话里出现
  `r_diagnose`/`r_retry`，最终完成（6 步）。

## 7. Graph tab：复用现有 chat 界面的正确形态（已实现）

- **不再另开页面**：Graph 是现有会话视图的第三个 tab（`conversation.view` slot，order 5，
  位于 Chat 和 Trajectory 之间）。输入框、模型选择、语音、mode 标识、agent team/subagent 列表、
  trajectory、侧边栏全部原样复用；只新增一个 tab 的内容。
- client 半边单独成包 `dsh-graph-loop-ui`：client-modules 要求一个 client package 只有一个
  活跃 Loader entry，放在 driver 包里会和它的多条 subpath row 冲突。
- e2e 用 Puppeteer 驱动真实 UI：关闭 Preview Notice → 输入消息 → 断言
  `Chat,Trajectory,Graph` 三个 tab → 点 Graph → 截图 `preview/graph-tab-live.png`。

## 7b. 独立 graph-chat 页面（保留给 API/headless）

- 独立页面 `GET /graph-chat`（由 `graph-chat` host 插件通过 `ctx.webServer` 提供），左侧是对话，
  右侧是当前 turn 的拓扑；每 1.2s 轮询 `/graph-chat/api/state` 与 `/api/messages`，所以是**随对话动态**的。
- `POST /graph-chat/api/new` 新建会话并绑定 `standard` preset（否则工具只有 host 全局的 3 个）；
  模型路由从现有 root agent 继承，或由插件配置 `provider/model` 兜底。
- `POST /graph-chat/api/send` 走 `agent.followup()`，和普通 Web 输入同一条路径。
- 拓扑来自 `graphRuntime` 的内存 trace（`recordTurn`），所以不需要自定义 session 事件，也不需要 client plugin 构建。
- e2e：`scripts/e2e-graph-chat.sh` 启动真实 Web host + mock LLM，走 API 发消息，断言 trace 出现
  4 节点拓扑，并用 Chrome headless 截图到 `preview/graph-chat-live.png`。

## 8. 预览面板（离线）

- `graph-runtime.traceDir` 打开后，每轮写一份 trace JSON：`{mode, plan(nodes/edges), trail, rationale, depth, replans}`。
- `node scripts/preview.mjs <traceDir> preview` 生成 `preview/index.html`：每轮一个 tab，SVG 拓扑 +
  information flow + 节点详情；root 轮在前，child 轮标注 depth。
- 这是离线面板（不依赖 Web UI、不新增 client plugin）；后续可把同一 trace 接成 Web 侧栏。

## 9. 还没做到的「自由」

- 并行分支已可走 subagent 节点并发，但 tool 节点仍是父会话串行（工具批并发由 executor 决定）；
- 运行中 `addNode/removeNode` 已可用，但没有暴露成模型工具（避免每步改图）；
- 重规划目前覆盖 verify 失败；对「意外产物/预算」的触发器还没接；
- 拓扑跨轮持久化/继承还没做：每轮重新发现，长目标只保留「目标 + 产物引用」作为上下文。
