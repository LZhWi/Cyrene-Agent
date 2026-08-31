# AG-UI Bridge 渐进式重构施工计划

> **执行者提示：** 本文只描述施工步骤。实现时逐项勾选；若由智能体执行，先加载 `superpowers:test-driven-development` 与 `superpowers:verification-before-completion`。

**目标：** 把 `src/main/agui-bridge.ts` 拆成类型、事件发送、会话运行守卫、文本流转发、运行终态收尾和计划审批模块；原文件继续负责 IPC（进程间通信）注册、会话验证、agent 订阅和取消入口。

**架构：** session run guard（会话运行守卫）管理“哪个 run 占用 session”；run finalizer（运行收尾器）管理“该 run 是否已产生标准终态”。两者拥有完全独立的状态。event sender（事件发送器）统一盖 canonical runId（标准运行标识），text stream forwarder（文本流转发器）封装 `<think>` 与时间前缀状态。Facade（兼容门面）只接线，不重新实现叶子模块规则。

**技术栈：** TypeScript、Electron 主进程、RxJS（响应式流库）、AG-UI（智能体图形交互协议）、Vitest。继续复用现有 `RunSettlementGate`、`think-filter`、`ChatTimeStreamPrefixFilter`、`ipc-scope` 和取消/审批服务，不引入新的 observable（可观察流）封装或状态机。

**总设计：** `docs/superpowers/specs/2026-08-30-god-file-refactor-design.md`

## 两个 settled 概念的硬边界

```text
session-run-guard
└── settled Promise：旧 run 的生命周期是否释放，可否让 takeover 继续

run-finalizer
└── RunSettlementGate：本 run 是否已经产生 RUN_FINISHED 或 RUN_ERROR
```

- session guard 的 key 是 `sessionId`，值包含当前 `runId`、abort 和 settled promise；它不解释 terminal status（终态状态）。
- run finalizer 的 key/实例范围是单个 `runId`；它不查询或修改 session owner（会话所有者）。
- 禁止共享布尔值、共享 `Map`、互相 import 实现或把二者统一为“通用状态机”。
- takeover 只有在 finalizer 的生命周期清理最终调用 guard lease release 后才会被放行，但这只是单向回调，不是共享状态。

## 全局约束

- 保留 `AguiRunInput`、四个回调/生命周期类型、四个测试 seam（测试接缝）和 `registerAgUiIpc` 的旧导入路径与签名。
- 所有 bridge 发出的对象事件都继续携带 canonical runId；已有 runId 不被覆盖。
- sender 与 chatWindow 去重、窗口销毁检查、单目标发送失败隔离和错误日志不变。
- 同一 session 同时只允许一个 run；takeover 的匹配、abort、有界等待、最多重试次数和错误码不变。
- 每个 run 只发一个终态；`runtime_error` 继续映射成 `RUN_ERROR`，其他终态继续使用 `RUN_FINISHED`。
- 成功路径顺序必须是 `successEffect → sticker → RUN_FINISHED`；历史索引和 Learn hook 仍是非阻塞调用。
- cancelled/timeout/runtime_error 不执行成功副作用或计划审批。
- `AGUI_CANCEL` 必须调用各 run 自己的 `AbortController.abort()`，不得用 `unsubscribe()` 代替自然结算。
- 同步 complete 不得留下 ghost active run（幽灵活跃运行）。
- 构建 options、Learn 配置、订阅、error、complete 的每个清理分支都必须释放 lifecycle 和 session lease，且只释放一次。
- 新模块不得反向导入 `main/agui-bridge.ts`。

## 文件地图

