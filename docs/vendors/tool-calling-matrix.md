# Tool Calling 能力矩阵

各厂商 Provider 的 `tool_choice` + Function Calling 能力事实表。
仅用于 Native Function Calling。CITA 和 Action Gate 的 JSON 阶段改用
`src/main/orchestrator/structured-output/profiles.ts`，不再通过虚拟工具生成结构化结果。

调研时间：2026-07-20（GPT 基于各厂商官方文档）

## 符号

- ✅ 官方明确支持
- ⚠️ 有条件支持或模型/API 相关
- ❌ 官方明确不支持
- `?` 当前官方文档没有明确承诺

## `tool_choice` 能力总表

| 厂商 / 模式 | `none` | `auto` | `required/any` | `named` | Thinking 影响 |
|---|---|---|---|---|---|
| OpenAI (chatgpt) | ✅ | ✅ | ✅ | ✅ | 无已知限制 |
| Anthropic (claude), thinking off | ✅ | ✅ | ✅ `any` | ✅ `tool` | 完整支持 |
| Anthropic (claude), thinking on | ✅ | ✅ | ❌ | ❌ | `any`/`tool` 会报错 |
| DeepSeek, thinking off | ✅ | ✅ | ✅ | ✅ | 完整 API 语义 |
| DeepSeek V4, thinking on | ⚠️ 省略 | ⚠️ 省略 | ❌ | ❌ | 拒绝整个 `tool_choice` 字段 |
| Kimi, thinking off | ✅ | ✅ | ✅ | ✅ | 完整支持 |
| Kimi, thinking on | ✅ | ✅ | ✅ | ❌ | `named` 返回 400，`required` 仍支持 |
| GLM / 智谱 | ❌/未公开 | ✅ | ❌ | ❌ | 默认且仅支持 `auto` |
| Qwen, thinking off | ✅ | ✅ | ✅ | ✅ | 可强制具体工具 |
| Qwen, thinking on | ✅ | ✅ | ❌ | ❌ | 只支持 `auto` 和 `none` |
| MiniMax | ✅ | ✅ | ❌/未公开 | ❌/未公开 | 当前只支持 `auto/none` |
| MiMo (小米) | 未明确 | ✅ | ❌ | ❌ | `auto` 以外的值会被移除 |

## Function Arguments 严格保证

| 厂商 | 默认 Arguments | 严格模式 |
|---|---|---|
| OpenAI | Best effort | ✅ `strict: true` |
| Anthropic | 非 strict 时仍应校验 | ✅ Tool `strict: true` |
| DeepSeek | 普通模式不保证 | ✅ Beta `strict: true` |
| Kimi | 建议校验 | ⚠️ 有 `response_format=json_schema` |
| GLM | JSON 格式字符串 | ❌ 只有 `json_object` + 本地校验 |
| Qwen | 未找到 strict 承诺 | ⚠️ `json_object`，thinking 状态相关 |
| MiniMax | 不应假设严格合法 | ⚠️ 旧版支持 `json_schema` |
| MiMo | 不应假设严格合法 | ✅ OpenAI Chat/Responses 支持 `strict: true` |

## Transport 差异

- **MiniMax**：OpenAI 兼容 / Anthropic 兼容 / 旧文本接口，三者 `tool_choice` 都只支持 `auto/none`
- **MiMo**：OpenAI Chat / OpenAI Responses / Anthropic 兼容，三者 `tool_choice` 都只支持 `auto`
- **DeepSeek**：官方接口和第三方代理不完全相同；thinking 模式必须保留 `reasoning_content`
- **Anthropic**：extended thinking 下 `tool_choice` 只允许 `auto/none`

## MiMo 特殊点

- thinking on 时 tool_call 稳定性待契约测试（官方文档未明确承诺不稳定，但建议需要稳定时关闭 thinking）
- 支持 `strict: true`（OpenAI Chat/Responses）
- 支持 `response_format: json_object`
- thinking 可按请求关闭：`{ thinking: { type: "disabled" } }`

## Doubao（火山方舟）

- 内置厂商入口使用豆包官方方舟 `/api/v3`；不再保留独立的 Volcengine/AgentPlan 预设。
- Native FC 能力仍需按具体豆包模型做契约测试，未验证前不得从结构化输出档位反推 FC 能力。
- AgentPlan 或其他聚合入口由用户走自定义端点，固定 D 档，不由项目探测或维护。

## 参考链接

- [OpenAI Function Calling](https://developers.openai.com/api/docs/guides/function-calling)
- [Anthropic Extended Thinking](https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking)
- [DeepSeek API Docs](https://api-docs.deepseek.com/api/create-chat-completion/)
- [Kimi Tool Choice](https://platform.kimi.com/docs/guide/use-tool-choice)
- [GLM Function Calling](https://docs.bigmodel.cn/cn/guide/capabilities/function-calling)
- [Qwen Function Calling](https://help.aliyun.com/en/model-studio/qwen-function-calling)
- [MiniMax Messages API](https://platform.minimaxi.com/docs/api-reference/text-chat-anthropic)
- [MiMo OpenAI API](https://platform.xiaomimimo.com/docs/en-US/api/chat/openai-api)
