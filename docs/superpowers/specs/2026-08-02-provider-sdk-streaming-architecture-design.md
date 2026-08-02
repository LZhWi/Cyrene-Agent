# Provider SDK 流式运行时设计

## 目标

退役项目自研的 HTTP/SSE 协议基础设施，使用 OpenAI 与 Anthropic 两套官方 SDK 覆盖当前内置厂商的基础 API 接入。同时保留一套厂商无关的业务流状态机，确保 reasoning、正文、工具调用和可续传 assistant 状态在兼容厂商及自定义端点上都能被实时、完整地处理。

本设计只收口模型传输和流式状态边界，不改变 ChatLoop、WorkLoop、工具权限、模型路由、A/B/M/D Structured Output、Memory 业务或 AG-UI 对外语义。

## 核心结论

```text
退役自研 HTTP/SSE 协议基础设施
→ 复用 OpenAI SDK / Anthropic SDK 的标准协议能力
→ 由 Provider Normalizer 吸收厂商字段差异
→ 由 Cyrene Stream Accumulator 维护统一业务流状态
→ 保留 A/B/M/D、本地 Schema 校验与安全执行链
```

“SDK 覆盖”仅指网络和标准协议能力，不表示 SDK 可以统一各厂商的 reasoning 扩展、结构化输出等级、缓存策略、上下文续传或业务校验。

## 分层职责

### SDK Transport

OpenAI SDK 和 Anthropic SDK 负责：

- HTTP 请求、认证头和连接管理；
- 响应字节流与 SSE 基础解析；
- 标准协议事件反序列化；
- 标准错误对象、状态码和请求 ID；
- 接收上层传入的取消信号；
- 提供标准协议的 stream、snapshot 或 final message 能力。

SDK Transport 不负责厂商能力判断、业务重试、总预算、AG-UI 事件、工具执行或结构化结果可信度。

### Provider Normalizer

Provider Normalizer 是无状态或请求内局部状态的协议适配层，负责：

- 将 OpenAI/Anthropic SDK 事件映射为统一 `UnifiedStreamDelta`；
- 读取 `reasoning_content`、`thinking`、`reasoning` 等厂商扩展字段；
- 规范 finish reason、usage、refusal 和工具调用事件；
- 注入 reasoning、缓存、tool choice 等厂商请求参数；
- 保留未知但允许续传的厂商原始数据引用；
- 对协议矛盾产生明确的 protocol error。

Normalizer 不聚合完整会话，不执行 Repair，不决定 A/B/M/D，也不执行工具。

### Cyrene Stream Accumulator

Accumulator 每个模型请求创建一个实例，只负责统一业务流状态：

- 聚合 reasoning、正文与工具调用；
- 跟踪 AG-UI reasoning/text/tool 是否已经开始或结束；
- 维护工具调用的流式关联关系；
- 形成可续传的最终 assistant message；
- 对 SDK 终态和实时增量结果进行完整性核对；
- 检查缺失终态、冲突 ID、截断参数和非法状态转换。

Accumulator 明确不得负责：

- A/B/M/D 选择；
- Schema 解析、Repair 或业务字段验证；
- 工具权限和工具执行；
- 重试决策与模型路由；
- Prompt 拼装；
- Memory、Work 或 Chat 的业务语义。

### Structured Output Runner

Structured Output Runner 继续负责：

- A/B/M/D 能力选择；
- JSON Schema、JSON Object 和 Prompt JSON 策略；
- JSON 候选提取和本地 Schema 校验；
- Repair、预算、降级和 fail closed；
- 业务语义验证。

SDK 的结构化输出 helper 只能作为标准协议能力使用，不能替代该层。

### Work / Memory / Chat

业务层继续决定调用目的、Prompt、工具权限、执行循环和结果落库。业务层只消费统一流事件和最终 assistant 结果，不读取 SDK 私有事件结构。

## 统一流事件

Normalizer 输出的事件至少表达：

```ts
type UnifiedStreamDelta =
  | { type: "reasoning_delta"; delta: string }
  | { type: "text_delta"; delta: string }
  | { type: "tool_call_start"; index: number; id?: string; nameDelta?: string }
  | { type: "tool_call_arguments_delta"; index: number; id?: string; delta: string }
  | { type: "tool_call_end"; index: number; id?: string }
  | { type: "usage"; inputTokens?: number; outputTokens?: number }
  | { type: "finish"; reason: string }
  | { type: "refusal"; reason?: string };
```

具体 TypeScript 类型可在实施计划中进一步收紧，但必须保持事件语义与 SDK 类型解耦。

## Anthropic 双轨消费

Anthropic 流必须同时消费实时 delta 和 SDK 聚合终态：

```text
SDK 原始 delta 事件
→ Provider Normalizer
→ Accumulator 更新实时业务状态
→ 立即发送 AG-UI reasoning/text/tool 事件

SDK snapshot / finalMessage()
→ 作为终态权威结果
→ 保存 thinking block、signature、tool_use 和完整 content
→ 与实时聚合结果做完整性核对
→ 形成下一轮原样续传状态
```

不能只等待 `finalMessage()` 后再显示 reasoning 或正文。Cyrene 不重复实现 Anthropic SDK 已有的 `input_json_delta`、thinking 和 signature 字节拼接，但仍维护当前 content block、AG-UI 生命周期和统一会话状态。

当实时聚合结果与 SDK 终态不一致时：

- SDK 终态优先用于上下文续传和落库；
- 已发送给 Renderer 的 delta 不回滚；
- 记录结构化 protocol warning；
- 缺失工具 ID、工具参数不可解析或块状态矛盾时按 protocol error 处理，不执行对应工具。