- 新建 `src/main/agui/types.ts`：输入、构建/收尾回调和 lifecycle 类型。
- 新建 `src/main/agui/event-sender.ts`：runId stamping（盖运行标识）、目标去重与安全发送。
- 新建 `src/main/agui/session-run-guard.ts`：session 互斥、takeover、settled promise、compare-and-delete（比较后删除）和测试 seam。
- 新建 `src/main/agui/text-stream-forwarder.ts`：think/time 过滤及 reasoning/text 事件边界。
- 新建 `src/main/agui/run-finalizer.ts`：单 run settlement gate（结算门）、终态缓存、错误映射、成功副作用和幂等生命周期清理。
- 新建 `src/main/agui/plan-review-flow.ts`：计划文件读取、两阶段确认和 CUSTOM 事件。
- 修改 `src/main/agui-bridge.ts`：保留 IPC 注册、会话验证、options 构建、Learn 初始化、订阅和取消注册。
- 修改 `src/main/agui-bridge.test.ts`：保留 facade 级调用轨迹、模式、取消和并发测试。
- 为上述叶子模块创建同名测试文件。

## 目标接口

```ts
// event-sender.ts
export type AguiSend = (event: unknown) => void
export function createAguiEventSender(input: {
  sender: WebContents
  runId: string
  getChatWindow: GetChatWindowFn
}): AguiSend

// session-run-guard.ts
export interface SessionRunLease {
  sessionId: string
  runId: string
  release(): void
}
export function acquireSessionRun(input: {
  sessionId: string
  runId: string
  takeoverFromRunId?: string
  abort: () => void
}): Promise<SessionRunLease>
export function getSessionActiveRunForTest(sessionId: string): string | undefined
export function setTakeoverSettleTimeoutForTest(ms: number): void
export function releaseSessionGuardForTest(sessionId: string, runId: string): void

// text-stream-forwarder.ts
export class AguiTextStreamForwarder {
  constructor(input: { threadId: string; runId: string; send: AguiSend })
  handle(baseEvent: unknown): boolean
  reset(): void
}
```

`handle` 返回 `true` 表示事件已被消费，门面不得再原样发送；返回 `false` 表示它不是 TEXT_MESSAGE 事件，可继续走普通分支。

```ts
// run-finalizer.ts
export interface RunFinalizerDeps {
  runId: string
  threadId: string
  sessionId: string
  mode: ConversationMode
  latestUserText: string
  input: AguiRunInput
  options: CyreneRunOptions
  agent: CyreneAgent
  send: AguiSend
  onRunFinished: OnRunFinishedFn
  onDeleteActiveRun: () => void
  onEndLifecycle: () => void
}

export class AguiRunFinalizer {
  captureRunFinished(baseEvent: unknown): "captured" | "duplicate" | "runtime_error"
  handleStreamError(error: unknown): void
  complete(): Promise<{ successful: boolean }>
  isSettled(): boolean
}
```

`AguiRunFinalizer` 内部只能拥有单 run 的 `RunSettlementGate`、`pendingRunFinishedEvent` 和 lifecycle 幂等标记；不能持有 session `Map`。如果 `onEndLifecycle` 内部释放 guard lease，这是依赖回调，不改变状态所有权。

```ts
// plan-review-flow.ts
export function startPlanReviewFlow(input: {
  sessionId: string
  threadId: string
  runId: string
  send: AguiSend
}): void
```

---

### 任务 1：补足 facade 特征测试

**文件：**

- 修改 `src/main/agui-bridge.test.ts`
- 不改生产代码

- [ ] 在现有“sticker before RUN_FINISHED”用例中让 `onRunFinished` 写入 `successEffect`，发送函数写 `sticker/RUN_FINISHED`，严格断言：

```text
successEffect
sticker
RUN_FINISHED
```

- [ ] 对无 sticker 的成功路径断言 `successEffect → RUN_FINISHED`。
- [ ] 对 cancelled、timeout、runtime_error 断言不出现 `successEffect`、sticker 或 plan review。
- [ ] 补一条清理轨迹，证明 activeRuns delete、session lease release、Learn unregister 和 lifecycle end 都发生一次。
- [ ] 保留并确认现有 26 个用例：canonical runId、重复终态、success/error 竞态、裸 complete、runtime_error、逐 run cancel、cancel all、guard/takeover、compare-delete 和同步 complete。
- [ ] 运行：

```powershell
npx vitest run src/main/agui-bridge.test.ts
npm run build:main
```

---

### 任务 2：迁移共享类型

**文件：**

- 新建 `src/main/agui/types.ts`
- 修改 `src/main/agui-bridge.ts`

