# OpenAI Responses API 协议接入施工文档

> 目标：协议层从「OpenAI / Anthropic 二选一」扩展为三协议——新增 **OpenAI Responses API**。
> 协议严格跟随档案（用户选什么走什么），厂商矩阵只决定新建档案时的预填默认值，不做硬拦截。
> 前置已完成：openai SDK 已升级至 7.5.0（commit 39105a1），`client.responses.create` 可用。

---

## 现状与问题

### 现状

- 协议链路已打通：档案 `explicitTransport` → `resolveTransport`（只认显式选择）→ `getAdapterForConfig`（按协议选 adapter）→ 运行时生效。
- `Transport` 类型只有 `"openai" | "anthropic"` 两种，UI 下拉也只有两项。
- adapter 层抽象良好：`ChatVendorAdapter` 统一接口 + `UnifiedStreamDelta` 统一流事件，协议差异全部封闭在 adapter 内部。

### 问题

| # | 问题 | 根因 |
|---|------|------|
| 1 | 豆包/DeepSeek/MiMo/ChatGPT/MiniMax/Qwen 的 Responses API 入口无法使用 | Transport 类型二选一，无第三个 adapter |
| 2 | ChatGPT 厂商默认仍是 chat completions | 官方主推 Responses（o 系列完整思考摘要仅此协议有） |
| 3 | 电话通话（call-manager）不认档案协议 | 用旧路径 `getAdapter(provider)`，且配置 getter 不带 `explicitTransport` 字段 |
| 4 | 厂商支持哪些协议没有结构化落库 | capabilities 表只有单一 `transport` 默认值字段 |

---

## 设计

### 三协议路由模型

```
档案 explicitTransport: "openai" | "anthropic" | "responses"
        ↓ resolveTransport()          ← 只认显式值；缺失回退厂商默认
getAdapterForConfig()
  ├─ "openai"     → OpenAICompatAdapter   （现有，零改动）
  ├─ "anthropic"  → AnthropicAdapter      （现有，零改动）
  └─ "responses"  → ResponsesAdapter      ★ 新增
```

- `"responses"` 是纯新增值：已有档案不可能存有该值，**零迁移、零回归**。
- 现有两个 adapter 一行不改。

### 厂商支持矩阵（用户已确认）

capabilities 表每条加 `supportedTransports` 数组字段（缺省 `[transport]`）：

| 厂商 | supportedTransports | 默认（新建档案预填） |
|---|---|---|
| MiniMax（稀宇科技） | anthropic / openai / responses | anthropic |
| DeepSeek（深度求索） | openai / anthropic / responses | openai |
| 豆包（火山方舟） | openai / anthropic / responses | openai |
| GLM（智谱） | openai / anthropic | openai |
| Kimi（月之暗面） | openai | openai |
| Qwen（通义千问） | openai / responses | openai |
| ChatGPT（OpenAI） | responses / openai | **responses**（默认切换） |
| Claude（Anthropic） | anthropic | anthropic |
| MiMo（小米） | openai / anthropic / responses | openai |

**用途仅两个**：新建档案时预填默认协议 + transportHint 提示文案。**不做硬拦截**——官方没有的鉴权地址用户不会自己编，三个选项全量放开，用户填什么走什么。

### 三协议 URL 规则（同一 Base URL，后缀不同）

| 协议 | 追加后缀 | 示例（baseUrl → 实际请求地址） |
|---|---|---|
| openai | `/chat/completions` | `https://api.deepseek.com` → `.../chat/completions` |
| anthropic | `/v1/messages` | `https://api.deepseek.com/anthropic` → `.../anthropic/v1/messages` |
| responses | `/responses` | `https://api.deepseek.com` → `.../responses` |

- 已以 `/responses` 结尾的 URL 原样使用，不再追加（与现有两协议的「完整地址直填」规则一致）。
- 三协议共享同一 Base URL，预设表**不需要**新增任何 URL 字段。

### Wire 格式差异对照（ResponsesAdapter 的全部工作量）

