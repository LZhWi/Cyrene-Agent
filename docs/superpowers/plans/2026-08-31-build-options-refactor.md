# Build Options 渐进式重构施工计划

> **执行者提示：** 本文只描述施工步骤。实现时逐项勾选；若由智能体执行，先加载 `superpowers:test-driven-development` 与 `superpowers:verification-before-completion`。

**目标：** 把 `src/main/orchestrator/build-options.ts` 拆成附件、上下文、风格、能力、prompt（提示词）和运行后副作用模块，原路径继续提供完全相同的构建与收尾接口。

**架构：** `buildAgentRunOptions` 保留为总编排器。context assembly（上下文收集）只计算具名业务上下文；prompt assembly（提示词组装）只消费既有结果并决定顺序。fallback capabilities（回退能力）与 authoritative capabilities（权威能力）是两条刻意不同的兼容路径，必须继续分开。`onAgentRunFinished` 只委托收尾模块，原副作用顺序不变。

**技术栈：** TypeScript、Electron 主进程、Vitest；复用现有 `run-capabilities.ts`、`prompt-layers.ts`、`system-prompt-builder.ts`、工具/Skill（技能）注册表及搜索过滤器，不引入新的编排框架或提示词库。

**总设计：** `docs/superpowers/specs/2026-08-30-god-file-refactor-design.md`

## 全局约束

- 保留 `BuildOptionsDeps`、`OnRunFinishedDeps`、三个 Lite 设置类型、`buildChannelSystem`、`buildAgentRunOptions` 和 `onAgentRunFinished` 的旧导入路径与签名。
- 不改变错误文本、默认值、日志、性能埋点名称、依赖调用次数和 `await`（等待异步完成）边界。
- 不改变 `options` 的字段、闭包、Set（集合）成员、消息内容、图片块、prompt 分层或字符串拼接顺序。
- `context-assembly.ts` 不拼 stable/session/mode/runtime layer（稳定/会话/模式/运行时层），也不决定最终顺序。
- `prompt-assembly.ts` 不调用 relationship、social、CITA 或 environment 依赖，也不重新计算任何业务上下文。
- fallback 与 authoritative 两条能力路径不合并、不“去重”；两条路径的过滤条件和覆盖时机保持原样。
- 计划只读仍有两层防护：本模块构建时过滤是第一层，Harness 运行时权限检查是第二层。
- 图片直发只由 `settings.multimodal !== false` 决定；不新增 provider/model 静态能力表。
- 新模块不得反向导入 `orchestrator/build-options.ts`。
- 本阶段不重写 prompt 内容，不优化重复的设置读取，不调整性能；这些都是独立变更。

## 文件地图

- 新建 `src/main/orchestrator/run-options/types.ts`：共享依赖和轻量设置类型。
- 新建 `src/main/orchestrator/run-options/image-attachments.ts`：图片读取、直发、caption（图片描述）与失败占位。
- 新建 `src/main/orchestrator/run-options/context-assembly.ts`：always-on、relationship、environment、social 和 CITA 上下文。
- 新建 `src/main/orchestrator/run-options/style-resolution.ts`：styleId 兼容、风格块与采样参数。
- 新建 `src/main/orchestrator/run-options/capability-resolution.ts`：工具、Skill、搜索、计划只读及双能力路径。
- 新建 `src/main/orchestrator/run-options/prompt-assembly.ts`：stable prefix（稳定前缀）、runtime context（运行时上下文）和 usage parts（用量分层）。
- 新建 `src/main/orchestrator/run-options/finished-effects.ts`：记忆、社交原子、关系、运行状态和贴纸副作用。
- 修改 `src/main/orchestrator/build-options.ts`：保留兼容导出和总编排。
- 新建 `src/main/orchestrator/build-options-characterization.test.ts`：固定输入下的逐字段黄金对照与依赖调用轨迹。
- 为各叶子模块新建同名测试文件；保留现有 `build-options.test.ts`。