- [ ] 原样迁移 `AguiRunInput`、`BuildOptionsFn`、`RunFinishedEffects`、`OnRunFinishedFn`、`GetChatWindowFn`、`AguiConversationLifecycle`。
- [ ] 保持字段 optionality（可选性）、deprecated 注释和宽类型不变，不趁重构收紧 renderer 输入。
- [ ] 门面使用显式 type re-export（类型重导出）保持旧路径。
- [ ] 所有叶子模块从 `./types` 取类型，不从 `../agui-bridge` 取类型。
- [ ] 运行 `agui-bridge.test.ts` 与构建。

---

### 任务 3：提取事件发送器

**文件：**

- 新建 `src/main/agui/event-sender.ts`
- 新建 `src/main/agui/event-sender.test.ts`
- 修改 `src/main/agui-bridge.ts`

- [ ] 迁移 `send` 闭包中的 runId stamping、sender 优先、chatWindow fallback（回退）、目标去重和单目标 `try/catch`。
- [ ] 非对象值保持原样；对象已有 runId 时保持其值；缺失时补 canonical runId。
- [ ] sender 已销毁时只尝试 chatWindow；两者相同只发一次；其中一个 `send` 抛错不影响另一个。
- [ ] 保持 IPC channel `IPC.AGUI_EVENT` 和错误日志字段。
- [ ] 门面每次 AGUI_RUN 只创建一个 sender，后续所有 bridge 自产事件都使用它。
- [ ] 运行：

```powershell
npx vitest run src/main/agui/event-sender.test.ts src/main/agui-bridge.test.ts
npm run build:main
```

---

### 任务 4：提取 session run guard

**文件：**

- 新建 `src/main/agui/session-run-guard.ts`
- 新建 `src/main/agui/session-run-guard.test.ts`
- 修改 `src/main/agui-bridge.ts`

- [ ] 原样迁移 `sessionActiveRuns`、超时配置、compare-and-delete 和测试 seam；模块是该 `Map` 的唯一所有者。
- [ ] `acquireSessionRun` 在无现有 owner 时必须在第一个 `await` 前同步 set，保持同 tick（事件循环刻）并发的原子性。
- [ ] takeoverFromRunId 不匹配仍抛 `SESSION_RUN_ACTIVE:<runId>`；旧 run 两轮后仍未释放则抛 `SESSION_RUN_TAKEOVER_STUCK:<runId>`。
- [ ] takeover 调旧 entry 的 abort，等待其 settled 或超时，然后回循环顶部重新竞争；不得超时后直接覆盖 `Map`。
- [ ] lease `release()` 幂等，并通过 compare-delete 防止迟到旧 run 删除新 owner；无论是否仍为 owner，都 resolve 自己的 settled promise。
- [ ] 门面把现有 `__getSessionActiveRunForTest`、`__setTakeoverSettleTimeoutForTest`、`__releaseSessionGuardForTest` 显式重导出；名字保持不变。
- [ ] 复用现有 guard 测试并在新模块增加直接并发测试。
- [ ] 搜索确认只有一份 session 状态：

```powershell
rg -n "sessionActiveRuns|takeoverSettleTimeoutMs" src/main/agui-bridge.ts src/main/agui
```

- [ ] 运行：

```powershell
npx vitest run src/main/agui/session-run-guard.test.ts src/main/agui-bridge.test.ts
npm run build:main
```

---

### 任务 5：提取文本流转发器

**文件：**

- 新建 `src/main/agui/text-stream-forwarder.ts`
- 新建 `src/main/agui/text-stream-forwarder.test.ts`
- 修改 `src/main/agui-bridge.ts`

- [ ] 把 `thinkFilter`、`timePrefixFilter`、pending start、reasoning started/messageId 等全部迁入每 run 一个的 class instance（类实例）。
- [ ] 保持 leading-only、延迟 TEXT_MESSAGE_START、过滤空 CONTENT、reasoning START/CONTENT/END 和 flush-before-END 顺序。
- [ ] 没有 START 的 CONTENT 原样转发；END 缺失时 `reset()` 关闭 reasoning 并清空状态。
- [ ] `RUN_FINISHED`、stream error 和 complete 进入终态处理前都调用 `reset()`；重复调用必须安全。
- [ ] 使用分块 `<think>`、标签跨 chunk（数据块）、时间前缀跨 chunk、纯 reasoning、无 START 和缺 END 覆盖边界。
- [ ] 运行：

