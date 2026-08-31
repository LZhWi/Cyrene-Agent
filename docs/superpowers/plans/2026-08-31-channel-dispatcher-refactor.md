# Channel Dispatcher 渐进式重构施工计划

> **执行者提示：** 本文只描述施工步骤。实现时逐项勾选；若由智能体执行，先加载 `superpowers:test-driven-development` 与 `superpowers:verification-before-completion`。

**目标：** 把 `src/main/channels/dispatcher.ts` 收敛为 compatibility facade（兼容门面）与短管线编排器，同时保持渠道会话、历史、日志、TTS（文本转语音）、贴纸和能力降级的全部可观察行为。

**架构：** `ChannelDispatcher` 继续拥有设置缓存和限速器；session route registry（会话路由注册表）只保留一份模块级状态；其他新模块均为无状态函数。`handleIncoming` 明确保留 `readHistory → writeUser → runAgent → writeAssistant` 调用轨迹，所有容错边界继续位于原来的阶段。

**技术栈：** TypeScript、Electron 主进程、Node.js `fs/path`、Vitest。

**总设计：** `docs/superpowers/specs/2026-08-30-god-file-refactor-design.md`

## 全局约束

- 保留 `dispatcher.ts` 当前全部公开导出、构造参数、类方法和模块级单例。
- `ChannelDispatcher` 仍是 `settingsCache` 与 `limiterCache` 的唯一所有者；不得把缓存复制到新模块。
- session 路由 `Map` 只能迁移一次，不能在门面和新模块各留一份。
- 不改变限速键、`sessionId` 算法、旧历史迁移键、历史窗口大小 `16`、日志字段和警告文本。
- 历史必须先读旧滑窗，再写当前 user；assistant 历史必须在能力降级前写入。
- agent 调用失败仍记录 error 日志并返回 `null`；历史、日志、镜像或 TTS 失败仍按当前规则降级或只告警。
- TTS 文件写入继续使用同步 `mkdirSync/writeFileSync`，目录、扩展名、MIME（媒体类型）和命名规则不变。
- 最终 capability downgrade（能力降级）仍是返回前最后一步，并继续返回新对象而不修改输入。
- 新模块不得反向导入 `channels/dispatcher.ts`。
- 不引入新依赖；优先复用现有 `message-log.ts`、`history-log.ts`、`proactive-delivery.ts` 和 `message-segmentation.ts`。

## 文件地图

- 新建 `src/main/channels/dispatcher/session-routing.ts`：sessionId、路由注册及原发送者查询；唯一持有 session 路由状态。
- 新建 `src/main/channels/dispatcher/incoming-message.ts`：入站镜像、日志、历史读取和 user 历史写入的无状态步骤。
- 新建 `src/main/channels/dispatcher/agent-reply.ts`：agent 调用、echo fallback（回退）和失败日志。
- 新建 `src/main/channels/dispatcher/outgoing-parts.ts`：文本分段、贴纸、消息对象和能力降级纯函数。
- 新建 `src/main/channels/dispatcher/tts-part.ts`：TTS 判定、结果规范化、缓存写入和 audio part。
- 新建 `src/main/channels/dispatcher/outgoing-effects.ts`：出站镜像、日志和 assistant 历史写入。
- 修改 `src/main/channels/dispatcher.ts`：保留 `ChannelDispatcher`、缓存、限速器、依赖注入 setter（设置函数）和兼容重导出。
- 新建 `src/main/channels/dispatcher-pipeline.test.ts`：锁定 `handleIncoming` 的调用轨迹与容错。
- 新建上述叶子模块的同名测试文件；保留现有 `dispatcher.test.ts` 和 `dispatcher-capability.test.ts`。

## 目标接口

以下签名是模块边界，不要求一次性全部公开给仓库其他调用方。

