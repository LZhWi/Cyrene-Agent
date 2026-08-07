# Todo 引导锚改造设计（2026-08-07，v3）

> v3 修订：砍掉阶段 3（UI 双向编辑 + 漂移检测）。理由：UI 显示已通过 AGUI 事件 `cyrene.todos` 自动刷新（`todos/bootstrap.ts:12` -> `ChatPage.tsx:429-437`），无需双向编辑；漂移检测的"软提醒"与阶段 2 scheduler 对账功能重叠。设计聚焦两阶段：看见 + 主动维护。
>
> v2 修订（已吸收）：①删除 `todo_read` 工具；②删除 Topic Shift 触发；③Scheduler 事件驱动非轮数；④TodoItem 加 `version`；⑤TodoAction 加 `replace`；⑥Principles 加"计划不是命令"。

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

## 非目标（YAGNI）

- 不做硬拦截 / 拒收响应
- 不做"从 LLM 输出抽 plan 自动写 todo"
- 不做 todo 跨会话神经网络式关联
- 不做多 workspace todo 模板
- 不改现有面板的拖拽 / 折叠
- **不新增 `todo_read` 工具**（todo 已通过 system prompt 注入，tool 会引入双数据源不一致风险）
- **第一版不做 Topic Shift 检测**（"topic"定义模糊、误判率高；待日志驱动后再决定）
- **不做 UI 双向编辑**（显示已通过 AGUI 事件自动刷新；用户编辑是额外功能，不是引导锚的必要部分）
- **不做漂移检测**（与阶段 2 scheduler 对账功能重叠）

---

## 数据模型变更（全阶段共用）

`src/shared/todo-types.ts` 的 `TodoItem` 增加 `version` 字段，为多写入源（LLM / scheduler）的并发更新提供乐观锁基础：

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

两个独立但耦合的阶段。每阶段 ship 后可见 / 可回滚。