```powershell
npx vitest run src/main/agui/text-stream-forwarder.test.ts src/main/agui-bridge.test.ts
npm run build:main
```

---

### 任务 6：提取单 run finalizer

**文件：**

- 新建 `src/main/agui/run-finalizer.ts`
- 新建 `src/main/agui/run-finalizer.test.ts`
- 修改 `src/main/agui-bridge.ts`

- [ ] 将 `extractTerminalFromRunFinished` 迁入本模块并直接单测：合法四态、缺 flag 的保守默认、旧 upstream 无 result 的 success 兼容。
- [ ] 每个 `AguiRunFinalizer` 创建一个现有 `RunSettlementGate`；不要再造 exactly-once（只结算一次）算法。
- [ ] `captureRunFinished`：先 gate；runtime_error 立即发送一个 RUN_ERROR 并不缓存 RUN_FINISHED；其他终态只缓存，等 complete 做副作用后发送。
- [ ] `handleStreamError`：清理文本流由门面先完成；规范化 AbortError 文本；同一个 gate 处理 error/success 竞态；必要时补发已缓存 RUN_FINISHED；最后 delete active run 并 end lifecycle。
- [ ] `complete`：裸 complete 合成 success RUN_FINISHED；只对 success + `agent.lastResult` 执行 `onRunFinished`；sticker 在 pending RUN_FINISHED 前发送。
- [ ] 保持 `indexConversationTurn` 位于 `onRunFinished` 后且不等待；Learn hook 仍仅 mode=learn 且 workspace ready 时触发并不等待。
- [ ] plan review 不放进 finalizer；`complete` 返回 `{ successful: boolean }`，由门面据此异步启动审批。
- [ ] `onEndLifecycle` 必须幂等，负责调用注入的 guard lease release、Learn unregister 与 lifecycle end；finalizer 本身不得 import session guard。
- [ ] 直接测试以下竞态矩阵：

```text
RUN_FINISHED(success) → complete
RUN_FINISHED(success) → error
error → late RUN_FINISHED
RUN_FINISHED(runtime_error) → complete
duplicate RUN_FINISHED
bare complete
cancelled/timeout
```

- [ ] 搜索状态隔离：

```powershell
rg -n "sessionActiveRuns|SessionRunLease|takeover" src/main/agui/run-finalizer.ts
rg -n "RunSettlementGate|pendingRunFinished" src/main/agui/session-run-guard.ts
```

两条预期均无匹配。

- [ ] 运行新模块测试、facade 测试和构建。

---

### 任务 7：提取计划审批流

**文件：**

- 新建 `src/main/agui/plan-review-flow.ts`
- 新建 `src/main/agui/plan-review-flow.test.ts`
- 修改 `src/main/agui-bridge.ts`

- [ ] 整体迁移 `startPlanReviewFlow`，保留 fire-and-forget（发出后不等待）外壳，不能阻塞 RUN_FINISHED 的 complete 回调。
- [ ] 保持 `moveToReview` 幂等短路、plan.md 异步读取和读取失败空文本回退。
- [ ] 保持第一段 review card、批准路径、supplement card（补充卡片）、超时/空文本回 PLAN_DISCUSSING、CUSTOM 事件名和 payload。
- [ ] 保持 `requestUserClarification` 的 runId/revision/session 归属字段，防止卡片串会话。
- [ ] 直接测试批准、补充、空补充、超时、读取失败和 `moveToReview=false`。
- [ ] 门面只在 code/chat 且 finalizer 返回 successful 时调用。
- [ ] 运行新模块测试和 `agui-bridge.test.ts`。

---

### 任务 8：重组 AGUI_RUN 编排

**文件：**

