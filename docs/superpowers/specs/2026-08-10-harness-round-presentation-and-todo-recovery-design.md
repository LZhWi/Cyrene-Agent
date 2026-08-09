# Harness 回合展示与 Todo 恢复设计

## 目标

让 Work、Daily、Learn 模式的过程区忠实呈现模型的 function-calling 回合，并让异常中断后的下一次 Run 能读取当前会话已落盘的 Todo 检查点。Todo 仍由模型自主维护，Runtime 不强制创建或完成计划。

## 冻结语义

1. 一个模型调用就是一个 `round`。该调用产生的公开过程文本、公开 reasoning 和全部工具调用属于同一回合。
2. 一个回合在 UI 中只显示一个可折叠过程块。
3. 回合运行中，标题显示真实的当前动作，例如“昔涟正在读取文件”。
4. 回合结束后，标题根据成功和失败的真实工具事实生成摘要，例如“昔涟已完成 · 浏览 5 个目录 · 读取 3 个文件”。无法安全细化时回退为“完成 N 项操作”。
5. reasoning 收入回合折叠块，不再作为过程区的平级独立块。
6. 下一次模型调用产生新的回合块；最终无工具调用的正式回答仍只进入聊天气泡。
7. 只有提交正式回答后，整个 Run 过程区才可自动折叠；取消、超时、断连或无正式回答时保持展开。
8. `update_todo` 是唯一 Todo 工具。旧 `todo_write`、mode 级 Todo store、广播和 IPC 不再承担产品职责。
9. Todo 使用说明是模型策略提示，不使用强制 `tool_choice`，Runtime 不因 Todo 为空而命令模型继续。

## 数据与事件

Harness 为每次模型调用生成稳定 `roundId`，发出 `round_start` 和 `round_end`。reasoning、过程文本和工具事件保持 AG-UI 原有顺序；Renderer 在 `round_start` 与 `round_end` 之间把事件绑定到当前回合。工具参数继续使用标准 `TOOL_CALL_ARGS` 事件，不新增平行私有工具协议。

持久化消息增加 `agentRounds` 元数据。每个回合保存状态、过程文本、reasoning 引用、工具引用和时间。旧消息仍可通过现有 `afterToolCount` 字段降级展示。

## Todo 恢复

Todo 已随 `ChatMessage.runSnapshot.todos` 原子写入 `<userData>/cyrene-chats/sessions/<sessionId>.json`。当最近一次 Run 状态为 `interrupted` 且存在未完成 Todo 时，Renderer 在下一次 Run 的请求中附加只读 `recoveryContext`。主进程把它作为 `[RECOVERY_CONTEXT]` 注入 system prompt，要求模型先查证再继续，不能把 Todo 状态当成外部副作用已经成功的证明。

普通成功终态和全新任务不注入恢复上下文。用户不发送新消息时不会自动启动 Run。

## 复用与自定义边界

- 复用 `@ag-ui/core` 的 reasoning、工具开始、参数和结果事件。
- 复用现有 ChatSession JSON 原子持久化，不新增数据库或第二套 Todo 文件。
- 复用 Ant Design X 的折叠与消息组件，不引入新的时间线依赖。
- 只自定义 AG-UI 尚未表达的模型回合边界和项目语义摘要。

## 验收

- 连续五次 `list_dir` 在同一模型回合中只产生一个过程块。
- 运行时标题随当前工具变化；回合完成后显示真实计数摘要。
- 展开块按“过程文本、reasoning、工具明细”展示本轮内容。
- 下一次 function-calling 文本出现在新的回合块中。
- 正式最终回答仍只显示在气泡，异常中断时过程保持展开。
- 中断后的会话重开仍能显示 Todo；用户继续时模型请求包含恢复上下文。
- 简单问答不被强制调用 `update_todo`。
- Harness 工具列表不再包含 `todo_write`，旧 Todo IPC 无 renderer 消费者后被删除。