## 数据边界

```ts
// context-assembly.ts
export interface AssembledRunContexts {
  alwaysOnContext: string
  relationshipContext: string
  environmentContext: string
  socialContextBlock: string
  citaContextBlock: string
}

export interface SocialContextResult {
  contextBlock: string
  retrievedAtoms: SocialAtom[]
}

export interface CitaContextResult {
  contextBlock: string
  contextualizedQuery: string
  responseContext: string
  trustedRefs: string[]
}

export interface ContextAssemblyResult {
  contexts: AssembledRunContexts
  social: SocialContextResult
  cita: CitaContextResult
}

export interface ContextAssemblyInput {
  latestUserText: string
  conversationId: string
  isChatMode: boolean
  messages: ChatMessage[]
  slimMessages: Array<{ role: string; content?: string }>
  profile: UserProfileLite
  model: Pick<ModelSettingsLite, "provider" | "model">
  socialContextEnabled: boolean
}
```

`ContextAssemblyResult` 中的 metadata（元数据）只供后续 options 字段和收尾信息使用；`prompt-assembly.ts` 只读取 `contexts`，不得凭 `retrievedAtoms` 或 CITA 引用重新查询上下文。

```ts
// style-resolution.ts
export interface ResolvedRunStyle {
  styleId: StyleId
  stylePromptBlock: string
  soulSampling: ApprovedStyleSampling | undefined
}
export function resolveRunStyle(input: {
  request: AguiRunInput
  mode: ConversationMode
  settings: ModelSettingsLite
  styleSettings: StyleSettingsLite
  readStylePrompt: BuildOptionsDeps["readStylePrompt"]
  resolveSoulSampling: BuildOptionsDeps["resolveSoulSampling"]
}): ResolvedRunStyle

// capability-resolution.ts
export interface ResolvedRunCapabilityContext {
  capabilities: RunCapabilities
  runTools: ToolDefinition[]
  enabledSkills: ReadonlyArray<unknown>
  skillCatalog: string
  autoInjectedSkillContext: string
  autoInjectedSoulContext: string
  availableSkills: SkillRouteInfo[]
  skillActivation: string
  planSkillContext: string | undefined
  activeSearchBackend: SearchBackend
}

// prompt-assembly.ts
export interface PromptAssemblyInput {
  mode: ConversationMode
  contexts: AssembledRunContexts
  channelSystem: string
  conversationTimeContext: string
  attachmentContext: string
  stylePromptBlock: string
  toneInjection: string
  skillActivation: string
  autoInjectedSoulContext: string
  skillCatalog: string
  autoInjectedSkillContext: string
  baseSoulSystemPrompt: string
  baseToolSystemPrompt: string
  resolvedWorkspaceRoot?: string
  workspaceMeta?: { projectName: string; isGitRepo: boolean }
}

export interface AssembledPromptContent {
  soulSystemBaseContent: string
  soulRuntimeContext: string
  toolSystemContent: string
  skillLayerContent: string
}
```

如果某类型只在一个叶子模块内部使用，就留在该模块；只有被两个以上模块消费的类型才进入 `types.ts`，避免制造新的“类型上帝文件”。

---

### 任务 1：建立黄金对照和依赖调用轨迹

**文件：**

- 新建 `src/main/orchestrator/build-options-characterization.test.ts`
- 不改生产代码

- [ ] 从现有 `createBuildDeps()` 提取或复制一个稳定 fixture（测试夹具），固定时间、工作区、用户画像、设置、工具、Skill、social、CITA、图片和 embedding（向量嵌入）返回值。
- [ ] 对 Chat、Work、Code、Learn 各构建一次，保存以下规范化投影的 inline snapshot（内联快照）：