- 修改 `src/main/agui-bridge.ts`
- 修改 `src/main/agui-bridge.test.ts`

- [ ] 保留调用次序：lifecycle start → perf turn → input/session/workspace 验证 → guard acquire → build options → Learn 配置 → agent/forwarder/finalizer → subscribe → conditional activeRuns set → ack。
- [ ] session/workspace 验证失败仍立即 `onConversationEnded`；guard 后的 build/Obsidian configure 失败必须 release lease 并结束 lifecycle。
- [ ] options 继续写入 executionMode、recovery、conversationMode、canonical runId、signal 和 clarification callback。
- [ ] `next` 回调顺序：RUN_FINISHED 先 reset forwarder 再交 finalizer；TEXT_MESSAGE 交 forwarder；其他事件交 sender。
- [ ] `error` 回调先 reset forwarder，再交 finalizer；`complete` 同理，并在成功时启动 plan review。
- [ ] `activeRuns` 仍只是一份 cancellation registry（取消注册表），可留在门面；只有 finalizer 未 settled 时才在 subscribe 返回后登记，防止同步 complete 复活。
- [ ] activeRuns entry 保持 `subscription/endLifecycle/abortController` 结构与 `__hasActiveRunForTest` 行为。
- [ ] invoke 仍立刻返回 `{ success: true, runId }`，不等待 observable 结束。
- [ ] 运行完整 facade 测试与构建。

---

### 任务 9：保留取消语义并收瘦门面

**文件：**

- 修改 `src/main/agui-bridge.ts`

- [ ] `AGUI_CANCEL` 的单 run 与 all runs 分支保持不变；复制 keys 后迭代，避免删除期间跳项。
- [ ] 只在 signal 未 aborted 时调用 abort，但每次都清理 pending choices 和 approvals。
- [ ] 不调用 `subscription.unsubscribe()`；subscription 字段保留兼容和生命周期引用，但取消靠 signal 自然生成 cancelled terminal。
- [ ] `HARNESS_GET_INTERRUPTED_RUN` handler 的输入校验和返回投影不变。
- [ ] 门面显式重导出 types 与 guard 测试 seam；不使用 `export *`。
- [ ] 检查反向依赖、重复状态和终态发送点：

```powershell
rg -n 'from "\.\.\/agui-bridge"|from "\.\/\.\.\/agui-bridge"' src/main/agui
rg -n "new RunSettlementGate|sessionActiveRuns|activeRuns" src/main/agui-bridge.ts src/main/agui
rg -n 'type: "RUN_(FINISHED|ERROR)"' src/main/agui-bridge.ts src/main/agui
```

- [ ] 人工确认：session guard 只有一份 session `Map`；finalizer 每实例一个 settlement gate；activeRuns 只有一份取消注册表。

---

### 任务 10：阶段验收

- [ ] 运行针对性测试：

```powershell
npx vitest run src/main/agui-bridge.test.ts src/main/agui/*.test.ts
```

- [ ] 运行直接相关测试：

```powershell
npx vitest run src/main/orchestrator/harness-adapter.test.ts src/main/orchestrator/harness-adapter-cancel.test.ts src/main/orchestrator/run-settlement.test.ts
```

- [ ] 运行构建、全量测试和 diff（差异）检查：

```powershell
npm run build:main
npm test
git diff --check
```

- [ ] 人工复核三个关键不变量：

```text
session owner：acquire → abort/wait → compare-delete release
terminal：gate → success effects → sticker → RUN_FINISHED exactly once
cancel：AbortController → upstream cancelled terminal → complete cleanup
```

## 完成定义

- 原 `agui-bridge.ts` 的公开 API 与两个 IPC handler 保持可用。
- session guard 与 run finalizer 的 settled 状态在代码和测试中明确隔离。
- 所有事件继续带 canonical runId，sender/chatWindow 行为不变。
- 成功、错误、取消、超时、重复终态、同步 complete 和 takeover 竞态全部有覆盖。
- `successEffect → sticker → RUN_FINISHED` 被严格轨迹测试锁定。
- 针对性测试、相关跨模块测试、`npm run build:main` 与 `npm test` 全部通过。
