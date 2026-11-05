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

## 5. 还没做到的「自由」

- 并行分支目前是**拓扑上的 fan-out**，执行仍是单 agent 串行（真并行需要 subagent 节点）；
- 运行中 `addNode/removeNode` 已可用，但没有暴露成模型工具（避免每步改图）；
- 拓扑跨轮持久化/继承还没做：每轮重新发现，长目标只保留「目标 + 产物引用」作为上下文。