| 维度 | Chat Completions | Responses API |
|---|---|---|
| system 消息 | `messages[0].role:"system"` | `instructions`（顶层字段）+ `input[]` |
| 用户/助手文本 | `messages[].content` | `input[]` items（用户侧 `input_text`；assistant 退化构造也用 `input_text` 或纯 string —— SDK 类型：`EasyInputMessage.content` 只接受 `input_text/input_image/input_file`，`output_text` 是输出侧 `ResponseOutputMessage` 的 content 类型，不能用于输入构造） |
| 图片 | `image_url` block | `input_image` block |
| 工具定义 | `tools[].function.{name,description,parameters}`（嵌套） | `tools[].{name,description,parameters}`（**扁平**） |
| 工具调用 | `tool_calls[]` + `role:"tool"` 回填 | `function_call` item + `function_call_output` item |
| tool_choice 命名 | `{type:"function", function:{name}}` | `{type:"function", name}`（**少一层嵌套**） |
| 思考输出 | `reasoning_content`（非标准） | `reasoning` item + `summary`（官方标准） |
| token 上限 | `max_tokens` | `max_output_tokens` |
| usage 字段 | `prompt_tokens` / `completion_tokens` | `input_tokens` / `output_tokens` |
| 流式事件 | `choices[].delta` | `response.output_text.delta` 等 ~10 种事件 |
| 服务端状态 | 无状态 | 默认有状态（**必须显式 `store:false`**） |

### 关键决策

1. **`store: false` 恒定发送**——无状态调用，不留服务端会话，多轮回放全靠客户端重放 items（与现有两协议行为一致）。
2. **reasoning item 完整回放（不丢弃）**——`store:false` 下 OpenAI 官方支持加密推理回放：请求带 `include: ["reasoning.encrypted_content"]`，`ResponseReasoningItem.encrypted_content` 会在响应里返回，下一轮原样重放即可（SDK 7.5 `ResponseIncludable` 注释明确此用途）。**仅对 OpenAI 官方端点启用**（判定见决策 7）；第三方兼容端（DeepSeek/豆包/MiMo/MiniMax 等）不发送 include 字段，响应中自然无 encrypted_content，回放时跳过无 encrypted_content 的 reasoning item。
3. **完整 output items 是多轮保真的核心（rawAssistant 机制）**——非流式与流式路径**都必须**把最终完整 `response.output[]`（按原始顺序）存入 `assistantMessage.rawAssistant`，下一轮优先回放。流式路径的 canonical source 是终态事件里的 `event.response.output`——**`response.completed` 和 `response.incomplete` 两者都捕获**（SDK 类型已核实：两个事件的 `.response` 都是完整 `Response`；incomplete 常见于 max_output_tokens 截断，此时 output 里已有 reasoning/message/部分工具链，不应丢弃退化）。`UnifiedStreamDelta` 只负责 UI 实时展示，不承担 Responses 原生状态的保真重建——现有 accumulator 产出的 `assistantMessage` 不含 `rawAssistant`，responses 流式分支在 finalize 后需显式补挂该字段。
4. **rawAssistant 回放必须经 `toResponseInputItems()` 清洗**——SDK 7.5.0 自带该 helper（`openai/lib/responses/ResponseInputItems`，**不在包根导出，必须深度导入**），职责就是把存储的 output items 规范成可安全回放的 input items（保留顺序、剥离 `created_by`、过滤不可回放的 item 类型）。回放流程：

```
rawAssistant（完整 output items）
    ↓ Responses replay policy（回放策略）
    ├─ 官方 OpenAI 端点：reasoning item 带 encrypted_content → 保留
    └─ 第三方端点：reasoning item 无 encrypted_content → 丢弃
    ↓ toResponseInputItems()（SDK helper，深度导入）
    ↓
input[]（按原顺序追加）
```

5. **structuredOutput 映射**：`json_schema` → `text.format`（以 SDK 7.5 类型定义为准）；`json_object` / `prompt_json` 映射到对应 format 或仅发 hint。CITA/Action Gate 走 Responses 时的行为不变劣。
6. **频率惩罚不支持**——Responses API 无 `frequency_penalty`，跳过该字段（其余 temperature/top_p 透传）。
7. **encrypted_reasoning 的启用判定是端点级，不是厂商级**——ChatGPT 档案的 baseUrl 用户可自由改（可填第三方中转），capability 标记 `responsesEncryptedReasoning: true` 不能证明当前端点是官方。判定条件：

