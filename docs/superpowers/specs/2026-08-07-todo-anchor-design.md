# Todo 引导锚改造设计（2026-08-07）

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
2. 系统**主动维护** todo：每 N 轮 / 会话开始 / 主题切换时自动对账
3. 用户**双向可控**：面板可勾完成、加项、删项
4. **漂移告警**：cyrene 跑偏时，下一轮自动收到软提醒

## 非目标（YAGNI）

- 不做硬拦截 / 拒收响应
- 不做"从 LLM 输出抽 plan 自动写 todo"
- 不做 todo 跨会话神经网络式关联
- 不做多 workspace todo 模板
- 不改现有面板的拖拽 / 折叠

---

## 总体架构

三个独立但耦合的阶段。每阶段 ship 后可见 / 可回滚。

```
┌────────────────────────────────────────────────────────────────┐
│                       渲染端 (renderer)                        │
│  ┌──────────┐  IPC: TODOS_USER_OVERRIDE   ┌──────────────────┐  │
│  │ TodoPanel│ ────────────↑───────────────│ TodoState (store)│  │
│  └──────────┘                              └──────────────────┘  │
└────────────────────────↑──────────────────────│──────────────────
                  cyrene.todos 事件            │
┌─────────────────────────────────────────────────────────────────┐
│                       主进程 (main)                              │
│ ┌─────────────────┐                                              │
│ │  todo-store     │ ← setTodos/clearTodos/                      │
│ │  (扩展)         │   applyTodoActions/userOverrideTodos         │
│ └────────↑────────┘                                              │
│          │ onTodosChange                                         │
│ ┌────────┴────────┐      ┌───────────────────────┐                │
│ │ todos/bootstrap │      │ todo-scheduler (新)    │ ← tick        │
│ │ AGUI 广播       │      │ ·每 N 轮调刷新         │                │
│ └─────────────────┘      │ ·会话开始 hook         │                │
│                          │ ·漂移检测              │                │
│                          └───────────↑───────────┘                │
│                                      │ queueTodoRefresh          │
│ ┌──────────────────────────────────────┴─────────────────────┐   │
│ │ build-options.ts (扩展)                                  │    │
│ │ ·buildCurrentTodoInjection(mode) ← 新增                  │    │
│ │ ·位置: 灵魂段之后、记忆段之前 (高权重位)                 │    │
│ │ ·新工具 todo_read                                        │    │
│ │ ·buildDriftHint ← 阶段3                                  │    │
│ └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

---

## 阶段 1：让 cyrene 看见 + 提高权重（最小觉醒）

### 1.1 新工具 `todo_read`

`src/main/orchestrator/built-in-tools.ts` 新增 `todo_read` 工具（LLM 主动可读）：
- 输入：无（或可选 `{ mode }` 默认当前 mode）
- 输出：当前 mode 的 todos JSON + 顶层提示 "这是你本轮的引导锚"

### 1.2 system prompt 注入 `<current_todo>`

`src/main/orchestrator/build-options.ts` 新增 `buildCurrentTodoInjection(mode)` 函数，输出形如：

```xml
<current_todo mode="work" priority="anchor">
  [in_progress] 把项目图标做成复古胶片风  ← 这条要推进
  [pending] 给 README 加 GIF 演示
  [completed] 设计主视觉草图