```ts
// session-routing.ts
export function makeSessionId(channel: ChannelId, chatId: string): string
export function recordSession(channel: ChannelId, senderId: string, sessionId: string): void
export function lookupOriginalSender(sessionId: string): {
  channel: ChannelId
  senderId: string
} | null

// incoming-message.ts
export interface IncomingMessageEffectsDeps {
  mirrorToDesktop: boolean
  broadcastChat?: DispatcherDeps["broadcastChat"]
  loadRecentChannelHistory?: DispatcherDeps["loadRecentChannelHistory"]
  shouldLoadHistory: boolean
}
export function mirrorIncomingMessage(msg: IncomingMessage, deps: IncomingMessageEffectsDeps): void
export function logIncomingMessage(msg: IncomingMessage): void
export function loadPriorChannelMessages(
  sessionId: string,
  deps: IncomingMessageEffectsDeps,
): Promise<ChatMessage[] | undefined>
export function appendIncomingHistory(sessionId: string, msg: IncomingMessage): void

// agent-reply.ts
export interface AgentReply {
  text: string
  sticker: string | null
}
export function runChannelAgent(
  msg: IncomingMessage,
  sessionId: string,
  priorMessages: ChatMessage[] | undefined,
  buildAndRunAgent: DispatcherDeps["buildAndRunAgent"],
): Promise<AgentReply | null>

// tts-part.ts
export interface AppendTtsPartInput {
  channel: ChannelId
  replyText: string
  enabled: boolean
  adapterSupportsAudio: boolean | undefined
  synthesizeTts: DispatcherDeps["synthesizeTts"]
}
export function appendChannelTtsPart(
  parts: OutgoingPart[],
  input: AppendTtsPartInput,
): Promise<void>

// outgoing-parts.ts
export function buildTextOutgoingParts(
  replyText: string,
  mode: MobileMessageSegmentationMode,
): OutgoingPart[]
export function appendStickerPart(
  parts: OutgoingPart[],
  stickerId: string | null,
  enabled: boolean,
): void
export function buildOutgoingMessage(msg: IncomingMessage, parts: OutgoingPart[]): OutgoingMessage
export function downgradeOutgoingMessage(
  msg: OutgoingMessage,
  capability: ChannelCapability | undefined,
): OutgoingMessage

// outgoing-effects.ts
export function mirrorOutgoingMessage(
  msg: IncomingMessage,
  replyText: string,
  mirrorToDesktop: boolean,
  broadcastChat?: DispatcherDeps["broadcastChat"],
): void
export function logOutgoingMessage(
  msg: IncomingMessage,
  replyText: string,
  parts: readonly OutgoingPart[],
): void
export function appendOutgoingHistory(sessionId: string, replyText: string): void
```

如果 TypeScript 因 `DispatcherDeps` 产生循环类型导入，应把共享的窄类型放入 `dispatcher/contracts.ts`，并由 `dispatcher.ts` 重导出；不要让叶子模块为了取类型反向导入门面。

---

### 任务 1：先锁定完整管线的旧行为

**文件：**

- 新建 `src/main/channels/dispatcher-pipeline.test.ts`
- 不改生产代码

- [ ] 使用临时目录模拟 Electron `app.getPath("userData")`，并 mock（模拟）日志、历史、广播、TTS 和 manager adapter。
- [ ] 构造一个启用镜像、TTS、贴纸和文本分段的 `ChannelDispatcher`，让各依赖向同一个 `trace: string[]` 记录语义步骤。
- [ ] 断言核心轨迹严格为：

```text
readHistory
writeUser
runAgent
writeAssistant
```

- [ ] 单独断言完整出站轨迹保持：agent 完成后先构造文本/TTS/贴纸，再 mirror outgoing、log outgoing、write assistant，最后调用能力降级。
- [ ] 增加“历史读取失败仍写 user 并无历史调用 agent”“agent 失败写 error log 并返回 null”“TTS 失败仍返回文本”“镜像失败不阻断”的特征测试。
- [ ] 增加“历史迁移使用 senderId 旧键到 chatId 新键”“QQ group 保留共享 chatId 但 agent 文本保留真实 sender”的断言。
- [ ] 运行：

