# 每轮拓扑是怎么选的？能保证最优吗？

短答：**不能保证最优**。当前是「启发式候选 + 规则合成 + 可选的模型提案」，不是对图空间的搜索或
优化。它保证的是：**有界、可解释、可审计、可回放**，不是最优。

## 一轮的决策链

1. **Fingerprint**（`core/matching.ts`）
   - 从用户文本抽取 intent、是否修改文件、输入/输出产物、可见工具数量、上下文 token、workspace 指纹。
   - 不调用模型。
2. **Template match**（`template` 模式）
   - 用固定权重对 6 个模板（`t_investigate`、`t_edit_test`、`t_bugfix`、`t_research`、`t_doc`、`t_stock`）打分，
     取最高分；低分回退 stock 单节点。
   - 这是「查表 + 打分」，不是最优性证明。
3. **Dynamic synthesis**（`dynamic` 模式，默认）
   - 从能力图里按固定骨架拼：`entry → discovery(grep/glob) → inspection(read/lsp) → [web] → [mutation] → answer`。
   - 工具可用性决定节点是否出现（例如没有 `grep` 就跳过 discovery）；`maxSteps` 截断。
   - 这是**覆盖式启发**：尽量覆盖「定位、读取、修改、回答」，不比较多种拓扑。
4. **Model-authored plan**（`propose` 模式）
   - 模型可调用 `graph_plan` 提交图；`proposal.ts` 做结构校验（节点、边、工具、预算、可达性），
     通过后只在**第一个工作节点之前**采用（`adoptPolicy: 'start-only'`）。
   - 模型不提交时仍回退到 dynamic/template。
5. **Boundary replan**
   - 仅当验证类工具（bash/pwsh）失败时触发 recovery 拓扑（diagnose→retry→answer），有重规划上限。
   - 这是异常恢复，不是全局重新优化。

## 为什么不能叫「最优」

- **候选集很小**：dynamic 只有一个骨架；template 只有 6 个模板；没有枚举 alternative graphs。
- **没有目标函数**：没有把成功率、步数、token、延迟、风险合成一个可比较的分数；`match` 的权重是拍的。
- **没有反馈学习**：trace 只用于展示/预览，不回灌给匹配或合成。
- **KV-cache / 延迟没有进入决策**：节点指令会改变历史尾部，但选择时没算这个成本。
- **模型提案受时机限制**：只在开工前采纳；中途发现图不合适只能靠失败重规划。
- **没有离线评测闭环**：真实 A/B 还没跑（当前只有结构 A/B）。

## 如果要往「更优」走，需要什么

1. **候选生成 + 打分**：为同一任务生成 2–4 个候选（直接答、investigate、edit-test、research），
   用「预计步数 × 单价 + 失败风险 + 延迟」打分，记录每个候选的分数进 trace。
2. **真实反馈**：A/B 与线上 trace 统计（成功率、步数、billed input、重规划率）反哺权重/模板。
3. **模型提案常态化**：允许在边界（第一次工具失败、预算过半）重新提交图，而不只是开头。
4. **成本模型进 loop**：把 token/KV-cache 增量作为拓扑选择的显式项，而不是事后解释。
5. **可证伪的验收**：固定任务集 + rubric + 真实路由，证明「动态图 > 单节点/模板」再默认开启。

在那之前，正确的说法是：**dynamic 是一个有界、可解释的默认策略；propose 把「最优」交给模型但加了
校验和时机限制；两者都不保证最优。**