```ts
capability.responsesEncryptedReasoning === true
  && new URL(baseUrl).hostname === "api.openai.com"   // 官方域名白名单
```

非官方域名（中转站）一律不发 include，回放策略自动落入第三方分支。

---

## 数据层与路由（Commit 1）

### Transport 类型扩展

- `src/main/orchestrator/vendors/types.ts`：`Transport` 加 `"responses"`。
- `src/shared/api-endpoint.ts`：`ApiTransport` 同步加 `"responses"`（主进程与设置页共用）。

### URL 规则

`resolveApiEndpoint(baseUrl, transport)` 加 responses 分支：

```ts
if (transport === "responses") {
  if (trimmed.endsWith("/responses")) return { url: trimmed, appendedSuffix: null };
  return { url: `${trimmed}/responses`, appendedSuffix: "/responses" };
}
```

### 能力矩阵

`capabilities.ts` 每条记录加 `supportedTransports?: ReadonlyArray<Transport>`（缺省 `[transport]`）；ChatGPT 条目加 `responsesEncryptedReasoning: true`，`transport` 默认值改为 `"responses"`。注意：该标记只是必要条件，运行时还要叠加官方域名判定（关键决策 7）才发送 include。

### 工厂路由

`vendors/index.ts` 的 `getAdapterForConfig` 加 responses 分支 → `new ResponsesAdapter(cap.id, cap)`；cache key 已是 `${provider}::${transport}` 天然兼容。

`transport-detector.ts` 的 `resolveTransport` 加 `"responses"` 显式值判断。

`model-settings.ts` 的 `migrateLegacyExplicitTransport`：显式 `"responses"` 值直接透传（旧档案不会有，仅防 normalize 吞值）。

### call-manager 旁路修复（独立 Commit 2）

这是一个已存在的 bug（电话通话按厂商默认协议走、不认档案协议），与 ResponsesAdapter 本体无关，独立成 commit 便于 bisect/回滚。

- `startup/bootstrap-config.ts`：`setCallSettings` 的模型 getter 补 `explicitTransport: s.explicitTransport` 字段。
- `call/call-manager.ts:330`：`getAdapter(ms.provider)` → `getAdapterForConfig(ms)`；`buildVendorUrlByProvider(...)` → `buildVendorUrl(ms.baseUrl, adapter.transport)`。
- 修复后电话通话跟随全局配置的协议（含新协议），不再按厂商默认走。
- 必须在 Commit 4（ChatGPT 默认切 responses）之前合入，否则默认一切电话就断协议。

---

## ResponsesAdapter 非流式（Commit 1）

新建 `src/main/orchestrator/vendors/responses-adapter.ts`（~500 行），实现 `ChatVendorAdapter` 全接口：

### buildRequest 消息映射

| 统一 ChatMessage | Responses wire |
|---|---|
| `role:"system"`（多条） | 合并 join 后写入顶层 `instructions` |
| `role:"user"` 文本 | `{ role:"user", content:[{type:"input_text",text}] }` |
| `role:"user"` 图片 block | `{ type:"input_image", image_url }` |
| `role:"assistant"` content（退化构造） | `{ role:"assistant", content:[{type:"input_text",text}] }` 或纯 string——**不用 `output_text`**（那是 `ResponseOutputMessage` 输出侧类型，`EasyInputMessage` 输入侧只认 `input_text`） |
| `assistant.toolCalls` | 每个调用一个 `{ type:"function_call", call_id, name, arguments }` item |
| `role:"tool"` | `{ type:"function_call_output", call_id, output }` |
| `rawAssistant` | **存在则优先回放**：先过 replay policy（第三方端点丢弃无 encrypted_content 的 reasoning item，见决策 4），再经 SDK helper `toResponseInputItems()` 清洗后按原序追加；无 rawAssistant 才走上面的退化构造 |

- body 基础字段：`model` / `input` / `stream` / `store:false` / `max_output_tokens` / `temperature` / `top_p`；当端点判定通过（决策 7：capability 标记 + 官方域名）时追加 `include: ["reasoning.encrypted_content"]`，其余一律不发。
- tools 扁平格式 + tool_choice 三态映射（named/required/auto/none/omit）。
- 推理控制：`resolveReasoningCapability` + `applyReasoningPreference` 按 Responses 语义接（effort 映射），首版至少保证「auto 不发字段」不回归。

