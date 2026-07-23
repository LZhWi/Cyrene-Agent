# 聊天与协作模式统一路由设计

## 目标

电脑端、手机端及其他渠道使用同一条模式规则：

- 工具关闭：进入聊天模式，仅由 Soul 生成回复。
- 工具安全模式：进入协作模式，只开放低风险工具。
- 工具全部开启：进入协作模式，开放全部已启用工具。

本次不实现日常聊天的弱化版 CITA；后续可在 Soul-only 路由前增加独立的轻量上下文感知阶段。

## 运行语义

### 聊天模式

工具权限为 `off`，或桌面端选择日常聊天时：

- 不调用当前完整版 CITA。
- 不调用 Action Gate。
- 不进入 Native Function Calling。
- 不向模型暴露或执行任何工具，包括音乐工具。
- 保留 Soul system、角色设定、会话历史、关系上下文、记忆上下文和现有回复后处理。
- 保留 AG-UI 文本事件与桌面/渠道渲染能力。

### 协作模式

工具权限为 `safe-only` 或 `all`：

- 继续使用 CITA、Action Gate、Native Function Calling、Execution Policy 和 Tool Runtime。
- `safe-only` 只向协作链路提供低风险工具。
- `all` 提供全部已启用工具。

## 数据模型与兼容

渠道设置的 `toolSandbox` 从 `"safe-only" | "all"` 扩展为
`"off" | "safe-only" | "all"`。已有配置保持原值，不迁移、不改变现有用户行为；
只有用户主动选择“关闭”后才进入 Soul-only。

Agent 运行参数增加显式执行模式，避免通过工具数组是否为空进行推断：

- `soul-only`：直接运行 Soul 回复。
- `collaboration`：运行现有完整协作链路。

桌面端根据聊天风格映射执行模式；渠道端根据 `toolSandbox` 映射执行模式。

## Soul-only 数据流

用户消息 → 构建可信会话上下文 → Soul 模型调用 → AG-UI 文本事件 →
回复后处理与渲染。

Soul-only 分支应在 CITA 和 Agent Graph 之前确定，因此不会意外触发 Action Gate 或工具调用。

## 错误处理

- Soul 模型失败时沿用现有模型错误事件和用户可见错误处理。
- Soul-only 不自动降级到协作模式。
- 未识别的渠道工具权限值按 `safe-only` 处理，保持 fail-safe。

## 测试

- 设置存储可保存、读取和规范化 `off`。
- 设置界面可选择并持久化“关闭”。
- 聊天模式构建运行参数时不调用完整版 CITA，且工具列表为空。
- Soul-only 运行只调用 Soul 模型，不执行 Action Gate 或任何工具。
- `safe-only` 与 `all` 继续进入协作模式，保持现有行为。