```
┌─────────────────────────────────────────────────────────────────┐
│                       渲染端 (renderer)                          │
│  ┌──────────┐                ┌──────────────────┐                │
│  │ TodoPanel│ ← cyrene.todos │ TodoState (local)│                │
│  │ (只读)   │   AGUI 事件    └──────────────────┘                │
│  └──────────┘                                                    │
└────────────────────────↑─────────────────────────────────────────
                         │ onTodosChange -> AGUI 广播
┌─────────────────────────────────────────────────────────────────┐
│                       主进程 (main)                              │
│ ┌─────────────────┐                                              │
│ │  todo-store     │ ← setTodos/clearTodos/                      │
│ │  (扩展)         │   applyTodoActions                            │
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
│ └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

**单一数据源原则**：`todo-store` 是 todo 状态的唯一真相源。system prompt 注入只是它的"只读视图"。不提供 `todo_read` 工具，避免 prompt 与 tool 返回值不一致。

**UI 显示零改动**：`TodoPanel.tsx` 保持只读。所有 todo 写入（agent `todo_write` / scheduler `applyTodoActions`）最终都走 `onTodosChange` -> AGUI 事件 `cyrene.todos` -> `ChatPage.tsx:429-437` 订阅 -> UI 自动刷新。这条链路已存在。

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

> todo 是你的引导锚（anchor）。本工具 = 把任务系统地写到 `todo-store`。**修改 todo 时同时把意图传达给下一次回复**，不要写完 todo 然后回复别的方向。todo 是计划而非命令--用户明确改变目标时，先更新 todo 再执行新目标。

### 1.3 文件改动清单（阶段 1）

| 文件 | 现有行数 | 改动 |
|---|---|---|
| `src/shared/todo-types.ts` | 13 | +3（version 字段）|
| `src/main/orchestrator/todo-store.ts` | 149 | +25（snapshot + version 读写）|
| `src/main/orchestrator/build-options.ts` | 784 | +40（memoized 注入函数）|
| `src/main/orchestrator/agent-runtime.ts` | 265 | +5（透传 mode）|
| `src/main/orchestrator/built-in-tools.ts` | 1697 | +5（改 description）|
| `src/main/orchestrator/build-options.test.ts` | 696 | +50（断言）|
| **小计** | | **~130 行** |

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
  | 'user_explicit'     // 用户说"看一下你的 todo"等
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
| 用户显式 | 用户说"看一下你的 todo" | 文本匹配 |

**不使用轮数触发**（轮数与工作量弱相关：4 轮 "hello" 和 1 轮"写一小时代码"工作量天差地别）。

**第一版不做 Topic Shift 检测**。"topic"定义模糊、误判率高，待日志驱动后再决定是否加入。

### 2.3 对账算法

- 输入：当前 mode 的 todos + 最近 K 条 user/assistant 消息（K 默认 6）
- 调轻量 LLM（与 memory 同一 queue，串行排队）
- prompt 模板要求 LLM 输出一个 `TodoAction[]`（见"数据模型变更"）
- 通过新内部函数 `applyTodoActions(actions)` 落到 `todo-store`（带 `expectedVersion` 乐观锁），store 派发 `cyrene.todos` 事件 -> UI 自动刷新
- 超时（默认 30s）丢弃，不报错
- 冲突（version 不匹配）时重新读取最新 todo 再重试一次

### 2.4 文件改动清单（阶段 2）

| 文件 | 现有行数 | 改动 |
|---|---|---|
| `src/main/orchestrator/todo-scheduler.ts` | - | **新增 ~120 行**（仿 memory-scheduler 107 行）|
| `src/main/orchestrator/todo-scheduler.test.ts` | - | **新增 ~150 行**（仿 memory-scheduler.test 174 行）|
| `src/main/orchestrator/todo-store.ts` | 149 | +40（applyTodoActions + 乐观锁）|
| `src/shared/todo-types.ts` | 13 | +15（TodoAction 联合类型）|
| `src/main/orchestrator/built-in-tools.ts` | 1697 | +30（reconcileTodos 内部接口）|
| `src/main/todos/bootstrap.ts` | 27 | +15（mode 切换钩子）|
| `src/main/index.ts` | 512 | +5（启动）|
| **小计** | | **~375 行** |

### 2.5 验收（阶段 2）

- 单测：`todo_write` 触发 -> debounced 500ms 后 `requestTodoRefresh('todo_changed')` 自动触发
- 单测：mode 切换 -> `requestTodoRefresh('session_start')` 立即触发
- 单测：模拟 30 分钟无 `todo_write` -> `requestTodoRefresh('stale_fallback')` 触发
- 单测：`applyTodoActions` 带 `expectedVersion` 冲突时重试一次
- 端到端：真实对话 20 轮 -> 面板 todo 跟着推进 / 完成 / 替换

---

## 边界与错误处理

- **空 todo**：`buildCurrentTodoInjection` 输出 `<current_todo mode="X" empty="true">（当前没有任务，可以自由发挥）</current_todo>`，并把 `<todo_principles>` 第 4 条加重
- **mode 切换**：触发 `requestTodoRefresh('session_start')`，新 mode 的 todo 重新灌入
- **LLM queue 拥塞**：scheduler 的 `reconcileTodos` 进同一 LLM queue，串行排队；超时（默认 30s）丢弃
- **prompt 过长**：todo 数量 > 20 时只取最近 20 条 + 折叠提示
- **version 冲突**：所有写入接口（`applyTodoActions` / `todo_write`）接受 `expectedVersion?`；不匹配时拒绝写入。scheduler 冲突时重试一次

---

## 测试策略

每阶段三层覆盖：

1. **单元**：`*.test.ts` 测纯函数（`buildCurrentTodoInjection` / `applyTodoActions` / version 冲突）
2. **集成**：`todo-scheduler.test.ts` mock store + mock LLM queue，验证事件触发与动作落 store
3. **端到端**：手工跑真实对话（dev 模式），检查面板变化与响应内容

---

## 改动量汇总

| 阶段 | 新文件 | 修改文件 | 新增代码 | 工时 |
|---|---|---|---|---|
| 阶段 1：看见 + 权重 | 0 | 6 | ~130 行 | 0.5-1 天 |
| 阶段 2：scheduler 对账 | 2 | 6 | ~375 行 | 2-3 天 |
| **合计** | 2 | ~10（有重叠）| **~505 行** | **2.5-4 天** |

阶段 1 投入产出比最高，建议先单独 ship 观察效果，再决定阶段 2 是否继续。

---

## 关键判断点（v3）

1. todo 块位置：灵魂段**之后**、记忆段**之前**
2. scheduler 触发：**事件驱动**（todo 变化 / mode 切换 / 30 分钟兜底 / 用户显式），非轮数
3. 阶段顺序：先看见 -> 再对账
4. 不做硬拦截 / 拒收响应（YAGNI）
5. 不新增 `todo_read` 工具（单一数据源）
6. 第一版不做 Topic Shift（日志驱动后再决定）
7. 不做 UI 双向编辑（AGUI 事件已驱动显示刷新）
8. 不做漂移检测（与 scheduler 对账重叠）
9. TodoItem 加 `version`，所有写入走乐观锁
10. TodoAction 含 `replace`（整计划重写）
11. Principles 含"计划不是命令"

---

## 关键引用文件

- `C:\Users\13575\Documents\live2D-Cyrene\src\main\orchestrator\todo-store.ts:1-150`
- `C:\Users\13575\Documents\live2D-Cyrene\src\main\todos\bootstrap.ts:1-28`
- `C:\Users\13575\Documents\live2D-Cyrene\src\main\orchestrator\built-in-tools.ts:1335-1416`
- `C:\Users\13575\Documents\live2D-Cyrene\src\main\orchestrator\agent-runtime.ts:1-266`
- `C:\Users\13575\Documents\live2D-Cyrene\src\main\orchestrator\build-options.ts:367-688`
- `C:\Users\13575\Documents\live2D-Cyrene\src\main\orchestrator\index.ts:103-178`
- `C:\Users\13575\Documents\live2D-Cyrene\src\main\memory\memory-scheduler.ts:1-108`（todo-scheduler 模板）
- `C:\Users\13575\Documents\live2D-Cyrene\src\shared\todo-types.ts:1-13`
