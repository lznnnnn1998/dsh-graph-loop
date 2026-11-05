# 复盘：今天做了什么，哪里还不如原版，什么值得留下，什么是颠覆性的

> 写于 graph loop + Graph tab 都跑通之后。目的是防止「demo 很酷但不如原版好用」，
> 并给下一步排序。所有判断都以本仓库可运行的代码和 e2e 为依据。

## 0. 今天实际交付的东西（一句话版）

- 一个不修改 DSH 源码的 graph driver（fork `agent-loop` + 每轮动态拓扑 + 边界重规划 + subagent 节点并发）。
- 一个能力图/路由/内核/trace 的运行时（registry、matching、topology、Frontier、MinimalKernel、LangGraph 适配）。
- 两个可安装 bundle：B（替换 driver）+ A（preset 模式 + agent 复用 guard）。
- 一个真正嵌进现有 Web chat 的 **Graph tab**（`conversation.view` slot，Chat | Graph | Trajectory），
  以及一个独立的 `/graph-chat` 页面（API/headless 调试用）。
- 7 条 e2e + 73 个单测，全部本机跑通；本地 git 12 个提交。

## 1. 哪些地方还不如原版（诚实清单）

| # | 不如原版的地方 | 现状 / 影响 | 是否已修 |
|---|---|---|---|
| 1 | **UI 复用走了弯路** | 先做了独立 `/graph-chat` 页面，没有复用 composer/模型选择/语音/trajectory/agent team。 | ✅ 已改成 `conversation.view` 的 Graph tab |
| 2 | **短任务多一步** | stock loop 2 步；dynamic 拓扑 4 步（entry+grep+read+answer）。 | ✅ 加了 triage（<32 字符 + 无产物 → 单节点）；中等任务仍可能多一步 |
| 3 | **子代理递归** | child agent 也跑 dynamic topology，触发深度上限、产生失败 trace。 | ✅ child 强制单节点 fallback |
| 4 | **Graph tab 只有拓扑** | 没有节点↔消息/工具联动，没有工具参数/结果正文。 | ❌ 未做 |
| 5 | **实时性** | 之前 1.2s 轮询；节点启动有延迟。 | ✅ 已改 SSE（轮询兜底） |
| 6 | **可靠性** | fork 2,122 行，没有 conformance replay-diff；没跑 DSH 全量测试；跨 loop resume 未测。 | ❌ 未做 |
| 7 | **安装/运维** | 两个包（loop + graph-ui）；graph-ui 不会随 loop 自动装；无 CI/发布流程。 | ❌ 未做 |
| 8 | **可观测细节** | trace 没有工具调用；child session 仍出现在侧栏；`graph_status` 在 agent scope 下没有 digest。 | 部分 |
| 9 | **拓扑时机** | `adoptPolicy: start-only`，模型中途 `graph_plan` 会被忽略；复杂任务可能不够灵活。 | 设计选择，待评估 |
| 10 | **LangGraph 不是默认内核** | driver 用 step-graph（控制反转），LangGraph 适配器只覆盖 `KernelPort`/`runPlan`。 | 设计选择 |

**一句话**：UI 层已经追上原版（复用现有 chat），但**运行时可靠性、可观测深度、成本证据**还不如原版成熟。

## 2. 有潜力成为以后常用的东西

1. **Graph tab**：零学习成本地看到「这一轮为什么这样走」，是唯一一个不需要改变用户习惯的功能。
2. **能力图 + 路由 trace**：解释工具选择、暴露盲区（dynamic tool、conditional tool），可独立于 graph loop 使用。
3. **边界重规划**：verify 失败 → diagnose→retry→answer，这个模式对任何 agent 都有用。
4. **subagent 节点 + 依赖并发**：长任务里真正并行，且每个 child 有独立上下文（token 账本也清楚）。
5. **agent 复用 guard / roster context**：让 Lead 先查再做，直接修「明明有人却重新 spawn」。
6. **trace + 离线 preview**：调试、教学、回归对比的通用工具。
7. **Kernel 抽象**：minimal/LangGraph 可切换，未来换内核不推翻上层。

## 3. 有潜力成为颠覆性设计的东西（如果被验证）

1. **拓扑是一等公民**：每一轮生成、冻结、可回放的运行图，而不是固定 workflow，也不是线性 loop。
2. **对话与图同屏**：Graph tab 让「信息流」成为产品界面的一部分，而不只是日志。
3. **模型画图 + harness 校验**（`graph_plan`）：把「创造力」限制在可执行、可审计的边界内；
   这可能比「让模型自由写 workflow 脚本」更可控。
4. **依赖驱动的 agent 并发**：一个 turn 内把任务拆成图节点，需要并行的子代理真并行，不需要的等待。
5. **任务绑定到已有 agent**：registry + affinity 决定 reuse/spawn，改变多 agent 的成本结构。

**但是**：这些目前是「理念领先、证据不足」。没有真实任务的 A/B，就不能说它比原版好。

## 4. 下一步排序（本次已开始 1、2 的一部分）

1. **真实 A/B**：同一批任务跑 stock vs graph（成功率、步数、billed input、p95 延迟、cacheReadRatio）。
   没有这个，后面所有优化都是自嗨。
2. **Graph tab 节点↔Trajectory/工具联动**：点节点跳到对应 tool call / 消息；节点详情带参数/结果摘要。
3. **Conformance replay-diff + 跨 loop resume**：补上 fork 的可靠性缺口。
4. **打包一体化 + CI**：`dsh plugin add` 一条命令、loop bundle 带上 graph-ui、e2e 进 CI。

## 5. 本轮已做的下一步

- SSE：`/graph-chat/api/events` 推送 live snapshot，Graph tab 优先 SSE、失败回退轮询。
- Triage：简单任务单节点，避免「graph 比 stock 还贵」。
- Child 单节点：subagent 子代理不再递归跑 dynamic topology。
- 新增 2 个单测；Graph tab e2e 仍通过（截图 `preview/graph-tab-live.png`）。