```ts
const projection = {
  latestUserText,
  messages: options.messages,
  cleanMessages: options.cleanMessages,
  tools: options.tools?.map((tool) => tool.id),
  capabilityTools: options.capabilities?.tools.map((tool) => tool.id),
  capabilitySkills: [...(options.capabilities?.skillIds ?? [])],
  toolSystemContent: options.toolSystemContent,
  skillLayerContent: options.skillLayerContent,
  soulSystemBaseContent: options.soulSystemBaseContent,
  soulRuntimeContext: options.soulRuntimeContext,
  runtimeEnvironmentContext: options.runtimeEnvironmentContext,
  soulSampling: options.soulSampling,
  contextualizedQuery: options.contextualizedQuery,
  citaContextBlock: options.citaContextBlock,
  responseContext: options.responseContext,
  trustedRefs: options.trustedRefs,
  planSkillContext: options.planSkillContext,
  availableSkills: options.availableSkills,
  socialContext: options.socialContext,
}
```

- [ ] 对闭包字段单独调用并断言结果，不能只 snapshot 函数身份；至少覆盖图片 fallback、permission 与请求澄清相关闭包。
- [ ] 用 `trace` 锁定上下文依赖调用次数和先后关系，尤其是 always-on、relationship、environment、social、CITA、tone。
- [ ] 明确断言 authoritative resolver 存在时仍先构建 fallback 所需值、随后以 authoritative 结果覆盖；这就是当前兼容行为。
- [ ] 运行：

```powershell
npx vitest run src/main/orchestrator/build-options.test.ts src/main/orchestrator/build-options-characterization.test.ts
npm run build:main
```

---

### 任务 2：先迁移类型，不迁移行为

**文件：**

- 新建 `src/main/orchestrator/run-options/types.ts`
- 修改 `src/main/orchestrator/build-options.ts`

- [ ] 原样迁移 `BuildOptionsDeps`、`OnRunFinishedDeps`、`ModelSettingsLite`、`StyleSettingsLite`、`UserProfileLite`。
- [ ] 保持每个可选字段、deprecated（弃用）注释、宽类型和动态 import 类型不变；本阶段不“顺手增强”类型。
- [ ] `build-options.ts` 使用显式 type re-export（类型重导出）保持旧路径：

```ts
export type {
  BuildOptionsDeps,
  OnRunFinishedDeps,
  ModelSettingsLite,
  StyleSettingsLite,
  UserProfileLite,
} from "./run-options/types"
```

- [ ] 用 `import type` 消除运行时依赖，检查没有循环：

```powershell
rg -n 'from "\.\./build-options"|from "\.\/\.\.\/build-options"' src/main/orchestrator/run-options
npx vitest run src/main/orchestrator/build-options.test.ts src/main/orchestrator/build-options-characterization.test.ts
npm run build:main
```

---

### 任务 3：提取图片附件策略

**文件：**

- 新建 `src/main/orchestrator/run-options/image-attachments.ts`
- 新建 `src/main/orchestrator/run-options/image-attachments.test.ts`
- 修改 `src/main/orchestrator/build-options.ts`

- [ ] 原样迁移 `contentToText` 中图片阶段需要的最小辅助逻辑、直发 content block、caption 降级和失败占位消息。
- [ ] 对外提供一个高层函数，保证 clean 与 timestamped 两组消息采用同一策略：

```ts
export async function attachRunImages(input: {
  request: AguiRunInput
  cleanMessages: ChatMessage[]
  timestampedMessages: ChatMessage[]
  directVision: boolean
  captionImageForFallback?: BuildOptionsDeps["captionImageForFallback"]
  imageCaptionFallbackContext: string
}): Promise<{
  messages: ChatMessage[]
  cleanMessages: ChatMessage[]
  imageCaptionFallback: ChatMessage[] | undefined
}>
```

- [ ] 保持图片附着在最后一条 user message、文件校验、base64 data URL、MIME、caption 文本和占位语句完全一致。
- [ ] `directVision` 仍等于 `settings.multimodal !== false`；服务端拒绝直发后的 fallback 闭包行为不变。
- [ ] 保留现有 `[image-send]` 日志字段和值。
- [ ] 运行：

