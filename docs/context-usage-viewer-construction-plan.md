# 上下文容量观看器施工文档

> 施工范围：上下文容量观看器（环形控件 + 占比菜单）+ 全链路过时注释勘误（一起修）。
> 版本：v2（已并入外部 review 修订：终态快照、写放大规避、分类优先级钉死、边界条件）。

---

## 背景

用户希望在 chat 窗口 composer footer 加一个上下文容量观看器：

- 一个小圆环：底色浅、亮色标识进度，直观显示当前上下文占模型窗口的比例。
- 点击圆环弹出菜单，展示上下文里各部分的 token 占比。
- 分类简化为 5 条：**系统提示词 / 工具定义与 Skill 目录 / 运行时上下文与工具日志 / 对话历史 / 其他**。
- 刷新时机：**每轮请求发出前刷新（实时，内存态）+ run 终态再补一次（持久化）**。终态快照包含最后一轮 assistant 回复，保证"当前上下文占用"语义成立——若只拍请求前快照，最终回复永远少算一轮。

调研过程中发现：`cyrene-agent.ts`、`build-options.ts` 等文件的注释仍描述**已删除的双阶段 FC 循环**（工具阶段/Soul 阶段），误导了对现有架构的理解。经用户确认，注释勘误合并进本文档一起修。

---

## 目标与非目标

### 目标

1. 主进程在每轮 LLM 请求发出前拍摄上下文快照，按 5 类拆分 token 估算。
2. 快照随现有 AG-UI 事件流推送到渲染层，落在 assistant 消息上（随消息持久化，切换会话/重启后仍可见）。
3. composer footer 新增环形控件，点击弹出占比菜单。
4. 修正全链路描述"双阶段循环"的过时注释（纯注释，零行为变更）。

### 非目标

- 不做精确 tokenizer（沿用现有 `estimateTokens` 字符折算，菜单中标注"估算值"）。
- 不新增 IPC invoke/pull 通道（快照完全 riding 现有 AG-UI 事件流 + 消息持久化）。
- 不做上下文编辑/清理操作（纯只读观看器）。
- 不改动上下文压缩逻辑本身。

---

## 现状核对：单循环架构事实（含误导来源）

施工前核对的**真实架构**（以代码为准，注释不可信）：

1. **Work/Code/Learn 模式**：`cyrene-agent.ts` → `harness-adapter.ts` → `cyrene-harness.ts` 单循环。
   - `buildHarnessPromptLayers` 把 `soulSystemBaseContent`（人设）+ `cyrene_harness.md` + Todo 策略 + `toolSystemContent`（工具规则/目录/Skill 清单）+ `tool_usage.md` 拼成**一份 stablePrefix**。
   - `soulRuntimeContext` / CITA / 恢复上下文等动态事实在 run 启动时一次性物化为 internal transcript 消息（`materializeHarnessStartTranscript`），此后每轮请求携带同一份 stablePrefix + tools schema + 完整 transcript。
   - 工具结果以 `role:tool` 消息写回 transcript；每轮流式调用 LLM；mid-loop compaction 每轮检查（阈值 0.7）。
2. **Chat 模式**：`chat-loop.ts` 单请求。stablePrefix = `soulSystemBaseContent`；runtimeContext 以 `<runtime_context>` user 消息追加在请求尾部（`composePromptLayers`）；无 tools；压缩阈值 0.8（`compressConversation`）。
3. **误导来源**：`function-calling.ts`（双阶段循环）已在 92c46c4 删除，但其架构描述残留在注释里——"工具阶段只携带 tool_system"、"Soul 阶段只携带 soul_systemBase"、"FC 循环 stream:false 拿全文"等均为**过时描述**。实际不存在两个阶段，也不存在非流式 FC 循环。

---

## 注释勘误清单（Phase 0，一起修）

纯注释/测试名修改，零行为变更。口径统一为：**单循环、stablePrefix 分层组装、工具结果写回 transcript、动态事实物化为 internal 消息**。

