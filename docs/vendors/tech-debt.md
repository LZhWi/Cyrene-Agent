# 技术债：Action Gate 多厂商适配

记录已知技术债及其解除条件。每项在解除条件满足后应移除或更新。

## 1. Native FC Profile 化

**现状**：`tool-choice-policy.ts` 仍有硬编码 provider 分支（deepseek/minimax/kimi），Action Gate 走新的 Profile 系统，但 Native FC（真实工具执行）仍用旧逻辑。

**解除条件**：Action Gate 多厂商实机验收稳定后，复用 `action-gate-profiles.ts` 的能力 Profile 重构 `tool-choice-policy.ts`，统一两条路径的 tool_choice 策略。

**风险**：不重构不影响运行，但维护两套策略逻辑容易不一致。

## 2. Legacy runtime 同步或移除

**现状**：`two-phase-fc-loop.ts`（legacy runtime）没有 routeAfterTool / forced_respond / capability Profile 等修复。默认走 langgraph，只有显式传 `agentRuntime: "legacy"` 才走老路。

**解除条件**：确认无外部依赖后删除 legacy runtime；否则补齐同等的 Action Gate 策略和 routeAfterTool。

**风险**：如果有人显式传 `agentRuntime: "legacy"`，会遇到已修复的 bug（无限循环等）。

## 3. strict / structured output

**现状**：`ToolSpec` 不支持 `strict: true`，adapter 不发送 `response_format` / `json_schema`。`plain_json_text` 策略只是 Prompt 要求输出 JSON，不是 API 级保证。

**解除条件**：`ToolSpec` 和 Adapter 支持 `strict`、`response_format`/`json_schema`，并完成各 transport（OpenAI/Anthropic）测试。之后 `plain_json_text` 可升级为真正的 `json_object` 或 `json_schema` 策略。

**风险**：不支持 strict 的厂商仍需靠本地校验 + 协议修复兜底。

## 4. Volcengine / MiMo 契约测试

**现状**：Volcengine 和 MiMo 的 Profile 标记为 `contract_test_required`，能力基于文档推断，未经实测。

**解除条件**：完成以下实测：
- reasoning on/off 两种状态
- ToolCall 返回是否稳定
- arguments 是否合法 JSON
- tool_choice wire 值是否被接受

实测后更新 `action-gate-profiles.ts` 中对应 Profile。

**风险**：Profile 与实际行为不一致可能导致 Action Gate 选错策略。

## 防误用措施

已实现的诊断日志：

### 启动日志（cyrene-agent.ts）
```
[CyreneAgent] agentRuntime=langgraph provider=deepseek model=deepseek-v4-pro
```
用于确认走了正确 runtime。

### Profile 日志（langgraph-agent-loop.ts）
```
[AgentGraph/Trace] node=action-gate provider=deepseek transport=openai model=deepseek-v4-pro effectiveReasoning=off strategy=named_decision_tool
```
用于确认 Profile 匹配和策略选择正确。

出现厂商适配问题时，先看这两条日志判断：
1. 是否走了错误 runtime（agentRuntime=legacy）
2. 是否匹配了错误 Profile（provider/transport/model 不对）
3. 是否选了错误策略（strategy 与厂商实际能力不符）
4. Provider 实际行为是否与能力表不一致（需要对比日志和 `docs/vendors/tool-calling-matrix.md`）
