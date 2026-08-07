# Todo 引导锚改造设计（2026-08-07，v2）

> v2 修订：吸收外部 code review。主要变化：①删除 `todo_read` 工具（避免 prompt+tool 双数据源）；②删除 Topic Shift 触发（误判率高，第一版不做）；③Scheduler 由轮数改为事件驱动；④Drift Detection 抽象为接口、Jaccard 作为默认实现（预留小模型替换）；⑤TodoItem 加 `version` 字段；⑥TodoAction 加 `replace`；⑦Principles 加"计划不是命令"。

## 背景

cyrene 当前的 todo 卡片是一块**对人类可见、对 LLM 几乎不可见**的纯装饰性状态板。具体实情：

- 后端唯一写入路径是 `src/main/orchestrator/built-in-tools.ts:1335-1416` 注册的 `todo_write` 工具（LLM 显式 tool-call 才触发）
- prompt 构建链路（`build-options.ts:367-688`、`orchestrator/index.ts:103-178` 的 `buildAlwaysOnContext`、`build*Context`）**不读 `todo-store`**
- `agent-runtime.ts` 跟 todo 系统零交互
- `src/renderer/react/features/chat/components/TodoPanel.tsx` 是只读 UI，不向 agent 反向通知
- 没有"每 N 轮自动维护"或"上下文不一致时告警"的任何 hook

效果是：用户的引导锚（todo 卡片）只在人类视角生效，对 LLM 半盲，被动、滞后、容易被话题带走。

## 目标

把 todo 升级为 cyrene 的**引导锚**（anchor）：

1. cyrene **每轮都看见**自己当前的 todo（高权重位置 + 明确原则说明）
2. 系统**主动维护** todo：在 todo 变化 / 会话开始 / mode 切换 / 长时间未更新 / 用户显式触发时自动对账
3. 用户**双向可控**：面板可勾完成、加项、删项
4. **漂移告警**：cyrene 跑偏时，下一轮自动收到软提醒

## 非目标（YAGNI）

- 不做硬拦截 / 拒收响应
- 不做"从 LLM 输出抽 plan 自动写 todo"
- 不做 todo 跨会话神经网络式关联
- 不做多 workspace todo 模板
- 不改现有面板的拖拽 / 折叠
- **不新增 `todo_read` 工具**（todo 已通过 system prompt 注入，tool 会引入双数据源不一致风险）
- **第一版不做 Topic Shift 检测**（"topic"定义模糊、误判率高；待日志驱动后再决定）

---

## 数据模型变更（全阶段共用）

`src/shared/todo-types.ts` 的 `TodoItem` 增加 `version` 字段，为多写入源（LLM / scheduler / UI）的并发更新提供乐观锁基础：

```ts
export interface TodoItem {
  id: string;
  text: string;
  state: 'pending' | 'in_progress' | 'completed';
  createdAt: number;
  version: number;        // 新增：每次修改自增，用于并发冲突检测
}
```

`todo-store` 的所有写入接口接受 `expectedVersion?` 参数；不匹配时拒绝写入并返回冲突错误。`TodoAction`（阶段 2 引入）也带 `expectedVersion`。

`TodoAction` 联合类型（阶段 2）：

```ts
type TodoAction =
  | { op: 'mark_completed', id: string, expectedVersion?: number }
  | { op: 'mark_in_progress', id: string, expectedVersion?: number }
  | { op: 'append', text: string }
  | { op: 'remove', id: string, expectedVersion?: number }
  | { op: 'replace', items: TodoItem[] }   // 整个计划重写，用于"今天不做了换一个"
  | { op: 'noop' };
```

---

## 总体架构

三个独立但耦合的阶段。每阶段 ship 后可见 / 可回滚。