| 文件 | 位置 | 现状（错误） | 改为 |
|---|---|---|---|
| `src/main/orchestrator/cyrene-agent.ts` | L5 头注释 | "工具阶段只携带 tool_system + tools schema；Soul 阶段只携带 soul_systemBase + 工具结果摘要" | "Harness 单循环：每轮携带同一份 stablePrefix（人设+工具规则）+ tools schema + transcript；工具结果以 role:tool 消息写回 transcript" |
| 同上 | L9-10 头注释 | "FC 循环仍是 stream:false 一次性拿全文…"（描述已删除的 function-calling.ts） | "Chat 循环流式输出（SDK 流 + 非流式兜底）；Harness 每轮流式调用 LLM" |
| 同上 | L108 | "FC 循环按阶段动态注入" | "system 由 chat-loop / harness-adapter 按 promptLayers 组装，不随消息持久化" |
| 同上 | L134-137 | "工具阶段使用的 system prompt" / "Soul 阶段使用的基础 system prompt（人设 + 环境/记忆/关系/附件）" | "工具规则与目录（拼进 stablePrefix）" / "人设基础 system prompt（仅人设/渠道；环境/记忆/关系/附件在 soulRuntimeContext，随请求尾部注入）" |
| 同上 | L186 / L357 | "FC 循环最终结果" / "跑 FC 循环" | "Agent run 最终结果" / "跑 Agent 循环" |
| `src/main/orchestrator/build-options.ts` | L103 / L105 | "工具阶段 system prompt" / "第一期：Soul 阶段…执行前动态追加" | "工具规则与目录 system prompt（进入 harness stablePrefix）" / "人设基础 system prompt；动态内容走 soulRuntimeContext" |
| 同上 | L684-686 | "第一期：保留旧 systemContent 兼容…工具阶段：工具规则 + …" | 描述 stablePrefix 组成：工具规则 + 工具目录 + Skill 清单，与人设层一起进 stablePrefix |
| 同上 | L699-701 | "工具结果以 role:tool 协议消息随对话历史进入 Soul 阶段" | "工具结果以 role:tool 消息写回单循环 transcript" |
| 同上 | L719 | "FC 循环按阶段动态注入" | 同 cyrene-agent.ts L108 口径 |
| `src/main/orchestrator/context-manager.ts` | L78 | "system prompt（Tool/Soul 阶段不同）" | "system prompt（chat 模式为 soulSystemBaseContent）" |
| `src/main/orchestrator/system-prompt-builder.ts` | L64-68 / L80-87 | "工具阶段使用的 system prompt" / "Soul 阶段使用的基础 system prompt…第一期/第二期拆分" | 同 build-options 口径，删除"第一期/第二期"分期描述 |
| `src/main/skills/skill-catalog.ts` | L71-74 | "Soul 阶段没有工具能力…TOOL_PHASE" | "chat 模式没有工具能力，只注入 Skill 明确声明的回复策略小节" |
| `src/main/index.ts` | L425 | "CyreneAgent 跑 FC 循环" | "CyreneAgent 跑 Agent 循环" |
| `src/main/orchestrator/build-options.test.ts` | L170 测试名 | "messages 不含 system，FC 循环按阶段动态注入" | "messages 不含 system，由循环层组装 system" |

保留不动（语义仍准确）：`think-filter.ts` L12（"多轮 FC 循环"泛指函数调用循环，harness 仍是）、`skill-tools.ts`（描述 harness 循环内行为，无阶段概念）、`tool-catalog.ts` L5（"LLM 选择工具的第一层参考"，无阶段误导）。

---

## 设计

### 数据流

快照分两种 phase，职责严格分离：

- **`preRequest`（每轮请求发出前）**：准确代表"这一轮真正送给模型的 input context"。只更新 renderer 内存态，环形 UI 实时刷新，**零 I/O**。
- **`terminal`（run 终态）**：final assistant 回复已写入 transcript 后补拍，代表"run 结束后的完整上下文"（≈ 下一轮请求会吃多少）。挂在 assistant 消息上持久化，**一次落盘**。