## OpenAI 工具调用关联

流式聚合期间使用 `index` 作为请求内主键，服务端提供 `id` 后将其作为稳定标识：

```text
index = 流式聚合期间定位同一个 tool call
id    = 服务端提供后的稳定工具调用标识
```

`id` 不做字符串追加：

```ts
if (delta.id) {
  if (!current.id) current.id = delta.id;
  else if (current.id !== delta.id) throw protocolError;
}
```

以下字段允许增量拼接：

- `function.name`；
- `function.arguments`。

虽然标准端点通常一次返回完整 `function.name`，兼容端点可能分片，因此按 delta 保守拼接。工具调用结束前必须验证：

- `id` 已存在；
- `name` 非空；
- `arguments` 是完整 JSON；
- 同一 `index` 没有出现冲突 ID；
- finish reason 与工具调用状态一致。

任何验证失败都不得进入工具权限检查和实际执行阶段。

## 实时态与终态

实时态用于用户体验，终态用于可靠续传：

| 数据 | 实时来源 | 终态权威来源 |
| --- | --- | --- |
| reasoning/text 展示 | SDK delta 经 Normalizer | Accumulator/SDK 终态核对 |
| OpenAI 工具调用 | 标准及扩展 chunk | Cyrene Accumulator 完整结果 |
| Anthropic content blocks | SDK delta | SDK snapshot / `finalMessage()` |
| Anthropic thinking/signature | SDK delta 可实时展示 thinking | SDK 终态原始 block |
| 下一轮 assistant 上下文 | 不使用未完成实时态 | 已核验终态 |

Renderer 不成为模型状态的事实来源。

## 取消、超时与错误

SDK 负责执行传入 signal 和产生底层错误；Cyrene 继续拥有业务策略：

- 用户取消、应用退出和上层取消信号；
- 单请求超时与 Structured Output 总预算；
- cancel、timeout、HTTP、protocol、refusal 的错误分类；
- 是否允许 Repair 或业务降级；
- 工具尚未完整生成时禁止执行。

可以删除重复的 fetch/ReadableStream/TextDecoder/SSE 分帧和底层 AbortController 样板，但不能删除 Cyrene 的 signal 合并、预算计时和领域错误映射。

## 厂商策略

- OpenAI、Kimi、豆包、Qwen、GLM、DeepSeek、MiMo 默认通过 OpenAI SDK adapter。
- Claude 通过 Anthropic SDK adapter。
- MiniMax 的复杂 Agent/交错思维场景优先 Anthropic SDK adapter；保留显式 OpenAI 兼容入口。
- 同时兼容两种协议的厂商由 capability/profile 决定默认 transport，用户显式设置优先。
- 自定义端点必须显式选择 OpenAI-compatible 或 Anthropic-compatible；未知能力保持 D 档和保守行为。

transport 选择不得自动提升 Structured Output 档位。

## 依赖与复用

实施时应直接声明 `openai` 与 `@anthropic-ai/sdk` 为项目依赖，不依赖 LangChain 的传递依赖版本。两套 SDK 的自动重试策略需要关闭或收口到 Cyrene 的统一策略，避免工具相关请求被底层静默重复提交。

现有 LangChain 可继续服务已经验证的高层调用，但不作为九家厂商流式事件的唯一事实来源。Provider Normalizer 和 Accumulator 对 SDK 保持隔离，未来可以替换 transport 而不改变 Work/Memory/Chat。

## 迁移边界

迁移应采用逐厂商、双实现对照方式，不进行一次性替换：

1. 建立统一事件契约与纯 Accumulator 测试。
2. 接入原生 OpenAI 与 Claude，验证实时态和终态。
3. 逐家迁移兼容厂商，每家建立 capability fixtures。
4. 优先迁移当前存在真实流式需求的 Work 路径。
5. 验证完成后再删除对应旧 HTTP/SSE reader；未迁移厂商继续走旧路径。

每一步都必须保持 Chat/Work/Code 模式分流和工具执行语义不变。

## 测试与验收

### Accumulator 单元测试

- reasoning 与 text 多 delta 顺序聚合；
- 多个并行 tool call 按 `index` 独立聚合；
- `id` 首次赋值、重复一致和冲突报错；
- tool name 与 arguments 分片聚合；
- arguments 截断或非法 JSON 时禁止执行；
- finish、refusal、cancel 和 timeout 状态转换；
- AG-UI start/content/end 每类事件只发送一次。

### Anthropic 双轨测试

- thinking delta 立即产生 AG-UI reasoning；
- text delta 立即产生正文事件；
- `finalMessage()` 保留 thinking、signature 和 tool_use；
- 实时聚合与 SDK snapshot 一致；
- 不一致时终态优先并产生 protocol warning；
- 未完成 tool block 不执行工具。

### 厂商契约测试

每个内置厂商至少覆盖：

- 普通正文流；
- reasoning 流；
- 单工具和多工具流；
- 工具参数分片；
- finish reason；
- 取消与超时；
- 对应 A/B/M/D Structured Output 回归。

测试使用录制 fixture 或可控 mock，不访问真实远程服务。真实厂商 smoke test 单独执行，不进入默认单测。

## 非目标

- 不让 SDK tool runner 直接执行工具。
- 不合并或重写 ChatLoop、WorkLoop、runCodeRequest。
- 不改变会话 mode、会话列表或 React UI 状态。
- 不在 Accumulator 中实现 Structured Output、模型路由或 Prompt 逻辑。
- 不承诺所有 OpenAI-compatible 自定义端点都支持 reasoning、工具流或 JSON Schema。
- 不在本设计阶段修改生产代码。
