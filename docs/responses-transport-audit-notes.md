# Responses 协议接入审计备忘（2026-08-21）

> 背景：Responses 协议施工（d7369a6 / fa3f688 / f576e73 / ce51665）合入后，对「同一厂商下三协议（openai / anthropic / responses）是否全通」做全链路核对。
> 结论：**三协议主链路完整贯通**——类型层、URL 规则、能力矩阵、工厂路由、流式三分支、档案镜像、会话绑定、电话通话跟随均已到位；所有主进程消费点走 `getAdapterForConfig` 且透传 `explicitTransport`，无一走旧 `getAdapter(provider)`。
> 核对中发现两处遗漏，记录如下。

---

## 遗漏 1：Learn 模式收尾钩子漏传协议（真实路由泄漏）

- 位置：`src/main/agui-bridge.ts:600-613`（`runLearnPostTurnHook` 前构造 VendorConfig 处）
- 现状：只传 `provider / baseUrl / model / apiKey` 四字段，漏 `explicitTransport`。
- 后果：该路径回退**厂商默认协议**而非档案协议，与 call-manager 旁路 bug（Commit 2 已修）同类。
  - 例 1：DeepSeek 档案显式选 responses → learn 钩子仍走 openai；
  - 例 2：老 ChatGPT 档案固化 openai，但 capability 默认已切 responses → learn 钩子错误走 responses。
- 影响面：仅「Learn 模式 + Obsidian 就绪」的静默学习进度更新，非主对话链路。
- 修法：VendorConfig 字面量补一行 `explicitTransport: options.settings.explicitTransport`。

---

## 遗漏 2：preload 测试连接类型注解过时（纯类型问题）

- 位置：`src/preload/index.ts:289`（`settingsApi.testConnection` 参数类型）
- 现状：`explicitTransport?: "openai" | "anthropic"`，缺 `"responses"`。
- 影响：运行时无影响（`ipcRenderer.invoke` 透传）；但类型声明与实际不符，设置页传 responses 时类型对不上。
- 修法：类型改为与 `ApiTransport` 对齐（`"openai" | "anthropic" | "responses"`），或直接引用 shared 类型。

---

## Token 用量记录专项核查（2026-08-21 追加）

> 起因：用户反馈「有些模型好像只能在 OpenAI Chat Completions 协议下才会被记录用量」。
> 核查方式：全链路代码审计（adapter → normalizer → accumulator → 各 recordUsage 调用点）+ 本机真实数据比对（`token-usage.json`、`model-settings.json`、会话存储、prompt-dump）。

### 代码层结论：三协议的 usage 提取链路全部完整

| 协议 | 非流式 parseResponse | 流式 usage 来源 | 状态 |
|---|---|---|---|
| openai | `usage.prompt_tokens/completion_tokens` | `stream_options:{include_usage:true}`（openai-adapter.ts:62-64 显式开启）→ 末 chunk usage | ✓ |
| anthropic | `usage.input_tokens/output_tokens/cache_*` | message_start + message_delta 双事件 → reconcileAnthropicTerminal 的 mergeUsage 兜底 | ✓ |
| responses | `usage.input_tokens/output_tokens/input_tokens_details.cached_tokens` | `response.completed` / `response.incomplete` 终态事件的 `response.usage` | ✓ |

存储层（token-usage-store）按模型名聚合，与协议无关。所有 recordUsage 调用点（chat-loop / function-calling / harness / llm-client / memory / cita / social-context / proactive）均协议无关。**代码上不存在「只有 openai 才能记录」的结构性缺口。**

### 真实数据佐证

`token-usage.json`（v2 schema，2026-08-17 起）全部历史只有两个模型有记录，且都正常：

- MiniMax-M3（anthropic 协议）：有 input/output/hit/miss/cacheUsage —— anthropic 链路记录正常
- deepseek-v4-flash（openai 协议）：in=801488 out=22958 —— openai 链路记录正常

其它模型（GLM / ChatGPT 等）从未出现过记录——连 attemptedRequests（请求数）都没有，说明 v2 统计上线（08-17）后主聊天窗口从未用这些模型发起过对话，而非「用了但没记上」。

### 核查中发现的真实缺口