```powershell
npx vitest run src/main/orchestrator/run-options/image-attachments.test.ts src/main/orchestrator/build-options.test.ts src/main/orchestrator/build-options-characterization.test.ts
npm run build:main
```

---

### 任务 4：提取业务上下文收集

**文件：**

- 新建 `src/main/orchestrator/run-options/context-assembly.ts`
- 新建 `src/main/orchestrator/run-options/context-assembly.test.ts`
- 修改 `src/main/orchestrator/build-options.ts`

- [ ] 按原顺序迁移 always-on、relationship、environment、social、CITA 的构建与各自 `try/catch`。
- [ ] 保持 `perf.track/begin/end` 的名称与覆盖范围；environment 的同步计时不能改成异步。
- [ ] social 只在 Chat、开关为 true、依赖存在时执行；仍截取最多 5 个 atoms（原子）。
- [ ] CITA 只在非 Chat 且依赖存在时执行；recent dialogue 仍取最后 12 条 user/assistant，引用去重顺序保持不变。
- [ ] 任一上下文失败时只清空该块，不影响其他块；不要用一个总 `Promise.all` 改变顺序和日志。
- [ ] 测试 `ContextAssemblyResult.contexts` 不包含任何 prompt 分隔符或层级拼接结果。
- [ ] 搜索证明该模块没有 prompt 组装依赖：

```powershell
rg -n "stablePrefix|promptLayers|toolSystemContent|soulRuntimeContext" src/main/orchestrator/run-options/context-assembly.ts
```

预期：无匹配。

- [ ] 运行针对性测试与构建。

---

### 任务 5：提取风格与能力解析

**文件：**

- 新建 `src/main/orchestrator/run-options/style-resolution.ts`
- 新建 `src/main/orchestrator/run-options/style-resolution.test.ts`
- 新建 `src/main/orchestrator/run-options/capability-resolution.ts`
- 新建 `src/main/orchestrator/run-options/capability-resolution.test.ts`
- 修改 `src/main/orchestrator/build-options.ts`

- [ ] 风格模块迁移 legacy style filename（旧风格文件名）到 styleId 的兼容解析、Markdown 包裹和 sampling 决策。
- [ ] 保持 Work/Code 不受 style 影响；Chat/Learn 的 default 不设置自定义 sampling；非 default 才调用 resolver。
- [ ] 能力模块继续先计算 fallback 的工具、Skill、目录和自动注入文本，再在 resolver 存在时用 authoritative capabilities 覆盖并重算 Skill 派生物。
- [ ] 保持 Chat 工具严格 opt-in、搜索后端互斥、plan read-only 风险过滤、slash activation 和 plan Skill runtime 注入条件。
- [ ] 直接复用现有 `filterToolsBySearchBackend`、`policyFor`、`isPlanReadOnly/getPlanState`；不要复制通用过滤算法。
- [ ] 测试同时覆盖 resolver 缺失和存在，断言两条路径的工具 ID、Skill ID、调用次数与文本结果。
- [ ] 运行：

```powershell
npx vitest run src/main/orchestrator/run-options/style-resolution.test.ts src/main/orchestrator/run-options/capability-resolution.test.ts src/main/orchestrator/build-options.test.ts src/main/orchestrator/build-options-characterization.test.ts
npm run build:main
```

---

### 任务 6：提取纯提示词组装

**文件：**

- 新建 `src/main/orchestrator/run-options/prompt-assembly.ts`
- 新建 `src/main/orchestrator/run-options/prompt-assembly.test.ts`
- 修改 `src/main/orchestrator/build-options.ts`

- [ ] 先把现有字符串表达式逐字迁移，不重排、不抽象分隔符、不改空白。
- [ ] 组装并返回 `skillLayerContent`、`toolSystemContent`、`soulSystemBaseContent`、`soulRuntimeContext`；顺序必须与黄金对照一致。
- [ ] 工作区提示、时间政策段、渠道 system、风格、Skill、tone、附件和各上下文的相对位置保持不变。
- [ ] `prompt-assembly.ts` 只能接收值，不得接受 `BuildOptionsDeps`，从类型层面禁止重新查询业务上下文。
- [ ] 用固定输入逐字符串断言，而不只检查 `contains`（包含）。
- [ ] 搜索证明职责纯净：