### parseResponse

解析 `response.output[]`：`message`（output_text content）→ text；`refusal` content → refusal；`reasoning`（summary 拼接）→ thinking；`function_call` → toolCalls；`status`/`incomplete_details` → finishReason；`usage.{input_tokens,output_tokens,input_tokens_details.cached_tokens}` → 统一 usage。**完整 output items 数组存入 `rawAssistant` 供多轮回放**（含 reasoning item 的 encrypted_content——当且仅当请求带了 include）。

### appendToolResults / testConnection

- tool 结果消息转 `function_call_output` items 追加。
- testConnection 复用 openai-adapter 的最简请求模式（文本 hi + 超时计时）。

---

## SDK 流式（Commit 3）

### runtime 分支

`sdk-stream/runtime.ts` 加第三个分支。**SDK 调法（已核实 7.5.0 重载签名）**：`stream` 是 body 字段不是第二个参数——

```ts
const stream = await client.responses.create({ ...body, stream: true });
// 第二个参数位置是 RequestOptions，{ stream: true } 写那里类型直接报错
```

迭代事件对象 → `normalizeResponsesEvent(event)` → 现有 `dispatch` / `accumulator` / think-filter 全链路复用。finish 时对未闭合 tool call 补 `tool_call_end`（对齐 openai 分支的兜底逻辑）。

**rawAssistant 补挂（P0 修复）**：流式路径捕获**两个终态事件**的 `event.response` 作为 `finalResponse`：

```ts
if (event.type === "response.completed" || event.type === "response.incomplete") {
  finalResponse = event.response; // 两者都带完整 Response（SDK 类型已核实）
}
```

`accumulator.finalize(finalResponse)` 之后，把完整 output 显式补挂到结果上：

```ts
const final = accumulator.finalize(finalResponse);
return {
  ...final,
  assistantMessage: { ...final.assistantMessage, rawAssistant: finalResponse.output },
};
```

现有 accumulator 的 `finalize` 不产出 `rawAssistant`（Anthropic 分支靠 `reconcileAnthropicTerminal` 单独处理），responses 分支用上面最简方式补挂，不改 accumulator 公共结构。降级链路区分两种情况：

- **收到终态事件（completed 或 incomplete）** → rawAssistant 有值。incomplete（如 max_output_tokens 截断）时 output 里已有 reasoning/message/部分工具链，保真保存。
- **真正传输中断（SSE 断流，无终态事件）** → finalResponse 为空 → rawAssistant 缺失 → 下轮退化构造，行为安全降级。

### responses-normalizer（新建）

事件映射全清单（未列出的未知事件静默跳过，对齐 openai-normalizer 防御式写法）：

| Responses 事件 | UnifiedStreamDelta |
|---|---|
| `response.output_text.delta` | `text_delta` |
| `response.refusal.delta` / `response.refusal.done` | `refusal` |
| `response.reasoning_summary_text.delta` | `reasoning_delta` |
| `response.output_item.added`（type=function_call） | `tool_call_start`（含 call_id/name） |
| `response.function_call_arguments.delta` | `tool_call_arguments_delta` |
| `response.function_call_arguments.done` | `tool_call_end` |
| `response.output_item.done`（type=function_call） | `tool_call_end` 兜底（对齐 SDK 注释：done 阶段 item 才完整） |
| `response.completed` | `usage`（input_tokens/output_tokens/cached）+ `finish`；**事件本身由 runtime 捕获存 finalResponse** |
| `response.incomplete` | `finish`（reason=incomplete）；**事件同样由 runtime 捕获存 finalResponse**（与 completed 同等地位，见 rawAssistant 补挂小节） |
| `response.failed` | `error`（走 StreamChunk.error 通路） |
| `error`（独立 ResponseErrorEvent，与 response.failed 不同类型） | `error` |

### client-config

新增 `deriveResponsesClientConfig(endpoint, apiKey)`：要求 endpoint 以 `/responses` 结尾，剥掉后缀得 baseURL（与 `deriveOpenAIClientConfig` 同模式；SDK 内部固定向 `{baseURL}/responses` 发请求）。

---