```
主进程                                              渲染层
─────────────────────────────────────────────      ─────────────────────────────
cyrene-harness.ts 主循环
  每轮 compaction 后、callLLM 前：
    buildContextUsageSnapshot(phase:"preRequest")
      onEvent({type:"context_usage"})        ──►   ChatPage.handleEvent
                                                       CUSTOM "cyrene.context.usage"
  finish()（正常/超时/错误终态统一出口）：
    buildContextUsageSnapshot(phase:"terminal")       phase==="preRequest"
      onEvent({type:"context_usage"})        ──►     └ updateMessage(assistantId,
                                                        { contextUsage })  ← 纯内存
harness-adapter.ts                                    （已核实：updateMessage 仅
  sendHarnessEventAsAgui: CUSTOM                       setMessagesBySession，零 I/O）
    "cyrene.context.usage"
                                                  phase==="terminal"
chat-loop.ts                                          └ updateMessage + checkpointRun
  压缩后、请求前：preRequest 快照                ←   （一次落盘；用 debounce 版本，
  拿到 reply 后：对 messages+[assistant]              与 RUN_FINISHED 的 terminal
    拍 terminal 快照                                   checkpoint 合并写盘）
  cyrene-agent.toAguiEvent:
    CUSTOM "cyrene.context.usage"

                                                     ChatComposer footer
                                                       └ <ContextUsageRing usage=
                                                         当前会话最后一条 assistant
                                                         消息的 contextUsage />
```

要点：

- **不新增 IPC 通道**。快照 riding 现有 AG-UI 事件流（与 `cyrene.round`、`cyrene.todo` 同链路）。
- **写放大规避（review 修订 #2）**：`checkpointRun(_, true)` 会全量序列化会话并 `store.upsert` 写盘（ChatPage.tsx L1002-1024 已核实）。若每轮 preRequest 快照都触发它，15 轮 run = 15 次全量写盘，且上下文越大写得越重。因此：**preRequest 事件只走 `updateMessage`（纯 React 状态，零 I/O）；仅 `terminal` 快照触发一次持久化**，且使用非 immediate 的 debounce 版本（350ms 合并进紧随其后的 RUN_FINISHED terminal checkpoint，理想情况下只写一次盘）。
- **持久化语义**：`terminal` 快照落在 assistant 消息的 `contextUsage` 字段（与 `agentRounds` 同模式）。切换会话、重启后圆环显示最近一次终态快照。被取消的 run 无终态快照，其消息的 `contextUsage` 停留在最后一轮 preRequest（未落盘则重启后无快照，圆环不显示，下一轮对话后自然恢复——可接受）。
- **cancelled 路径不拍终态快照**（`buildCancelledResult` 直接返回）：取消时不需要精确终态，且避免在取消竞态里多发事件。

### 分类口径（5 类）

| 类别 key | 中文名 | 归属内容 |
|---|---|---|
| `systemPrompt` | 系统提示词 | 人设层文本：`soulSystemBaseContent` + `cyrene_harness.md` + Todo 策略（chat 模式仅 `soulSystemBaseContent`） |
| `toolDefinitions` | 工具定义与 Skill 目录 | `toolSystemContent`（工具规则+目录+Skill 路由清单）+ `tool_usage.md` + 全部工具 schema 折算 token |
| `runtimeAndToolLogs` | 运行时与工具日志 | internal transcript 消息（`visibility === "internal"`，含物化的 runtimeContext 与已 invoke 的 Skill 正文）+ `role:"tool"` 消息 + chat 模式请求尾部 `<runtime_context>` 注入 |
| `conversation` | 对话历史 | 普通 user/assistant 消息 + 压缩检查点（compaction checkpoint）+ chat 压缩摘要消息 |
| `other` | 其他 | 每条消息 +4 的角色/格式开销等兜底 |

**命名说明（review 修订 #6）**：`toolDefinitions` 只统计"固定工具定义 + Skill 目录"；被 `invoke_skill` 真正加载的 Skill 正文以 internal transcript 消息存在，归入 `runtimeAndToolLogs`。第一版不为此改 transcript 数据结构（不加 `contextCategory` 元数据），靠命名表达准确语义。

**消息分类判定优先级（review 修订 #3，钉死）**：