```
┌────────────────────────────────────────────────────────────────┐
│                       渲染端 (renderer)                        │
│  ┌──────────┐  IPC: TODOS_USER_OVERRIDE (带 expectedVersion)   │
│  │ TodoPanel│ ────────────↑───────────────┐                    │
│  └──────────┘                              │                    │
└────────────────────────↑───────────────────│──────────────────
                  cyrene.todos 事件          │
┌─────────────────────────────────────────────────────────────────┐
│                       主进程 (main)                              │
│ ┌─────────────────┐                                              │
│ │  todo-store     │ ← setTodos/clearTodos/                      │
│ │  (扩展)         │   applyTodoActions/userOverrideTodos         │
│ │  +version 字段  │   (全部带 expectedVersion 乐观锁)            │
│ └────────↑────────┘                                              │
│          │ onTodosChange                                         │
│ ┌────────┴────────┐      ┌───────────────────────┐                │
│ │ todos/bootstrap │      │ todo-scheduler (新)    │ ← 事件驱动    │
│ │ AGUI 广播       │      │ ·todo 变化触发         │                │
│ └─────────────────┘      │ ·mode 切换             │                │
│                          │ ·长时间未更新兜底      │                │
│                          │ ·用户显式              │                │
│                          └───────────↑───────────┘                │
│                                      │ queueTodoRefresh          │
│ ┌──────────────────────────────────────┴─────────────────────┐   │
│ │ build-options.ts (扩展)                                  │    │
│ │ ·buildCurrentTodoInjection(mode) ← 新增, memoized        │    │
│ │ ·位置: 灵魂段之后、记忆段之前 (高权重位)                 │    │
│ │ ·buildDriftHint ← 阶段3, 可替换接口                      │    │
│ └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

**单一数据源原则**：`todo-store` 是 todo 状态的唯一真相源。system prompt 注入只是它的"只读视图"。不提供 `todo_read` 工具，避免 prompt 与 tool 返回值不一致。

---

## 阶段 1：让 cyrene 看见 + 提高权重（最小觉醒）

### 1.1 system prompt 注入 `<current_todo>`（唯一注入路径）

`src/main/orchestrator/build-options.ts` 新增 `buildCurrentTodoInjection(mode)` 函数，**memoized**（todo 未变则复用上次拼好的字符串，避免每轮重拼）。输出形如：

```xml
<current_todo mode="work" priority="anchor" version="17">
  [in_progress] 把项目图标做成复古胶片风  ← 这条要推进
  [pending] 给 README 加 GIF 演示
  [completed] 设计主视觉草图
</current_todo>
<todo_principles>
1. 这是你的引导锚，不是装饰。每轮回复前心里过一遍「当前是不是在推 in_progress」。
2. 用户话题与你当前的 todo 偏离 -> 主动改 todo，不要假装在推进。
3. 当一条 todo 完成 -> 立刻把它移到 completed 并思考下一步。
4. 不要为了"看起来有 todo"而凑数；空 todo 是合法的。
5. Todo 描述的是当前计划，而不是必须执行的命令；如果用户明确改变目标，应先更新 Todo，再执行新的目标。
</todo_principles>
```

插入位置：`toolSystemContent` / `soulSystemBaseContent` 拼接时，**灵魂段之后、记忆段之前**。

**不新增 `todo_read` 工具**。todo 通过 system prompt 注入是唯一来源，避免双数据源不一致。

### 1.2 `todo_write` 工具 description 加强

在 `built-in-tools.ts:1351-1364` 现有 description 中追加：

> todo 是你的引导锚（anchor）。本工具 = 把任务系统地写到 `todo-store`。**修改 todo 时同时把意图传达给下一次回复**，不要写完 todo 然后回复别的方向。todo 是计划而非命令——用户明确改变目标时，先更新 todo 再执行新目标。

### 1.3 文件改动清单（阶段 1）

| 文件 | 改动 |
|---|---|
| `src/main/orchestrator/build-options.ts` | +`buildCurrentTodoInjection(mode)` memoized；拼入 system prompt |
| `src/main/orchestrator/agent-runtime.ts` | 把当前 mode 透传给 `buildAgentRunOptions` |
| `src/main/orchestrator/todo-store.ts` | +`getTodosSnapshot(mode): string`；`version` 字段读写 |
| `src/shared/todo-types.ts` | `TodoItem` 加 `version: number` |
| `src/main/orchestrator/build-options.test.ts` | +断言注入存在 + 位置正确 + memoization 生效 |

### 1.4 验收（阶段 1）

- 单测：mock todos 后拼出的 prompt 含 `<current_todo`、且位置在 soul 之后
- 单测：todo 未变时 `buildCurrentTodoInjection` 复用缓存（memoization）
- 端到端：在 todo-store 写 in_progress 一项 -> 问 cyrene "你现在干嘛呢" -> 能正确复述

---

## 阶段 2：todo-scheduler 事件驱动对账

### 2.1 新文件 `src/main/orchestrator/todo-scheduler.ts`

仿照 `src/main/memory/memory-scheduler.ts:31-93` 暴露：

```ts
export type TodoRefreshReason =
  | 'todo_changed'      // todo 写入后触发（debounced）
  | 'session_start'     // 启动 / 重启 / mode 切换
  | 'user_explicit'     // 用户在面板点"对齐"或说"看一下你的 todo"
  | 'stale_fallback';   // 长时间未更新兜底