## 设置页 UI（Commit 4）

- `settings/index.html`：协议下拉加第三项 `<option value="responses">OpenAI Responses</option>`。
- `settings.ts`：
  - `updateEndpointPreview` 加 responses 分支（默认后缀 `/responses`）。
  - transportHint 文案更新，注明「请按服务商实际提供的接口类型选择」。
- `api/presets.ts`：ChatGPT 预设 `transport: "openai"` → `"responses"`（其余厂商默认值不变，矩阵落库在主进程 capabilities）。
- 档案卡片/编辑表单无结构性改动（协议字段已有）。

---

## 施工阶段与验证命令

| Commit | 内容 | 涉及文件 |
|---|---|---|
| 1 | 类型扩展 + URL 规则 + 能力矩阵 + 工厂路由 + ResponsesAdapter 非流式 + 单测 | types.ts / api-endpoint.ts / capabilities.ts / index.ts / transport-detector.ts / model-settings.ts / responses-adapter.ts ★ |
| 2 | call-manager 旁路修复（既有 bug，独立提交便于 bisect） | bootstrap-config.ts / call-manager.ts |
| 3 | SDK 流式三分支 + responses-normalizer + rawAssistant 补挂 + client-config + 单测 | runtime.ts / responses-normalizer.ts ★ / client-config.ts |
| 4 | 设置页第三选项 + 端点预览 + ChatGPT 默认切换 + 文案 + 回归测试更新 | index.html / settings.ts / presets.ts |

每个 commit 后跑：

```
npm run build:main && npm run build:preload && npm run build:sim && npm run build:renderer && npm test
```

---

## 回归验证清单

- [x] tsc（main/preload/sim）+ vite build + vitest 305 文件 2431 用例全绿（四个 commit 均已验证）
- [x] 新增单测：api-endpoint responses 后缀 / responses-adapter（buildRequest 各消息形态、parseResponse、rawAssistant 经 toResponseInputItems 回放与退化构造、tool_result 追加、include 端点级判定、replay policy 对无 encrypted_content reasoning 的丢弃）/ responses-normalizer（全事件类型含 refusal/error，completed 与 incomplete 双终态捕获）/ transport-detector / call-manager 协议跟随
- [x] 旧档案（openai/anthropic）行为零变化——全量用例不回归即为证明
- [ ] 手测：ChatGPT 官方 key 新建档案 → 默认预填 responses → 测试连接 → 会话绑定后流式对话 → 多轮对话（验证 reasoning item 经 encrypted_content 回放，第二轮不丢思考上下文）
- [ ] 手测：流式 + 工具调用链路 → 第二轮请求 input 里包含原序的 message/function_call/reasoning items（开 dump 检查请求体）
- [ ] 手测：DeepSeek 同一 baseUrl 建三档案（三种协议各一）→ 三档案分别测试连接通过
- [ ] 手测：电话通话功能使用 responses 档案时不报协议错

---

## 风险与规避

| 风险 | 规避 |
|---|---|
| Responses 流式事件类型与预期有出入 | normalizer 对未知事件静默跳过（对齐 openai-normalizer 防御式写法）；先写单测钉死核心事件 |
| 流中断收不到终态事件 → rawAssistant 缺失 | 安全降级：下轮退化构造（input_text + function_call），行为同无 rawAssistant 的普通消息；注意 incomplete 是终态事件，不算中断 |
| 第三方兼容端收到 include 字段报错 | 端点级判定（决策 7：capability 标记 + `api.openai.com` 域名白名单），中转站/第三方一律不发 |
| `toResponseInputItems` 对未知 item 类型抛 TypeError | helper 的 assertNever 分支；回放前 filter 已知可回放类型（message / function_call / function_call_output / reasoning），单测覆盖 |
| tool_call_id 语义差异（Responses 用 `call_id`） | normalizer 统一映射到 accumulator 的 id 字段；`E_TOOL_CALL_ID_CHANGED` 守卫照常生效 |
| ChatGPT 默认切 responses 影响旧路径调用方 | call-manager 旁路修复（Commit 2）先于默认切换（Commit 4）合入，旧路径 `getAdapter` 无其他生产调用点（已排查） |
| structuredOutput 的 text.format 具体形态 | 以 openai@7.5 SDK 类型定义为准实现，单测覆盖；映射不了的模式退化为 prompt hint |