```powershell
npx vitest run src/main/channels/dispatcher.test.ts src/main/channels/dispatcher-capability.test.ts src/main/channels/dispatcher-pipeline.test.ts
npm run build:main
```

- [ ] 在旧实现未提取前确认全部为绿色；若测试暴露真实缺陷，另开修复，不在本重构中改变行为。

---

### 任务 2：迁移唯一的 session 路由状态

**文件：**

- 新建 `src/main/channels/dispatcher/session-routing.ts`
- 新建 `src/main/channels/dispatcher/session-routing.test.ts`
- 修改 `src/main/channels/dispatcher.ts`

- [ ] 原样迁移 `sessionIndex`、TTL（存活时间）清理、`makeSessionId`、`recordSession` 和 `lookupOriginalSender`。
- [ ] 保持 hash 输入、前缀、截断长度、过期判断和 `lastAt` 更新时间完全一致。
- [ ] 门面显式重导出 `makeSessionId` 与 `lookupOriginalSender`；`recordSession` 只供门面管线内部使用。
- [ ] 删除门面中的旧 `Map`，用搜索确认状态只有一份：

```powershell
rg -n "sessionIndex|new Map" src/main/channels/dispatcher.ts src/main/channels/dispatcher
```

- [ ] 运行：

```powershell
npx vitest run src/main/channels/dispatcher/session-routing.test.ts src/main/channels/dispatcher.test.ts src/main/channels/dispatcher-pipeline.test.ts
npm run build:main
```

---

### 任务 3：提取无副作用的出站消息规则

**文件：**

- 新建 `src/main/channels/dispatcher/outgoing-parts.ts`
- 新建 `src/main/channels/dispatcher/outgoing-parts.test.ts`
- 修改 `src/main/channels/dispatcher.ts`
- 保留 `src/main/channels/dispatcher-capability.test.ts`

- [ ] 迁移 `buildTextOutgoingParts`，继续复用 `normalizeMobileMessageSegmentationMode` 和 `splitTextBySentenceBreaks`。
- [ ] 迁移贴纸路径解析与追加规则：设置关闭、ID 为空或路径解析失败时不添加 part。
- [ ] 提取 `buildOutgoingMessage`，逐字段保留 `channel/chatType/targetId/threadId/replyContext/parts`。
- [ ] 把 `downgradeToCapability` 的循环迁成纯函数 `downgradeOutgoingMessage`；类方法只委托该函数，保持公开 API（应用程序编程接口）不变。
- [ ] 覆盖 text/image/audio/file/video/card/sticker、最大长度、无 capability 和不修改原对象。
- [ ] 门面继续重导出 `buildTextOutgoingParts`；`resolveStickerImagePath` 若迁移则同样显式重导出。
- [ ] 运行：

```powershell
npx vitest run src/main/channels/dispatcher/outgoing-parts.test.ts src/main/channels/dispatcher-capability.test.ts src/main/channels/dispatcher-pipeline.test.ts
npm run build:main
```

---

### 任务 4：提取入站步骤与 agent 回复阶段

**文件：**

- 新建 `src/main/channels/dispatcher/incoming-message.ts`
- 新建 `src/main/channels/dispatcher/incoming-message.test.ts`
- 新建 `src/main/channels/dispatcher/agent-reply.ts`
- 新建 `src/main/channels/dispatcher/agent-reply.test.ts`
- 修改 `src/main/channels/dispatcher.ts`

- [ ] 将入站镜像和入站日志分别迁移成同步容错函数；保持各自独立的 `try/catch`，不能合并成一个大 `try`。
- [ ] 将历史读取迁为异步函数，只有 `buildAndRunAgent` 与 `loadRecentChannelHistory` 同时存在才读取；失败返回 `undefined`。
- [ ] 将 user 历史追加迁为独立同步容错函数，继续调用 `formatChannelUserText`。
- [ ] 将 agent 调用和 echo 分支迁入 `runChannelAgent`；有 agent 时异常必须追加 error 日志并返回 `null`，无 agent 时返回原 echo 文本。
- [ ] `handleIncoming` 保持显式顺序，不要把四步藏进一个无法审查的 `prepareIncoming()`：