| # | 缺口 | 说明 | 影响 |
|---|---|---|---|
| 1 | **电话通话完全不记录用量** | call-manager.ts 直接 fetch + adapter，全文件无 recordRequest/recordUsage | 任何协议都不记录；电话聊得再多统计面板也是 0 |
| 2 | **模型占比列表隐藏「无 usage」模型** | getUsageReport 的 filter（token-usage-store.ts:281）只保留 input>0 或 output>0 或 requests>0 的模型；某厂商/端点不回 usage 时，该模型从占比列表**整体消失**（当日请求数仍计入 attempted） | 用户会感知为「这个模型没被记录」——最贴近用户反馈的现象 |
| 3 | **llm-client 旧流式路径 anthropic 重复计数** | 心情观察器等后台 LLM 走 adapter.parseStreamEvent 旧路径；anthropic 的 message_start 和 message_delta 各带一次 usage → 一次请求记 2 次 requests。数据佐证：MiniMax 总 req=515 > attempted=432；DeepSeek（openai）req=19=attempted=19 无此现象 | 请求数虚高（token 数不受影响，两次的 input/output 数值会被覆盖式累加——见 token-usage-store 的 applyUsageToDay，input/output 是累加的，anthropic message_start 的 output≈0、message_delta 只带 output，所以 token 总量基本正确，仅 requests 虚增） |
| 4 | **[DIAG] 调试日志残留** | runtime.ts:242-257 每次 anthropic 流式调用打 4 条 console.log（3071f92 提交时遗留） | 生产日志噪音 |
| 5 | 测试连接不记录（设计如此） | testVendorConnection 无任何记录调用 | 用户「测试连接成功但统计无记录」属预期，但易造成误解 |

### 运行时风险（非代码缺陷，需手测确认）

- **responses 第三方端点不回 usage**：usage 完全依赖终态事件 `response.completed` 的 `response.usage`。OpenAI 官方必回；DeepSeek/豆包/MiMo/MiniMax 等第三方 responses 兼容端若不在终态事件里带 usage（或根本不发终态事件），则该模型落入缺口 #2（从占比列表消失）。
- **responses 流中断**（无终态事件）：无 usage、无 rawAssistant，安全降级但同样不记录。

### 修复项（2026-08-21 当天已全部施工，待提交）

1. ~~call-manager 补 recordRequest + 从响应解析 usage 并 recordUsage~~ ✓ [call-manager.ts](../src/main/call/call-manager.ts) runAgentTurn 解析响应后补记
2. ~~getUsageReport 的模型 filter 放宽~~ ✓ [token-usage-store.ts](../src/main/token-usage-store.ts) attemptedRequests > 0 的模型保留可见
3. ~~llm-client 旧路径 anthropic usage 去重~~ ✓ [llm-client.ts](../src/main/services/llm/llm-client.ts) 流式期间逐字段取最大值合并，循环结束只记一次
4. ~~删除 runtime.ts 的 [DIAG] 日志~~ ✓ [runtime.ts](../src/main/orchestrator/vendors/sdk-stream/runtime.ts) 4 条 console.log 全部移除

验证：tsc 三项目 + vite build + vitest 全量（305 文件 2431 用例）全部通过。

---

## 已核对通过的链路清单（备查）

| 环节 | 位置 |
|---|---|
| `Transport` / `ApiTransport` 含 responses | vendors/types.ts:8 / shared/api-endpoint.ts:1 |
| URL 规则 `/responses` 后缀 | shared/api-endpoint.ts:24-28 |
| 设置页下拉三项全量放开（无厂商拦截） | settings/index.html:141-145 |
| 档案保存/清洗保留 responses | model-settings.ts:191 |
| 会话绑定档案 → 镜像协议 | model-settings.ts:376（resolveModelSettingsProfile） |
| 工厂三分支路由（cache key `provider::transport` 天然隔离） | vendors/index.ts:56-61 |
| 流式三分支 + rawAssistant 双终态补挂 | sdk-stream/runtime.ts:197-232 |
| 电话通话跟随档案协议 | call-manager.ts:330 / bootstrap-config.ts:115 |
| 其余消费点（主聊天/工具阶段/harness/记忆/CITA/社交上下文/主动关怀/翻译/测试连接） | 均走 getAdapterForConfig + 透传 explicitTransport |