</current_todo>
<todo_principles>
1. 这是你的引导锚，不是装饰。每轮回复前心里过一遍「当前是不是在推 in_progress」。
2. 用户话题与你当前的 todo 偏离 → 主动改 todo，不要假装在推进。
3. 当一条 todo 完成 → 立刻把它移到 completed 并思考下一步。
4. 不要为了"看起来有 todo"而凑数；空 todo 是合法的。
</todo_principles>
```

插入位置：`toolSystemContent` / `soulSystemBaseContent` 拼接时，**灵魂段之后、记忆段之前**。

### 1.3 `todo_write` 工具 description 加强

在 `built-in-tools.ts:1351-1364` 现有 description 中追加：

> todo 是你的引导锚（anchor）。本工具 = 把任务系统地写到 `todo-store`。**修改 todo 时同时把意图传达给下一次回复**，不要写完 todo 然后回复别的方向。

### 1.4 文件改动清单（阶段 1）

| 文件 | 改动 |
|---|---|
| `src/main/orchestrator/built-in-tools.ts` | +`todo_read` 工具；改 `todo_write` description |
| `src/main/orchestrator/build-options.ts` | +`buildCurrentTodoInjection(mode)`；拼入 system prompt |
| `src/main/orchestrator/agent-runtime.ts` | 把当前 mode 透传给 `buildAgentRunOptions` |
| `src/main/orchestrator/todo-store.ts` | +`getTodosSnapshot(mode): string` 用于序列化 |
| `src/main/orchestrator/build-options.test.ts` | +断言注入存在 + 位置正确 |

### 1.5 验收（阶段 1）

- 单测：mock todos 后拼出的 prompt 含 `<current_todo`、且位置在 soul 之后
- 端到端：在 todo-store 写 in_progress 一项 → 问 cyrene "你现在干嘛呢" → 能正确复述

---

## 阶段 2：todo-scheduler 后台对账

### 2.1 新文件 `src/main/orchestrator/todo-scheduler.ts`

仿照 `src/main/memory/memory-scheduler.ts:31-93` 暴露：

```ts
export type TodoRefreshReason = 'tick' | 'session_start' | 'user_explicit' | 'topic_shift';