export function startTodoScheduler(deps: TodoSchedulerDeps): void;
export function stopTodoScheduler(): void;
export function requestTodoRefresh(reason: TodoRefreshReason): Promise<void>;
```

### 2.2 触发点（事件驱动，非轮数）

| 触发条件 | 机制 | 说明 |
|---|---|---|
| todo 变化 | `onTodosChange` listener，debounced 500ms | 避免高频写入触发多次刷新 |
| mode 切换 | `bootstrap.ts` 钩子 | 新 mode 的 todo 重新灌入并立即对账 |
| 长时间未更新 | 定时器，默认 30 分钟无 `todo_write` 则触发 | 兜底，防止 todo 长期不更新 |
| 用户显式 | UI"对齐 todos"按钮 / 用户说"看一下你的 todo" | 文本匹配 + UI 入口 |

**不使用轮数触发**（轮数与工作量弱相关：4 轮 "hello" 和 1 轮"写一小时代码"工作量天差地别）。

**第一版不做 Topic Shift 检测**。"topic"定义模糊、误判率高，待日志驱动后再决定是否加入。

### 2.3 对账算法

- 输入：当前 mode 的 todos + 最近 K 条 user/assistant 消息（K 默认 6）
- 调轻量 LLM（与 memory 同一 queue，串行排队）
- prompt 模板要求 LLM 输出一个 `TodoAction[]`（见"数据模型变更"）
- 通过新内部函数 `applyTodoActions(actions)` 落到 `todo-store`（带 `expectedVersion` 乐观锁），store 派发 `cyrene.todos` 事件
- 超时（默认 30s）丢弃，不报错
- 冲突（version 不匹配）时重新读取最新 todo 再重试一次

### 2.4 文件改动清单（阶段 2）

| 文件 | 改动 |
|---|---|
| `src/main/orchestrator/todo-scheduler.ts` | 全新 |
| `src/main/orchestrator/todo-store.ts` | +`applyTodoActions(actions: TodoAction[])`；写入接口加 `expectedVersion` |
| `src/shared/todo-types.ts` | +`TodoAction` 联合类型（含 `replace`） |
| `src/main/orchestrator/built-in-tools.ts` | +`reconcileTodos()` 内部接口（不注册为 tool） |
| `src/main/todos/bootstrap.ts` | 暴露 `getCurrentTodos()`；mode 切换钩子 |
| `src/main/index.ts` | 启动 `startTodoScheduler()` |
| `src/main/orchestrator/todo-scheduler.test.ts` | 全新（仿 `memory-scheduler.test.ts`） |

### 2.5 验收（阶段 2）

- 单测：`todo_write` 触发 -> debounced 500ms 后 `requestTodoRefresh('todo_changed')` 自动触发
- 单测：mode 切换 -> `requestTodoRefresh('session_start')` 立即触发
- 单测：模拟 30 分钟无 `todo_write` -> `requestTodoRefresh('stale_fallback')` 触发
- 单测：`applyTodoActions` 带 `expectedVersion` 冲突时重试一次
- 端到端：真实对话 20 轮 -> 面板 todo 跟着推进 / 完成 / 替换

---

## 阶段 3：UI 双向 + 漂移检测

### 3.1 TodoPanel 改造

`src/renderer/react/features/chat/components/TodoPanel.tsx`：

- 每个 in_progress 项加 checkbox -> 触发新 IPC `TODOS_USER_OVERRIDE`（带 `expectedVersion`）
- 每条 todo 右侧加删除按钮
- 底部加 "+"输入框新增 todo
- 顶部加"对齐 todos"按钮 -> 触发 `requestTodoRefresh('user_explicit')`
- 冲突时（version 不匹配）UI 提示"todo 已被 cyrene 更新，已刷新"

### 3.2 新 IPC

`src/shared/ipc-channels.ts` 新增：
- `TODOS_USER_OVERRIDE: "todos:user-override"`（payload 带 `expectedVersion`）

`src/main/index.ts` 注册 handler 调 `todo-store.userOverrideTodos(updates, expectedVersion)`。

`src/preload/index.ts` 暴露 `overrideTodos` 给渲染端。

### 3.3 漂移检测（可替换接口）

新文件 `src/main/orchestrator/drift-detector.ts`，**定义为接口**，Jaccard 作为默认实现：

```ts
export interface DriftDetector {
  computeDriftScore(responseText: string, inProgressTodo: TodoItem | undefined): number; // 0..1
  buildDriftHint(prevResponseText: string, inProgressTodo: TodoItem | undefined): string | undefined;
}

