# 技术债：结构化输出与 Native FC

## 1. Native FC 厂商策略仍需独立维护

CITA 和 Action Gate 已使用 `structured-output/profiles.ts`，只决定
`json_schema` / `json_object` / `prompt_json`。Native FC 是不同能力面，
不得根据 JSON 档位推断 `tool_choice` 或真实工具调用可靠性。

后续如要扩展 Native FC Profile，必须基于官方文档与逐模型契约测试；自定义和本地端点不做探测。

## 2. Legacy runtime

`two-phase-fc-loop.ts` 仍作为显式 legacy runtime 保留。默认 LangGraph runtime
已经具备可信 Action Gate、确定性路由、Execution Policy/ledger 与 Native FC 单次修复。
确认没有外部调用方后，可删除 legacy runtime；在删除前不得把它描述成与默认 runtime 等价。

## 3. 厂商契约回归

结构化输出的档位是白名单：

- A：OpenAI、Claude、Kimi、豆包中已列入 Profile 的模型。
- B：DeepSeek、Qwen、GLM、MiMo 中已列入 Profile 的模型。
- M：MiniMax M3 官方端点。底层仍使用 `prompt_json`，但采用独立厂商 Profile、请求提示与修复预算。
- D：所有自定义/本地端点、所有未知模型。

新增或升级模型必须先补契约测试再修改白名单。未知模型永远回落 D 档，禁止运行时探测和自动升档。

诊断日志统一使用 `[StructuredOutput]`，包含 provider、model、profile、mode、stage、
repairCount、finishReason、candidateCount、validationFailureCode、finalOutcome 和 latency，
不记录原始模型输出或私密上下文。