```
1. compaction checkpoint（role:system 且内容含 <cyrene_compaction_checkpoint> 标记）
   → conversation                      （优先级最高，杜绝与 internal 规则打架）
2. role === "tool"
   → runtimeAndToolLogs
3. visibility === "internal"
   → runtimeAndToolLogs
4. role === "user" / "assistant" / 其余 system
   → conversation
5. 其余未识别形状
   → other（仅格式开销兜底计入）
```

已核实：当前 `buildCompactionCheckpoint` 返回 `{ role: "system", content: "..." }`，**无 `visibility` 字段**，按上述顺序落入 conversation 正确。判定函数从 `compaction.ts` 导出单一事实源（导出 `COMPACTION_CHECKPOINT_OPEN` 常量或 `isCompactionCheckpointMessage(message)` 帮助函数），`context-usage.ts` 复用，禁止重复实现标记字符串匹配。单测需直接钉死优先级用例（尤其"同一条消息同时命中多条规则时取第 1 条"）。

### 快照结构与计算

新增 `src/shared/context-usage.ts`（共享类型，main/preload/renderer 三端可用）：

```ts
export type ContextUsageCategoryKey =
  | "systemPrompt" | "toolDefinitions" | "runtimeAndToolLogs"
  | "conversation" | "other";

export interface ContextUsageCategory {
  key: ContextUsageCategoryKey;
  tokens: number;
}

export type ContextUsagePhase = "preRequest" | "terminal";

export interface ContextUsageSnapshot {
  /** 快照阶段：请求前（每轮，仅内存态展示）或 run 终态（含最终回复，持久化）。 */
  phase: ContextUsagePhase;
  /** 拍摄快照的 runId（chat 模式可缺省）。 */
  runId?: string;
  /** harness 轮次序号；chat 恒 0。 */
  round?: number;
  /** 模型档案的上下文窗口（Token）。 */
  contextWindowTokens: number;
  /** 估算总输入 token（= Σ categories）。 */
  totalTokens: number;
  categories: ContextUsageCategory[];
  /** 消息条数（含 internal/tool），便于排查膨胀来源。 */
  messageCount: number;
  updatedAt: number;
}
```

新增 `src/main/orchestrator/context-usage.ts`：

```ts
export function buildContextUsageSnapshot(input: {
  phase: ContextUsagePhase;
  runId?: string;
  round?: number;
  contextWindowTokens: number;
  /** 人设层文本（系统提示词类）。 */
  personaContent: string;
  /** 工具规则/目录/使用规范文本；缺省为空。 */
  toolLayerContent?: string;
  /** 工具 schema 列表；chat 模式不传。 */
  toolSpecs?: Array<{ name: string; description: string; parameters: object }>;
  /** chat 模式请求尾部注入的 runtime context 文本；harness 模式不传（已物化进消息）。 */
  runtimeContext?: string;
  /**
   * 本轮基础消息列表。
   * 不变量（review 修订 #4）：chat 模式不得包含 composePromptLayers 追加的
   * <runtime_context> 尾部消息——runtimeContext 由独立参数计量，否则双重计数。
   * harness 模式传主循环当前 messages（含 internal/tool 消息，不含 system 头）。
   */
  messages: ChatMessage[];
}): ContextUsageSnapshot
```

计算规则（全部复用 `context-manager.ts` 现有估算函数）：

- 文本类：`estimateTokens(text)`；工具 schema：`estimateTokens(name + description + JSON.stringify(parameters))`（与 `computeTokenBudget` 同公式）。
- 消息逐条按**判定优先级**（见上节）归类；每条消息 +4 计入 `other`。
- `totalTokens = Σ categories`；百分比 = `totalTokens / contextWindowTokens`（边界处理见 UI 节）。

### 事件链路改动

1. `harness/types.ts`：
   - `HarnessEvent` 新增 `{ type: "context_usage"; snapshot: ContextUsageSnapshot }`。
   - `HarnessInput` 新增可选 `usageParts?: { personaContent: string; toolLayerContent: string }`（人设层/工具层文本拆分，供快照分类）。