// 默认实现：词集合 Jaccard
export class JaccardDriftDetector implements DriftDetector { ... }

// 预留：未来替换为小模型语义判断
// export class SemanticDriftDetector implements DriftDetector { ... }
```

- 默认 `JaccardDriftDetector`：抽取响应中动词宾短语（stop word 过滤），与 in_progress 文本词集合做 Jaccard
- 阈值 `THRESHOLD = 0.15`（可调），低于阈值且 in_progress 不为空 -> 返回 hint 字符串
- **接口预留小模型替换**：Jaccard 对"优化 Agent Loop" vs "重构 Runtime"这类语义同义词会漏判，未来用 `SemanticDriftDetector` 替换。第一版用 Jaccard 是为了不增加 LLM 调用成本。替换入口：`agent-runtime` 通过依赖注入持有 `DriftDetector` 实例（构造时 `new JaccardDriftDetector()`），未来换成 `new SemanticDriftDetector()` 即可，不改调用方
- 在 `build-options.ts` 拼 system prompt 时追加：

```xml
<drift_hint>
你上一轮似乎在讲 X，但当前 in_progress 是 Y。要么调整 todo，要么继续推进 Y，否则会偏离用户的引导锚。
</drift_hint>
```

- hint 只保留一轮，下轮不再出现（由 `agent-runtime` 维护 `lastDriftHint: string | null`，每轮 build prompt 时若新 `buildDriftHint` 返回 undefined 则把 `lastDriftHint` 置 null；返回新值则**替换**而非追加）

### 3.4 文件改动清单（阶段 3）

| 文件 | 改动 |
|---|---|
| `src/renderer/react/features/chat/components/TodoPanel.tsx` | UI 改造 |
| `src/preload/index.ts` | +`overrideTodos` |
| `src/shared/ipc-channels.ts` | +`TODOS_USER_OVERRIDE` |
| `src/main/index.ts` | +IPC handler |
| `src/main/orchestrator/build-options.ts` | +`buildDriftHint()` 注入函数 |
| `src/main/orchestrator/drift-detector.ts` | 全新（接口 + Jaccard 实现） |
| `src/main/orchestrator/drift-detector.test.ts` | 全新 |

### 3.5 验收（阶段 3）

- 单测：给定响应文本与 in_progress，验证 `JaccardDriftDetector` 漂移分数与是否触发 hint
- 单测：`DriftDetector` 接口可注入 mock 实现（验证可替换性）
- 端到端：用户输入与 todo 完全无关 -> cyrene 下一轮回复前先看到 hint
- 端到端：UI 勾选完成 -> version 冲突时提示"已刷新"

---

## 边界与错误处理

- **空 todo**：`buildCurrentTodoInjection` 输出 `<current_todo mode="X" empty="true">（当前没有任务，可以自由发挥）</current_todo>`，并把 `<todo_principles>` 第 4 条加重
- **mode 切换**：触发 `requestTodoRefresh('session_start')`，新 mode 的 todo 重新灌入
- **LLM queue 拥塞**：scheduler 的 `reconcileTodos` 进同一 LLM queue，串行排队；超时（默认 30s）丢弃
- **prompt 过长**：todo 数量 > 20 时只取最近 20 条 + 折叠提示
- **漂移阈值**：`THRESHOLD = 0.15` 在 `drift-detector.ts` 顶部常量，可调
- **version 冲突**：所有写入接口（`applyTodoActions` / `userOverrideTodos` / `todo_write`）接受 `expectedVersion?`；不匹配时拒绝写入。scheduler 冲突时重试一次，UI 冲突时提示用户刷新

---

## 测试策略

每阶段三层覆盖：

1. **单元**：`*.test.ts` 测纯函数（`buildCurrentTodoInjection` / `drift_score` / `applyTodoActions` / version 冲突）
2. **集成**：`*scheduler.test.ts` mock store + mock LLM queue，验证事件触发与动作落 store
3. **端到端**：手工跑真实对话（dev 模式），检查面板变化与响应内容

---

## 关键判断点（v2 修订后）

1. todo 块位置：灵魂段**之后**、记忆段**之前**
2. scheduler 触发：**事件驱动**（todo 变化 / mode 切换 / 30 分钟兜底 / 用户显式），非轮数
3. 漂移检测：**接口化**，默认 Jaccard（阈值 0.15），预留小模型替换
4. 阶段顺序：先看见 -> 再对账 -> 最后 UI
5. 不做硬拦截 / 拒收响应（YAGNI）
6. 不新增 `todo_read` 工具（单一数据源）
7. 第一版不做 Topic Shift（日志驱动后再决定）
8. TodoItem 加 `version`，所有写入走乐观锁
9. TodoAction 含 `replace`（整计划重写）
10. Principles 含"计划不是命令"

---

## 关键引用文件

- `C:\Users\13575\Documents\live2D-Cyrene\src\main\orchestrator\todo-store.ts:1-150`
- `C:\Users\13575\Documents\live2D-Cyrene\src\main\todos\bootstrap.ts:1-28`
- `C:\Users\13575\Documents\live2D-Cyrene\src\main\orchestrator\built-in-tools.ts:1335-1416`
- `C:\Users\13575\Documents\live2D-Cyrene\src\main\orchestrator\agent-runtime.ts:1-266`
- `C:\Users\13575\Documents\live2D-Cyrene\src\main\orchestrator\build-options.ts:367-688`
- `C:\Users\13575\Documents\live2D-Cyrene\src\main\orchestrator\index.ts:103-178`
- `C:\Users\13575\Documents\live2D-Cyrene\src\renderer\react\features\chat\components\TodoPanel.tsx:1-221`
- `C:\Users\13575\Documents\live2D-Cyrene\src\renderer\react\features\chat\pages\ChatPage.tsx:390,412-438,1888`
- `C:\Users\13575\Documents\live2D-Cyrene\src\main\memory\memory-scheduler.ts:1-108`（todo-scheduler 模板）
- `C:\Users\13575\Documents\live2D-Cyrene\src\shared\ipc-channels.ts:350`
- `C:\Users\13575\Documents\live2D-Cyrene\src\shared\todo-types.ts:1-13`
