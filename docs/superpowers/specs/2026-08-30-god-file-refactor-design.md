# 五个上帝文件渐进式重构设计

## 背景

当前主进程中有五个文件同时承担过多职责：

- `src/main/agui-bridge.ts`
- `src/main/orchestrator/build-options.ts`
- `src/main/channels/dispatcher.ts`
- `src/main/memory/memory-store.ts`
- `src/main/orchestrator/harness-adapter.ts`

这些文件均已有较完整的回归测试，但核心函数和管理类过长，且业务规则、状态管理、输入输出转换与基础设施操作混在同一文件中。重构目标是降低理解和修改成本，不改变任何可观察行为。

## 硬约束

1. 保留所有现有公开导出、函数签名、类方法和单例访问方式。
2. 保留全部 IPC channel、事件名称、事件字段、错误码、错误文本和事件发送顺序。
3. 保留运行终态、取消、接管、恢复、权限、计划模式和副作用执行语义。
4. 保留记忆文件路径、JSON schema、迁移规则、默认值及写盘时机。
5. 保留渠道 sessionId、历史顺序、日志内容、贴纸、TTS 与能力降级行为。
6. 不引入新运行时或开发依赖。
7. 不顺带修改业务逻辑、命名协议、数据模型或用户界面。
8. 每个阶段必须独立通过针对性测试、完整测试与主进程 TypeScript 构建。

## 方案选择

采用“渐进式兼容门面”方案。原文件继续作为稳定入口，对外 API 不变；独立职责迁移到同目录或紧邻子目录中的聚焦模块，原入口只负责参数接线、调用顺序和兼容重导出。

不采用以下方案：

- 一次性重写五个模块：变更面过大，事件顺序或持久化细节发生回归时难以定位。
- 只提取零散工具函数：无法消除核心长函数和跨领域状态耦合。
- 引入新的状态机、依赖注入框架或数据库：超出行为保持型重构范围。

## 总体原则

### 兼容门面

原文件路径是兼容边界。调用方不需要迁移，原文件继续导出当前符号。若类型或函数迁入新模块，原文件使用显式重导出保持导入路径稳定。

### 状态所有权

每份运行时状态只有一个所有者：

- AG-UI active run 与 session guard 状态由专门守卫模块持有。
- 渠道 settings 与 limiter 缓存继续由 `ChannelDispatcher` 实例持有。
- 记忆 cache 与最终写盘入口继续由唯一的 store manager 持有。
- Harness run store、review tracker 和 task executor 仍按当前运行生命周期创建。

不得为了拆文件复制 Map、cache、AbortController 或单例。

### 顺序与异步边界

迁移代码时保持现有调用顺序和 `await` 边界。特别禁止：

- 将同步文件操作改为异步，或反向修改。
- 将 fire-and-forget 调用改为阻塞等待。
- 调换 RUN_FINISHED、sticker、记忆写入、计划审批和 lifecycle 清理顺序。
- 调换渠道历史读取、入站写入、智能体调用和出站写入顺序。
- 改变 error/catch 的覆盖范围或 fallback 行为。

### 文件规模护栏

行数不是验收目标，但作为结构回退警报：

- 原兼容门面目标不超过 350 行。
- 新模块目标不超过 350 行。
- 单个函数或方法目标不超过 180 行。

如自然职责边界与行数目标冲突，以职责完整和行为兼容为先，并在实施记录中说明。

## 阶段一：`memory-store.ts`

### 现有职责

当前文件混合默认数据、迁移修复、文件读写、缓存、L0/L1/L2 操作、证据、反思日志、冲突队列、冲突裁决、批量衰减和 L2 激活状态。

### 拆分边界

- `memory/memory-store-defaults.ts`
  - 默认 L0/L1/store 构造。
  - 文本 snippet 与关键词提取等无状态辅助逻辑。
- `memory/memory-store-migrations.ts`
  - schema version 与 `repairMigrations`。
  - 缺失字段及 L2 激活状态补全。
- `memory/memory-store-io.ts`
  - 路径解析、备份、JSON 读取和原子意义不变的现有写盘操作。
  - 不拥有业务 cache。
- `memory/memory-l2-operations.ts`
  - L2 创建、更新、批处理、权重和状态变化的纯 store 变换。
- `memory/memory-conflict-operations.ts`
  - 冲突日志排队、排序及 resolver resolution 应用。