2. `harness-adapter.ts`：
   - `buildHarnessPromptLayers` 返回值附加 `usageParts` 字段（内部同一份 parts 列表派生，避免二次拼串）：persona 桶 = `soulSystemBaseContent` + harness 人设 + Todo 策略；tool 桶 = `toolSystemContent` + `tool_usage.md`。
   - `runHarnessWithAdapter` 把 `usageParts` 传入 HarnessInput。
   - `sendHarnessEventAsAgui` 新增 `context_usage` case → `CUSTOM "cyrene.context.usage"`（value=snapshot，带 threadId/runId）。
3. `cyrene-harness.ts`：
   - **preRequest**：主循环内 compaction 之后、`callLLM` 之前构建快照并 `onEvent` 发射（位置紧邻现有 `computeTokenBudget`，两者输入一致）。
   - **terminal（review 修订 #1）**：在 `finish()` 函数内（正常结束 / 超时兜底 / LLM error / checkpoint failure 的统一出口）补拍一次终态快照——此时 final assistant 消息已 push 进 `messages`，快照包含最终回复。`cancelled` 路径（`buildCancelledResult`）不拍。
4. `chat-loop.ts`：
   - **preRequest**：`compressConversation` 之后、构建请求之前发射一次（`personaContent = soulSystemBaseContent`，`runtimeContext = options.runtimeContext`，无 toolSpecs；messages 为压缩后的原始消息，不含 `<runtime_context>` 尾部——见参数不变量）。
   - **terminal**：拿到 `reply` 后，对 `[...messages, { role: "assistant", content: reply }]` 补拍一次（reply 取最终持久化的 strip 后文本，与下一轮进入历史的口径一致）。
5. `cyrene-agent.ts`：`AgentLoopEvent` 增加可选 `contextUsage` 字段；`toAguiEvent` 新增 `context_usage` case → `CUSTOM "cyrene.context.usage"`。

### UI：环形控件与占比菜单

新增 `src/renderer/react/features/chat/components/ContextUsageRing.tsx` + `ContextUsageRing.css`，放入 composer footer（`ReasoningControl` 之后，最右端）：

- **圆环**：约 18px，SVG 双圆实现——底环浅色（现有边框/弱化色变量），进度环亮色（主题强调色），`stroke-dasharray` 控制弧长，线帽 round，起点 12 点方向。无快照时组件返回 `null`（不占位、不渲染空环）。
- **颜色分级**（随占用比例渐变）：正常主题强调色；≥70%（逼近压缩阈值）暖色；≥90% 警示红。仅变色，不加闪烁动画。
- **百分比边界处理（review 修订 #5）**：
  ```ts
  const ratio = totalTokens / contextWindowTokens;          // 可能为 NaN/Infinity/>1
  const visualRatio = Math.min(1, Math.max(0, ratio));      // 只喂给 SVG stroke-dasharray
  ```
  - `contextWindowTokens <= 0` 或 `!Number.isFinite(ratio)`：圆环与百分比不渲染（快照菜单仍可显示 token 绝对值，无百分比）。
  - `ratio > 1`（超窗口）：**文本诚实显示如 118%，圆环 clamp 到整圈**，绝不把 1.18 传进 dasharray。
- **悬停**：`title` 提示"上下文 12.3k / 256k (5%)"。
- **点击**：antd `Popover`（`placement="topRight"`，与 StickerPicker 同模式）弹出占比菜单：
  - 头部：总计 `12.3k / 256k tokens (5%)`。
  - 五段水平堆叠条（五类各一色，同样 clamp）。
  - 五行明细：色点 + 类别名 + token 数 + 占总窗口百分比；`0 token` 的类别隐藏。
  - 脚注："估算值（按字符折算），对话后自动刷新"。
- **配色**（五类固定色，施工时对齐主题变量微调）：系统提示词紫 / 工具定义与 Skill 目录蓝 / 运行时与工具日志琥珀 / 对话历史绿 / 其他灰。
- **数字格式**：`>=1000` 显示 `12.3k`，否则原值。

渲染层其余改动：