---

## Review 修订记录

### 第一轮（初稿 review，均已在本地 openai@7.5.0 类型定义中逐条核实）

1. **P0**：reasoning item 从「回放丢弃」改为「完整回放」——`include: ["reasoning.encrypted_content"]`（SDK `ResponseIncludable`）就是为 `store:false` 的多轮回放设计的；仅 OpenAI 官方启用，第三方降级。
2. **P0**：流式路径新增 rawAssistant 补挂机制——canonical source 为终态事件的 `response.output`，解决「非流式有回放、流式（主链路）没有」的不一致。
3. **P1**：assistant 退化构造 content 类型从 `output_text` 修正为 `input_text`（`EasyInputMessage` 输入侧类型约束）。
4. **P1**：SDK 流式调法修正为 `create({ ...body, stream: true })`（stream 是 body 字段，第二参数是 RequestOptions）。
5. **P1**：normalizer 补齐 `response.refusal.delta/done` 与独立 `error` 事件，避免空回复/漏错误。
6. **commit 拆分**：call-manager 旁路修复独立成 Commit 2。

### 第二轮（开工前 review，已逐条核实并修订）

1. **P1**：rawAssistant 回放从「原样塞回 input」改为「replay policy → `toResponseInputItems()` 清洗 → input」。核实：SDK 7.5.0 自带该 helper，位于 `openai/lib/responses/ResponseInputItems`（深度导入路径，**包根无导出**，README 的引用方式在 7.5.0 会报 undefined，已实测）；helper 负责保序、剥 `created_by`、过滤不可回放 item。同时消除初稿「决策 2 跳过无 encrypted_content 的 reasoning」与「rawAssistant 原样完整重放」的内部矛盾。
2. **P1**：`response.incomplete` 与 `response.completed` 同等捕获为 finalResponse——核实 `ResponseIncompleteEvent.response: Response`（完整 Response）。incomplete（如 max_output_tokens 截断）时 output 已含 reasoning/message/部分工具链，不应丢弃退化；「传输中断（无终态事件）」才是唯一的降级场景。
3. **P2**：`responsesEncryptedReasoning` 判定从厂商级改为端点级——ChatGPT 档案的 baseUrl 用户可自由改（可填第三方中转），capability 标记不证明端点是官方。增加 `api.openai.com` 域名白名单判定（关键决策 7）。

---

## 待办：尚未完成项

施工四个 commit（d7369a6 / fa3f688 / f576e73 / ce51665）已全部合入，自动化验证全绿。以下事项尚未完成：

### 手测验证（回归清单的手测 4 项全部未执行）

- [ ] ChatGPT 官方 key 新建档案 → 默认预填 responses → 测试连接 → 会话绑定后流式对话 → 多轮对话（验证 reasoning item 经 encrypted_content 回放，第二轮不丢思考上下文）
- [ ] 流式 + 工具调用链路 → 第二轮请求 input 里包含原序的 message / function_call / reasoning items（开 `CYRENE_PROMPT_DUMP=1` 检查请求体）
- [ ] DeepSeek 同一 baseUrl 建三档案（三种协议各一）→ 三档案分别测试连接通过
- [ ] 电话通话功能使用 responses 档案时不报协议错
- [ ] 存量 ChatGPT 档案升级后行为核验：capability 默认协议已切为 responses，若存在**未固化 explicitTransport** 的老配置，协议会静默跟随新默认值——验证老档案对话协议未被意外切换；异常则在设置存储层补固化逻辑

### supportedTransports 动态提示未消费

capabilities 已落库 `supportedTransports` 数组，但设置页 transportHint 目前是静态文案（笼统列出三种协议类型），尚未按当前厂商动态展示「该厂商官方支持哪些协议」。矩阵设计的第二个用途（transportHint 提示文案）未实现，低优先级，需要时再补。

### 已知边界（设计内取舍，非遗漏）

- `thinkingOverride` / `disableMaxToken` / 独立视觉模型配置仍留全局区，不跟随档案（沿用模型档案改造的既定边界）。
- `read_image` 工具配置仍读全局设置，不纳入档案管理（沿用既定边界）。