```powershell
rg -n "buildRelationship|buildChatSocial|prepareCita|buildEnvironment|buildAlwaysOn" src/main/orchestrator/run-options/prompt-assembly.ts
```

预期：无匹配。

- [ ] 运行针对性测试、原 facade（门面）测试和构建。

---

### 任务 7：提取运行结束副作用

**文件：**

- 新建 `src/main/orchestrator/run-options/finished-effects.ts`
- 新建 `src/main/orchestrator/run-options/finished-effects.test.ts`
- 修改 `src/main/orchestrator/build-options.ts`

- [ ] 整体迁移 `onAgentRunFinished` 的内部逻辑，函数签名保持：

```ts
export async function applyRunFinishedEffects(
  result: CyreneRunResult,
  latestUserText: string,
  deps: OnRunFinishedDeps,
  channel?: ChannelId,
  conversationId?: string,
): Promise<{ sticker: string | null }>
```

- [ ] 保持 document model context（文档模型上下文）剥离、记忆/社交二选一、关系记录、运行状态、广播和贴纸匹配的顺序及 fire-and-forget（发出后不等待）语义。
- [ ] 继续使用最新 sticker embedding index；代码或数学内容仍跳过贴纸 embedding。
- [ ] `onAgentRunFinished` 作为兼容函数只委托该模块，不改变返回值。
- [ ] 将现有测试中 667 行以后的收尾用例迁移或复用到新模块测试；原门面至少保留一条委托集成测试。
- [ ] 运行：

```powershell
npx vitest run src/main/orchestrator/run-options/finished-effects.test.ts src/main/orchestrator/build-options.test.ts
npm run build:main
```

---

### 任务 8：收瘦总编排器并做阶段验收

**文件：**

- 修改 `src/main/orchestrator/build-options.ts`
- 修改必要测试 import，不迁移仓库调用方

- [ ] `buildAgentRunOptions` 只保留输入验证、基础派生、依次调用各阶段、构造最终 `CyreneRunOptions` 和返回 `latestUserText`。
- [ ] 保留现有依赖读取次数；特别是 `loadGeneralSettings()` 的重复调用如属当前行为，不在本次重构顺手合并。
- [ ] 使用显式重导出保持旧 API；叶子模块不通过门面取类型或函数。
- [ ] 对最终 options 运行黄金对照，确认 prompt、消息、闭包和 capability Set 逐字段一致。
- [ ] 检查反向依赖、循环和占位：

```powershell
rg -n 'from "\.\./build-options"|from "\.\/\.\.\/build-options"' src/main/orchestrator/run-options
rg -n "TODO|TBD|implement later|待实现" src/main/orchestrator/run-options src/main/orchestrator/build-options.ts
```

- [ ] 运行完整阶段验证：

```powershell
npx vitest run src/main/orchestrator/build-options.test.ts src/main/orchestrator/build-options-characterization.test.ts src/main/orchestrator/run-options/*.test.ts
npx vitest run src/main/orchestrator/build-memory-injection.test.ts src/main/orchestrator/run-capabilities.test.ts src/main/orchestrator/prompt-layers.test.ts
npm run build:main
npm test
git diff --check
```

## 完成定义

- 原 `build-options.ts` 仍是稳定入口，公开类型与函数签名不变。
- context assembly 只收集语义块，prompt assembly 只排列和组装，两者没有反向调用。
- fallback 与 authoritative 能力路径都有独立测试，未被合并。
- 四种模式的黄金投影、图片策略和收尾副作用与旧实现一致。
- 针对性测试、跨模块测试、`npm run build:main` 和 `npm test` 全部通过。