- `src/shared/chat-types.ts`：`ChatMessage` 新增 `contextUsage?: ContextUsageSnapshot`。
- `ChatPage.tsx`：`handleEvent` 新增 `cyrene.context.usage` 分支，按 phase 分流：
  - `phase === "preRequest"`：仅 `updateMessage(sessionId, assistantId, { contextUsage })`（纯内存，UI 实时刷新，**不触发 checkpointRun**）。
  - `phase === "terminal"`：`updateMessage` + `checkpointRun("running")`（非 immediate，350ms debounce 合并进紧随其后的 RUN_FINISHED terminal checkpoint）。
  - 向 `ChatComposer` 传 `contextUsage`（取当前会话最后一条 assistant 消息的快照；运行中该消息的快照被每轮 preRequest 实时覆盖，空闲时显示上一 run 的终态快照）。
- `ChatComposer.tsx`：新增 `contextUsage` prop，footer 末尾渲染 `<ContextUsageRing />`。四模式（chat/learn/work/code）统一显示（快照存在即显示）。

---

## 执行步骤

### Phase 0：注释勘误

按上表逐条修改注释与测试名。验收：`git diff` 仅含注释行与字符串字面量，无逻辑变更。

### Phase 1：共享类型与快照计算

1. 新建 `src/shared/context-usage.ts`（类型定义，含 `ContextUsagePhase`）。
2. `compaction.ts` 导出 checkpoint 判定单一事实源（`COMPACTION_CHECKPOINT_OPEN` 常量或 `isCompactionCheckpointMessage` 帮助函数）。
3. 新建 `src/main/orchestrator/context-usage.ts`（`buildContextUsageSnapshot`）。
4. 新建 `src/main/orchestrator/context-usage.test.ts`：
   - 五类归类基础用例（internal 消息、tool 消息、compaction checkpoint、普通对话、开销兜底）。
   - **优先级钉死用例**：构造"同时命中多条规则"的消息（如带 `visibility:"internal"` 的 compaction checkpoint），断言按优先级表归入 conversation。
   - toolSpecs 折算、runtimeContext 单次计量、空消息、totalTokens = Σ categories 恒等、phase 字段透传。

### Phase 2：主进程事件发射

1. `harness/types.ts`：HarnessEvent + HarnessInput.usageParts。
2. `harness-adapter.ts`：`buildHarnessPromptLayers` 附加 usageParts；传入 HarnessInput；`sendHarnessEventAsAgui` 新增 case。更新 `harness-adapter.test.ts`（usageParts 拆分断言 + CUSTOM 事件断言）。
3. `cyrene-harness.ts`：每轮 preRequest 快照 + `finish()` 内 terminal 快照。补 harness 侧单测：mock onEvent 收到 preRequest 快照且 token 随消息增长；正常结束时收到 phase==="terminal" 快照且 totalTokens 大于最后一次 preRequest（包含 final assistant）；cancelled 路径无 terminal 快照。
4. `chat-loop.ts` + `cyrene-agent.ts`：chat 链路 preRequest + terminal 发射与映射。补 `chat-loop.test.ts` 用例：terminal 快照包含 assistant 回复消息。

### Phase 3：渲染层

1. `src/shared/chat-types.ts`：`ChatMessage.contextUsage` 字段。
2. `ChatPage.tsx`：事件分支按 phase 分流（preRequest 纯内存 / terminal 落盘 debounce）+ prop 传递。
3. 新建 `ContextUsageRing.tsx` / `ContextUsageRing.css`；`ChatComposer.tsx` 集成。
4. 新建 `ContextUsageRing.test.tsx`：百分比/弧长计算、`visualRatio` clamp（含 ratio>1 用例）、`contextWindowTokens<=0` / NaN 不渲染百分比、分级变色、无快照返回 null、Popover 明细行渲染（0 token 类别隐藏）、数字格式化。

### Phase 4：验证与提交

跑全量验证（见下），全部通过后提交单个 commit，包含本施工全部文件。

---

## 验证

```bash
npx tsc --noEmit -p src/main
npx tsc --noEmit -p src/preload
npx tsc --noEmit -p src/renderer  # 或项目现有 tsc 脚本
npx vite build
npx vitest run
```

预期：tsc 三项目零错误；vite build 成功；vitest 全量用例通过（含新增用例）。

---

## 手测建议