- `memory/memory-dmae-operations.ts`
  - L2 激活状态初始化、读取和更新。
- `memory/memory-store.ts`
  - 保留 `memoryStore`、所有现有方法和 cache。
  - 负责 load → 调用领域操作 → save 的事务顺序。

### 兼容要求

`memoryStore` 的对象身份、方法名、返回值、时间戳生成位置和每次 save 后的 Obsidian 通知行为保持不变。纯操作函数只接收显式 store 和参数，不直接访问 Electron app 或模块级 cache。

## 阶段二：`channels/dispatcher.ts`

### 现有职责

当前 `handleIncoming` 同时处理限速、session 路由、历史迁移、桌面广播、日志、历史滑窗、智能体调用、文本分段、TTS、贴纸、出站历史和渠道能力降级。

### 拆分边界

- `channels/dispatcher/session-routing.ts`
  - sessionId 构造、记录和原发送者查询。
- `channels/dispatcher/incoming-message.ts`
  - 入站日志、桌面镜像、历史滑窗读取与入站历史写入。
- `channels/dispatcher/agent-reply.ts`
  - `buildAndRunAgent` 调用、echo fallback 和失败日志。
- `channels/dispatcher/outgoing-parts.ts`
  - 文本分段、贴纸 part 和渠道消息对象构建。
- `channels/dispatcher/tts-part.ts`
  - TTS 决策、合成结果规范化、缓存文件写入和 audio part 构造。
- `channels/dispatcher/outgoing-effects.ts`
  - 出站桌面镜像、日志和 assistant 历史写入。
- `channels/dispatcher.ts`
  - 保留 `ChannelDispatcher`、`DispatcherDeps`、设置缓存、限速器和全部当前重导出。
  - `handleIncoming` 只保留管线顺序与短路控制。

### 兼容要求

历史必须继续“先读旧滑窗，再写本条 user”。Agent 失败仍返回 `null`，TTS 或镜像失败仍只告警，最终 capability downgrade 仍是返回前最后一步。

## 阶段三：`build-options.ts`

### 现有职责

当前模块处理附件、图片直发与 caption fallback、会话和工作区、用户画像、社交上下文、关系上下文、CITA、风格、工具、Skill、搜索后端、计划模式、能力解析、prompt 分层和运行后副作用。

### 拆分边界

- `orchestrator/run-options/types.ts`
  - `BuildOptionsDeps`、`OnRunFinishedDeps` 及轻量设置类型。
- `orchestrator/run-options/image-attachments.ts`
  - 图片校验、直发 content block、caption fallback 与占位消息。
- `orchestrator/run-options/context-assembly.ts`
  - always-on、relationship、environment、social 与 CITA 上下文收集。
- `orchestrator/run-options/style-resolution.ts`
  - styleId 兼容解析、prompt block 和 sampling 决策。
- `orchestrator/run-options/capability-resolution.ts`
  - 工具、Skill、搜索后端、计划只读和 authoritative/fallback capabilities 双路径。
- `orchestrator/run-options/prompt-assembly.ts`
  - stable prefix、session/mode/runtime context 和 usage parts 组装。
- `orchestrator/run-options/finished-effects.ts`
  - 记忆、社交原子、关系记录、运行状态和 sticker 决策。
- `orchestrator/build-options.ts`
  - 保留当前导出。
  - `buildAgentRunOptions` 负责按原顺序组合各阶段结果。
  - `onAgentRunFinished` 委托给 finished-effects。

### 兼容要求

保留当前 fallback capabilities 与 authoritative capabilities 双路径，禁止在本次重构中合并。Prompt 内容、分层字段、拼接顺序和缓存稳定前缀必须逐字段一致。`BuildOptionsDeps` 的现有字段保持不变。

## 阶段四：`harness-adapter.ts`

### 现有职责

当前模块同时处理计划首尾钩子、VendorConfig、工具选择、恢复、prompt materialization、run store、权限、任务委托、HarnessInput、checkpoint、review、终态、事件映射和 prompt 构建。

### 拆分边界

- `orchestrator/harness/adapter/run-preparation.ts`
  - plan context、VendorConfig、工具列表、恢复消息和 run store create。
- `orchestrator/harness/adapter/tool-runtime.ts`
  - ToolContext、权限检查、输出 store 和 task executor。