export function startTodoScheduler(deps: TodoSchedulerDeps): void;
export function stopTodoScheduler(): void;
export function requestTodoRefresh(reason: TodoRefreshReason): Promise<void>;
```

### 2.2 触发点

| 触发条件 | 默认值 | 来源 |
|---|---|---|
| 每 N 轮 tick | 8 轮 | `MEMORY_JUDGE_INTERVAL = 6` 同级，`TODO_REFRESH_INTERVAL = 8` |
| 会话开始 | 启动 / 重启 / mode 切换 | `bootstrap.ts` 钩子 |
| 主题切换 | 用户消息与上一轮主题相似度 < 0.3 | `onAgentRunFinished` 后启发式 |
| 用户显式 | "对齐 todo"按钮 / 用户说"看一下你的 todo" | UI / 文本 |
| 用户手动改 todo 后下一轮开始前 | — | IPC `TODOS_USER_OVERRIDE` 触发 |

### 2.3 对账算法

- 输入：当前 mode 的 todos + 最近 K 条 user/assistant 消息（K 默认 6）
- 调轻量 LLM（与 memory 同一 queue，串行排队）
- prompt 模板要求 LLM 输出一个 `TodoAction[]`：
  ```ts
  type TodoAction =
    | { op: 'mark_completed', id: string }
    | { op: 'mark_in_progress', id: string }
    | { op: 'append', text: string }
    | { op: 'remove', id: string }
    | { op: 'noop' };
  ```
- 通过新内部函数 `applyTodoActions(actions)` 落到 `todo-store`，store 派发 `cyrene.todos` 事件
- 超时（默认 30s）丢弃，不报错

### 2.4 文件改动清单（阶段 2）

| 文件 | 改动 |
|---|---|
| `src/main/orchestrator/todo-scheduler.ts` | 全新 |
| `src/main/orchestrator/todo-store.ts` | +`applyTodoActions(actions: TodoAction[])` |
| `src/shared/todo-types.ts` | +`TodoAction` 联合类型 |
| `src/main/orchestrator/built-in-tools.ts` | +`reconcileTodos()` 内部接口（不注册为 tool） |
| `src/main/orchestrator/agent-runtime.ts` | 在 `onRunFinished` 注册 topic shift 检测 |
| `src/main/todos/bootstrap.ts` | 暴露 `getCurrentTodos()` |
| `src/main/index.ts` | 启动 `startTodoScheduler()` |
| `src/main/orchestrator/todo-scheduler.test.ts` | 全新（仿 `memory-scheduler.test.ts`） |

### 2.5 验收（阶段 2）

- 单测：连续 8 轮只调 `todo_write` → 第 9 轮 `requestTodoRefresh('tick')` 自动触发
- 单测：用户连续两轮发不同主题 → 第二次 `onRunFinished` 自动触发 topic-shift 刷新
- 端到端：真实对话 20 轮 → 面板 todo 跟着推进 / 完成 / 替换

---

## 阶段 3：UI 双向 + 漂移检测

### 3.1 TodoPanel 改造

`src/renderer/react/features/chat/components/TodoPanel.tsx`：

- 每个 in_progress 项加 checkbox → 触发新 IPC `TODOS_USER_OVERRIDE`
- 每条 todo 右侧加删除按钮
- 底部加 "+"输入框新增 todo
- 顶部加"对齐 todos"按钮 → 触发 `requestTodoRefresh('user_explicit')`

### 3.2 新 IPC

`src/shared/ipc-channels.ts` 新增：
- `TODOS_USER_OVERRIDE: "todos:user-override"`

`src/main/index.ts` 注册 handler 调 `todo-store.userOverrideTodos(updates)`。

`src/preload/index.ts` 暴露 `overrideTodos` 给渲染端。

### 3.3 漂移检测（不调 LLM 的启发式）

新文件 `src/main/orchestrator/drift-detector.ts`：

```ts
export function computeDriftScore(
  responseText: string,
  inProgressTodo: TodoItem | undefined,
): number; // 0..1, Jaccard 相似度
export function buildDriftHint(prevResponseText: string, inProgressTodo: TodoItem | undefined): string | undefined;
```

- 抽取响应中动词宾短语（用 stop word 过滤）
- 与 in_progress 文本的词集合做 Jaccard
- 阈值 `THRESHOLD = 0.15`（在文件顶部常量），低于阈值且 in_progress 不为空 → 返回 hint 字符串
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
| `src/main/orchestrator/drift-detector.ts` | 全新 |
| `src/main/orchestrator/drift-detector.test.ts` | 全新 |

### 3.5 验收（阶段 3）

- 单测：给定响应文本与 in_progress，验证漂移分数与是否触发 hint
- 端到端：用户输入与 todo 完全无关 → cyrene 下一轮回复前先看到 hint

---

## 边界与错误处理

- **空 todo**：`buildCurrentTodoInjection` 输出 `<current_todo mode="X" empty="true">（当前没有任务，可以自由发挥）</current_todo>`，并把 `<todo_principles>` 第 4 条加重
- **mode 切换**：触发 `requestTodoRefresh('session_start')`，新 mode 的 todo 重新灌入
- **LLM queue 拥塞**：scheduler 的 `reconcileTodos` 进同一 LLM queue，串行排队；超时（默认 30s）丢弃
- **prompt 过长**：todo 数量 > 20 时只取最近 20 条 + 折叠提示
- **漂移阈值**：`THRESHOLD = 0.15` 在 `drift-detector.ts` 顶部常量，可调

---

## 测试策略

每阶段三层覆盖：

1. **单元**：`*.test.ts` 测纯函数（`buildCurrentTodoInjection` / `drift_score` / `applyTodoActions`）
2. **集成**：`*scheduler.test.ts` mock store + mock LLM queue，验证 tick 触发与动作落 store
3. **端到端**：手工跑真实对话（dev 模式），检查面板变化与响应内容

---

## 关键判断点（待用户复核）

1. todo 块位置：灵魂段**之后**、记忆段**之前**
2. scheduler 默认频率：每 8 轮（对照 `memory-scheduler` 的 6 轮）
3. 漂移阈值 Jaccard：默认 0.15
4. 阶段顺序：先看见 → 再对账 → 最后 UI
5. 不做硬拦截 / 拒收响应（写入 YAGNI）

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