1. chat 模式发一条消息：footer 出现圆环，点击弹出菜单，"系统提示词"与"对话历史"有值、"工具定义与 Skill 目录"为 0（隐藏）。
2. **终态快照验证（review 修订 #1 的回归点）**：work/code 模式跑一个带工具调用的任务，回复结束后菜单里"对话历史"的 token 应包含最终那条 assistant 回复——即终态快照 > 最后一次请求前快照。
3. work/code 模式多轮任务：圆环随轮次实时增长（运行时与工具日志类明显增加）；触发 mid-loop 压缩后圆环回落。
4. 切换会话再切回：圆环保留该会话最近一次终态快照。
5. 重启应用打开旧会话：圆环仍显示持久化的终态快照。
6. 长对话推高占用至 70%+：圆环变色；继续推高验证 90% 警示色与 >100% 时的"文本诚实 + 圆环整圈"表现。
7. 长多轮任务运行期间观察磁盘写入：中间轮不应触发会话全量落盘（只有终态一次，debounce 合并）。
8. **主动压缩**：打开有历史（>10 条消息）的会话，菜单中悬停小人图 → crossfade 到压缩小人；点击 → 文案变"正在整理记忆…"，完成后聊天记录中窗口内旧消息合并为一条"[此前对话已压缩为记忆摘要]"，下轮对话后圆环"对话历史"明显回落。模型运行中（composer 显示"按 Enter 停止"时）小人不可点击。

---

## 主动压缩（后续增量：小人点击触发）

数据链路与设计（复用既有件，无新依赖）：

- **通道**：`IPC.CHATS_COMPACT ("chats:compact")`，renderer invoke，返回 `{ ok, error?, before?, after? }`。
- **主进程**（`chats-ipc.ts`）：口径与渲染层每轮 run 的 `slice(-16)` 模型窗口对齐——窗口外是纯 UI 历史原样保留；窗口内保留最近 6 条，其余经 `callSummarizeModel`（`context-manager.ts`，Chat 模式循环内压缩同一实现）摘要成一条 `role: "model"` 消息 `[此前对话已压缩为记忆摘要]…`，与 Chat 模式自动压缩同格式，下轮 run normalize 后作为 assistant 记忆进入模型上下文。
- **模型配置**：按会话 `modelProfileId` 解析（`resolveModelSettingsProfile`），摘要失败直接报错返回、绝不落库（历史安全优先）。
- **并发保护**：模块级 `compactingSessions` Set 防同会话重复触发；渲染层在 `modelBusy`（run 进行中）时禁用点击，避免与 run 的消息写回竞态。
- **广播刷新**：压缩后 `broadcastChanged()` 不带 sender（全窗口广播，含发起方）——压缩结果由主进程改写，发起窗口必须被 CHATS_CHANGED 唤醒重载；这是对"来源隔离跳过 sender"约定的显式例外。
- **UI**（`ContextUsageRing.tsx`）：小人图改为 button + 两张 img 叠放 crossfade（纯 CSS `:hover` 渐隐渐显 `compact.png`，240ms）；点击走 `window.chat.compactConversation(sessionId)`；状态机 idle → running（"正在整理记忆…"）→ done（"记忆已整理，清爽啦~"）/ error（"整理失败，稍后再试"）。素材 `public/context-usage/compact.png`。

---

## 风险与回滚

- **估算误差**：`estimateTokens` 为字符折算，与厂商计量有偏差；菜单已标注"估算值"，不用于任何截断决策（截断仍由现有 computeTokenBudget/compressConversation 决定），仅展示。
- **性能**：快照计算每轮一次、纯字符串遍历折算，耗时可忽略；**写放大已规避**（preRequest 只走 updateMessage 纯内存路径，已核实 ChatPage.tsx L713-721 零 I/O；仅 terminal 快照经 debounce 落盘一次，与 RUN_FINISHED checkpoint 合并）。
- **事件体积**：快照为小结构体（5 类 + 计数），远小于单条消息文本，事件流开销可忽略。
- **回滚**：功能完全增量（新事件类型 + 新组件 + 一个可选消息字段），revert 单个 commit 即可整体回滚；Phase 0 注释勘误独立无风险。