- `orchestrator/harness/adapter/prompt-builder.ts`
  - Harness prompt layers、system prompt 和启动 transcript materialization。
- `orchestrator/harness/adapter/event-mapper.ts`
  - HarnessEvent 与 task lifecycle 到 AG-UI event 的映射。
- `orchestrator/harness/adapter/terminal-mapper.ts`
  - terminate reason、canonical terminal、run terminal store 和 review finalize。
- `orchestrator/harness/adapter/plan-lifecycle.ts`
  - PLAN_REVIEW 回退、EXECUTING context 和执行结束事件。
- `orchestrator/harness-adapter.ts`
  - 保留全部公开函数和重导出。
  - `runHarnessWithAdapter` 只编排准备、运行、终态与结果返回。

### 兼容要求

canonical runId、恢复校验、计划只读双层防护、checkpoint 时机、uncertain effects、review finalize 容错和 `cyrene.plan.completed` 发送条件保持不变。

## 阶段五：`agui-bridge.ts`

### 现有职责

当前模块处理 IPC 注册、会话验证、runId、事件发送、session guard、takeover、options 构建、Learn 初始化、流式 think/time 过滤、终态 gate、错误映射、副作用、计划审批和取消。

### 拆分边界

- `main/agui/types.ts`
  - `AguiRunInput`、构建与收尾回调类型、生命周期接口。
- `main/agui/session-run-guard.ts`
  - 同会话互斥、takeover、settled promise、compare-and-delete 和测试 seam。
- `main/agui/event-sender.ts`
  - canonical runId stamping、sender/chatWindow 目标去重和安全发送。
- `main/agui/text-stream-forwarder.ts`
  - think filter、chat-time filter 与 reasoning/text 事件边界。
- `main/agui/run-finalizer.ts`
  - settlement gate、终态缓存、错误映射、成功副作用和 lifecycle 清理顺序。
- `main/agui/plan-review-flow.ts`
  - plan 文件读取、两阶段用户确认及相关 CUSTOM 事件。
- `main/agui-bridge.ts`
  - 保留原公开导出和 IPC 注册入口。
  - 负责验证 session、创建运行上下文、订阅 agent 和注册取消 handler。

### 兼容要求

所有 bridge 发出的事件继续携带 canonical runId。每个 run 只产生一个终态；runtime error 继续走 RUN_ERROR；sticker 等成功副作用继续先于 RUN_FINISHED；cancel 继续通过 AbortController 触发自然结算，而不是直接 unsubscribe。

## 测试策略

### 测试先行

每个新模块先建立针对其公开接口的测试。测试首次运行应因模块或接口尚不存在而失败，然后迁移最小代码使其通过。现有 facade 测试持续验证外部行为。

### 阶段性验证

每阶段执行：

1. 新模块单元测试。
2. 对应原模块的现有测试。
3. 与该模块直接相关的跨模块测试。
4. `npm run build:main`。
5. `npm test`。

### 关键回归面

- AG-UI：终态 exactly-once、事件顺序、取消隔离、并发 takeover。
- Build options：prompt 分层、style、工具和 Skill 双路径、图片降级。
- Dispatcher：历史顺序、日志容错、TTS、贴纸、capability downgrade。
- Memory store：迁移、损坏文件恢复、冲突裁决、批量状态与激活状态。
- Harness adapter：取消、Git 工具过滤、恢复、权限、event mapping 与 terminal mapping。

## 提交策略

每个阶段至少一个独立提交，必要时按“测试接口”“迁移实现”“门面清理”进一步拆分。不得把多个阶段混入同一提交。每阶段完成后工作区必须干净，便于单独回滚。

## 验收标准

1. 五个原路径和现有公开 API 保持可用。
2. 所有现有测试和新增测试通过。
3. 主进程 TypeScript 构建通过。
4. 无新增运行时或开发依赖。
5. IPC、事件、错误、持久化格式和调用顺序无变化。
6. 原文件成为兼容门面或短编排器，领域逻辑位于职责单一的新模块。
7. 新模块之间不存在通过原门面反向导入形成的循环依赖。

## 非目标

- 不重命名用户可见模式、事件或错误。
- 不修改数据结构或升级 schema version。
- 不优化性能或改变同步/异步策略。
- 不改写算法或合并兼容分支。
- 不拆分 `agui-bridge.test.ts` 等大型测试文件，除非新模块测试需要共享 fixture；测试套件整理可另立任务。