```ts
const priorMessages = await loadPriorChannelMessages(...)
appendIncomingHistory(sessionId, msg)
const reply = await runChannelAgent(msg, sessionId, priorMessages, this.deps.buildAndRunAgent)
if (!reply) return null
```

- [ ] 运行：

```powershell
npx vitest run src/main/channels/dispatcher/incoming-message.test.ts src/main/channels/dispatcher/agent-reply.test.ts src/main/channels/dispatcher-pipeline.test.ts
npm run build:main
```

---

### 任务 5：提取 TTS 与出站副作用

**文件：**

- 新建 `src/main/channels/dispatcher/tts-part.ts`
- 新建 `src/main/channels/dispatcher/tts-part.test.ts`
- 新建 `src/main/channels/dispatcher/outgoing-effects.ts`
- 新建 `src/main/channels/dispatcher/outgoing-effects.test.ts`
- 修改 `src/main/channels/dispatcher.ts`

- [ ] 将 `shouldAppendChannelTtsAudio` 与 `normalizeTtsResult` 迁入 TTS 模块；门面重导出前者。
- [ ] 保持微信永不追加音频、adapter 必须显式支持 audio、空 Buffer 不追加、默认格式映射不变。
- [ ] 缓存写入路径继续是 `userData/channels/audio/<channel>-<timestamp><extension>`，仍同步创建目录和写文件。
- [ ] TTS 的判定日志、结果日志和失败警告保持现有文字；失败不抛出。
- [ ] 将出站 mirror、JSONL（逐行 JSON）日志和 assistant 历史写入拆为三个独立容错函数，不合并异常边界。
- [ ] 保持 `hasAttachments` 只根据 audio part 判断，附件路径不写入日志。
- [ ] 运行：

```powershell
npx vitest run src/main/channels/dispatcher/tts-part.test.ts src/main/channels/dispatcher/outgoing-effects.test.ts src/main/channels/dispatcher-pipeline.test.ts
npm run build:main
```

---

### 任务 6：收瘦门面并做阶段验收

**文件：**

- 修改 `src/main/channels/dispatcher.ts`
- 修改必要的测试 import，不迁移仓库调用方

- [ ] `handleIncoming` 只保留：限速、session 路由、入站阶段、agent 阶段、parts 阶段、出站阶段和最终降级。
- [ ] `settingsCache`、`limiterCache`、`reloadSettings`、所有依赖 setter 与 `channelDispatcher` 单例留在门面。
- [ ] 使用显式 `export { ... } from ...` 保持旧导入路径；不要用宽泛 `export *` 隐式扩大公开 API。
- [ ] 搜索反向依赖和重复实现：

```powershell
rg -n 'from "\.\./dispatcher"|from "\.\/dispatcher"' src/main/channels/dispatcher
rg -n "function (makeSessionId|buildTextOutgoingParts|shouldAppendChannelTtsAudio)|class RateLimiter" src/main/channels/dispatcher.ts src/main/channels/dispatcher
```

- [ ] 运行完整阶段验证：

```powershell
npx vitest run src/main/channels/dispatcher.test.ts src/main/channels/dispatcher-capability.test.ts src/main/channels/dispatcher-pipeline.test.ts src/main/channels/dispatcher/*.test.ts
npm run build:main
npm test
git diff --check
```

- [ ] 人工核对 `handleIncoming` 的四段关键轨迹、每个 `catch` 的覆盖范围和最后一行能力降级调用。

## 完成定义

- `dispatcher.ts` 仍是稳定入口，外部调用方无需改 import。
- session `Map`、设置缓存和限速器各只有一个所有者。
- 管线测试明确证明 `readHistory → writeUser → runAgent → writeAssistant`。
- agent/TTS/镜像/日志失败语义、贴纸与能力降级均与旧实现一致。
- 针对性测试、`npm run build:main` 和 `npm test` 全部通过。
