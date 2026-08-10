# Mutable Todo Working Notebook Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让昔涟在预计任务需要至少 2 个 execution step（执行步骤）/ tool round（工具推进轮次）时主动建立并持续修订 Todo，同时始终把 Todo 当作可变工作笔记而非后续行动约束。

**Architecture:** 复用现有 `update_todo` 内置工具、`AgentState.todoItems` 和 Harness system prompt，不引入 scheduler、第二套存储或第三方依赖。静态策略由独立的 Todo prompt 模块注入每个 Run；当前 Todo 快照则在每次模型调用前从实时 `AgentState` 渲染为只读 context，因此模型能像翻看笔记本一样重新看到计划，但 Runtime 不自动创建、修改或据此命令模型继续。

**Tech Stack:** TypeScript、Vitest、现有 CyreneHarness、现有 Vendor SDK streaming path。

## Global Constraints

- “两轮”按 execution step / tool round 计算，不按 LLM 调用次数计算。
- 预计任务需要至少 2 个 execution step / tool round 时，模型应优先调用 `update_todo` 建立简短 Todo。
- 单次工具即可完成的简单任务（例如查询一次天气）不要求 Todo。
- Todo 必须明确标记为 `mutable working notebook`（可变工作笔记），不得作为后续行动的强约束。
- Todo 缺失、内容不准、阶段完成或执行方向改变时，模型可随时新增、完成、取消或重写 Todo。
- Runtime 不自动代写 Todo，不使用强制 `tool_choice`，不因 Todo 为空或未完成而阻止 final。
- Todo 只表达工作计划，不能证明文件、命令、网络请求或其他外部效果已经成功。
- 复用现有 `update_todo`、Harness state、ChatSession 持久化和 AG-UI `cyrene.todo` 事件；不新增依赖或平行 Todo 数据源。
- 保留现有 invariant：同一时刻最多一个 `in_progress`，已完成/已取消项目不回退；改方向时取消旧项并为新方向建立新项。

---

### Task 1: 建立模型可见的 Todo 工作笔记软策略

**Files:**
- Create: `src/main/orchestrator/harness/todo-working-notebook.ts`
- Create: `src/main/orchestrator/harness/todo-working-notebook.test.ts`
- Modify: `src/main/orchestrator/harness-adapter.ts`
- Modify: `src/main/orchestrator/harness-adapter.test.ts`
- Modify: `src/main/orchestrator/harness/builtin-tools.ts`
- Modify: `src/main/orchestrator/harness/builtin-tools.test.ts`

**Interfaces:**
- Produces: `TODO_WORKING_NOTEBOOK_POLICY: string`，供 `buildHarnessSystemPrompt()` 追加到模型 system prompt。
- Preserves: `updateTodoToolSpec: ToolSpec` 的名称、参数 schema 与整表替换语义。

- [ ] **Step 1: 为静态策略写失败测试**

在 `src/main/orchestrator/harness/todo-working-notebook.test.ts` 中添加：

```ts
import { describe, expect, it } from "vitest";
import { TODO_WORKING_NOTEBOOK_POLICY } from "./todo-working-notebook";

describe("Todo mutable working notebook policy", () => {
  it("uses execution steps and tool rounds instead of LLM call count", () => {
    expect(TODO_WORKING_NOTEBOOK_POLICY).toContain("至少 2 个 execution step");
    expect(TODO_WORKING_NOTEBOOK_POLICY).toContain("tool round");
    expect(TODO_WORKING_NOTEBOOK_POLICY).toContain("不按 LLM 调用次数");
  });

  it("keeps Todo mutable, optional for simple tasks, and non-binding", () => {
    expect(TODO_WORKING_NOTEBOOK_POLICY).toContain("mutable working notebook");
    expect(TODO_WORKING_NOTEBOOK_POLICY).toContain("可变工作笔记");
    expect(TODO_WORKING_NOTEBOOK_POLICY).toContain("单次工具即可完成");
    expect(TODO_WORKING_NOTEBOOK_POLICY).toContain("不得作为后续行动的强约束");
    expect(TODO_WORKING_NOTEBOOK_POLICY).toContain("方向改变");
  });
});
```

- [ ] **Step 2: 运行测试并确认因模块不存在而失败**

Run: `npx vitest run src/main/orchestrator/harness/todo-working-notebook.test.ts`

Expected: FAIL，错误指向无法解析 `./todo-working-notebook`。

- [ ] **Step 3: 实现静态策略常量**

创建 `src/main/orchestrator/harness/todo-working-notebook.ts`：

```ts
export const TODO_WORKING_NOTEBOOK_POLICY = `[TODO_WORKING_NOTEBOOK_POLICY]
Todo 是你的 mutable working notebook（可变工作笔记），用于像人类手边的笔记本一样记录当前方向和阶段进度。
- 如果预计任务需要至少 2 个 execution step（执行步骤）或 tool round（工具推进轮次），优先调用 update_todo 建立一份简短清单。
- “两轮”按执行步骤/工具推进轮次理解，不按 LLM 调用次数计算。
- 单次工具即可完成的简单任务（例如一次天气查询）不需要 Todo。
- 当 Todo 为空但任务已经显现为多步、Todo 与事实不符、一个阶段完成、用户改变目标或你决定改变执行方向时，及时调用 update_todo 修订或重写它。
- Todo 不得作为后续行动的强约束；先依据用户当前目标和最新工具事实判断，再修订笔记并继续。
- Todo 不是外部操作已经成功的证明。`;
```

- [ ] **Step 4: 验证静态策略测试转绿**

Run: `npx vitest run src/main/orchestrator/harness/todo-working-notebook.test.ts`

Expected: 2 tests PASS。

- [ ] **Step 5: 为 system prompt 和工具说明写失败测试**

在 `src/main/orchestrator/harness-adapter.test.ts` 的 `Harness recovery context` describe 前增加：

```ts
describe("Harness Todo working notebook policy", () => {
  it("places the soft Todo policy in every Harness system prompt", () => {
    const prompt = buildHarnessSystemPrompt({
      soulSystemBaseContent: "persona",
      toolSystemContent: "tools",
    } as never);

    expect(prompt).toContain("[TODO_WORKING_NOTEBOOK_POLICY]");
    expect(prompt).toContain("至少 2 个 execution step");
    expect(prompt).toContain("不得作为后续行动的强约束");
  });
});
```

把 `src/main/orchestrator/harness/builtin-tools.test.ts` 的软规划测试扩成：

```ts
it("describes update_todo as a mutable notebook for multi-step tool work", () => {
  expect(updateTodoToolSpec.description).toContain("至少 2 个 execution step");
  expect(updateTodoToolSpec.description).toContain("tool round");
  expect(updateTodoToolSpec.description).toContain("可变工作笔记");
  expect(updateTodoToolSpec.description).toContain("单次工具即可完成");
  expect(updateTodoToolSpec.description).toContain("改变方向");
});
```

- [ ] **Step 6: 运行定向测试并确认缺少新策略**

Run: `npx vitest run src/main/orchestrator/harness-adapter.test.ts src/main/orchestrator/harness/builtin-tools.test.ts`

Expected: FAIL；system prompt 不含 `[TODO_WORKING_NOTEBOOK_POLICY]`，工具描述也缺少新阈值与 mutable 语义。

- [ ] **Step 7: 把策略接入 system prompt，并同步工具 description**

在 `src/main/orchestrator/harness-adapter.ts` 导入 `TODO_WORKING_NOTEBOOK_POLICY`，并在 `harnessPersona` 之后、`toolSystemContent` 之前执行：

```ts
parts.push(TODO_WORKING_NOTEBOOK_POLICY);
```

将 `updateTodoToolSpec.description` 的前三段调整为：

```ts
description:
  "更新可变工作笔记（Todo）。传入完整的新 TodoItem 数组（整表替换）。\n" +
  "何时使用：预计任务需要至少 2 个 execution step（执行步骤）或 tool round（工具推进轮次）时，优先建立并持续更新清单；不按 LLM 调用次数计算。\n" +
  "不要用于简单问答、纯闲聊或单次工具即可完成的任务。Todo 是可随事实和方向改变而重写的工作笔记，不是后续行动的强约束，也不是外部操作已经成功的证明。\n" +
```

保留其后现有 ID、单一 `in_progress` 和状态转移规则。

- [ ] **Step 8: 运行 Task 1 全部测试**

Run: `npx vitest run src/main/orchestrator/harness/todo-working-notebook.test.ts src/main/orchestrator/harness-adapter.test.ts src/main/orchestrator/harness/builtin-tools.test.ts`

Expected: 全部 PASS。

- [ ] **Step 9: 提交静态策略**

```bash
git add src/main/orchestrator/harness/todo-working-notebook.ts src/main/orchestrator/harness/todo-working-notebook.test.ts src/main/orchestrator/harness-adapter.ts src/main/orchestrator/harness-adapter.test.ts src/main/orchestrator/harness/builtin-tools.ts src/main/orchestrator/harness/builtin-tools.test.ts
git commit -m "feat: guide harness todo as a mutable notebook"
```

---

### Task 2: 每个 tool round 前注入实时 Todo 笔记快照

**Files:**
- Modify: `src/main/orchestrator/harness/todo-working-notebook.ts`
- Modify: `src/main/orchestrator/harness/todo-working-notebook.test.ts`
- Modify: `src/main/orchestrator/harness/cyrene-harness.ts`
- Modify: `src/main/orchestrator/harness/cyrene-harness.test.ts`

**Interfaces:**
- Consumes: `TodoItem[]` from the current Run's `AgentState.todoItems`。
- Produces: `buildCurrentTodoNotebookContext(items: TodoItem[]): string`。
- Behavior: 每次 `callLLM`、token budget 计算和 compaction 都使用本轮的 `roundSystemPrompt`；不修改基础 `input.systemPrompt`。

- [ ] **Step 1: 为只读快照渲染写失败测试**

在 `todo-working-notebook.test.ts` 增加：

```ts
import { buildCurrentTodoNotebookContext } from "./todo-working-notebook";

it("renders an empty mutable notebook without turning it into an obligation", () => {
  expect(buildCurrentTodoNotebookContext([])).toBe(
    `[CURRENT_TODO_NOTEBOOK mutable="true" binding="false"]\n（当前工作笔记为空）\n[/CURRENT_TODO_NOTEBOOK]`,
  );
});

it("renders the current Todo facts as a read-only notebook snapshot", () => {
  expect(buildCurrentTodoNotebookContext([
    { id: "inspect", content: "检查目录结构", status: "completed" },
    { id: "fix", content: "修正取消链路", status: "in_progress", activeForm: "正在修正取消链路" },
  ])).toBe(
    `[CURRENT_TODO_NOTEBOOK mutable="true" binding="false"]\n` +
    `[completed] inspect: 检查目录结构\n` +
    `[in_progress] fix: 修正取消链路（当前：正在修正取消链路）\n` +
    `[/CURRENT_TODO_NOTEBOOK]`,
  );
});
```

- [ ] **Step 2: 运行快照测试并确认渲染函数尚未实现**

Run: `npx vitest run src/main/orchestrator/harness/todo-working-notebook.test.ts`

Expected: FAIL，错误指向 `buildCurrentTodoNotebookContext` 尚未导出。

- [ ] **Step 3: 实现确定性的只读快照渲染**

在文件顶部增加 `import type { TodoItem } from "./types";`，并实现：

```ts
export function buildCurrentTodoNotebookContext(items: TodoItem[]): string {
  const header = `[CURRENT_TODO_NOTEBOOK mutable="true" binding="false"]`;
  if (items.length === 0) {
    return `${header}\n（当前工作笔记为空）\n[/CURRENT_TODO_NOTEBOOK]`;
  }

  const lines = items.map((item) => {
    const active = item.activeForm ? `（当前：${item.activeForm}）` : "";
    return `[${item.status}] ${item.id}: ${item.content}${active}`;
  });
  return `${header}\n${lines.join("\n")}\n[/CURRENT_TODO_NOTEBOOK]`;
}
```

- [ ] **Step 4: 验证快照渲染测试转绿**

Run: `npx vitest run src/main/orchestrator/harness/todo-working-notebook.test.ts`

Expected: 4 tests PASS。

- [ ] **Step 5: 为跨 tool round 的实时注入写失败集成测试**

在 `cyrene-harness.test.ts` 新增用例，使用现有 `assistantResponse`、`fakeFetchSequencer` 和 `mockedDispatch`：

```ts
it("shows the updated mutable Todo notebook to the next tool round", async () => {
  const updateCall: ToolCall = {
    id: "todo-1",
    name: "update_todo",
    arguments: JSON.stringify({
      todos: [{ id: "inspect", content: "检查项目结构", status: "in_progress" }],
    }),
  };
  const { fn: fetchMock } = fakeFetchSequencer([
    assistantResponse({ text: "先记一下步骤。", toolCalls: [updateCall] }),
    assistantResponse({ text: "现在继续检查。" }),
  ]);
  vi.stubGlobal("fetch", fetchMock);
  mockedDispatch.mockImplementation(async (_call, ctx) => {
    ctx.state.todoItems = [{ id: "inspect", content: "检查项目结构", status: "in_progress" }];
    return {
      outcome: "success",
      tool: "update_todo",
      message: "待办列表已更新",
      output: "{}",
    };
  });

  await runCyreneHarness({
    systemPrompt: "base prompt",
    messages: [{ role: "user", content: "检查并修复这个项目" }],
    tools: [],
    vendorConfig,
  });

  const firstRequest = fakeStreamChatWithSdk.mock.calls[0][0].request as { messages: ChatMessage[] };
  const secondRequest = fakeStreamChatWithSdk.mock.calls[1][0].request as { messages: ChatMessage[] };
  expect(firstRequest.messages[0].content).toContain("当前工作笔记为空");
  expect(secondRequest.messages[0].content).toContain("[in_progress] inspect: 检查项目结构");
  expect(secondRequest.messages[0].content).toContain(`binding="false"`);
});
```

如果 TypeScript 无法从 mock 推断 `ctx`，从 `tool-dispatcher.ts` 导出并导入现有 `ToolDispatchContext` 类型；不要为测试在生产对象上增加测试专用接口。

- [ ] **Step 6: 运行集成测试并确认第二轮看不到快照**

Run: `npx vitest run src/main/orchestrator/harness/cyrene-harness.test.ts -t "shows the updated mutable Todo notebook"`

Expected: FAIL；首轮 system message 不含空笔记，第二轮也不含更新后的 Todo。

- [ ] **Step 7: 在每次模型调用前构造 roundSystemPrompt**

在 `cyrene-harness.ts` 导入 `buildCurrentTodoNotebookContext`。在 while 循环的 signal 检查之后、token budget 计算之前构造：

```ts
const roundSystemPrompt = [
  input.systemPrompt,
  buildCurrentTodoNotebookContext(state.todoItems),
].join("\n\n---\n\n");
```

把本轮下列调用从 `input.systemPrompt` 改为 `roundSystemPrompt`：

```ts
computeTokenBudget(roundSystemPrompt, ...)
compressForAgentLoop({ systemPrompt: roundSystemPrompt, ... })
summarizeHistory(input.vendorConfig, roundSystemPrompt, ...)
callLLM(input.vendorConfig, roundSystemPrompt, ...)
```

只替换当前 round 的读取参数；不得写回 `input.systemPrompt`，避免下一轮重复叠加旧快照。

- [ ] **Step 8: 运行 Harness 与 Todo 定向测试**

Run: `npx vitest run src/main/orchestrator/harness/cyrene-harness.test.ts src/main/orchestrator/harness/cyrene-harness-cancel.test.ts src/main/orchestrator/harness/todo-working-notebook.test.ts src/main/orchestrator/harness/builtin-tools.test.ts src/main/orchestrator/harness-adapter.test.ts`

Expected: 全部 PASS；取消、终态和既有 Todo invariant 无回归。

- [ ] **Step 9: 运行完整验证**

Run: `npx vitest run`

Expected: 0 failed。

Run: `npm run build:main`

Expected: exit 0。

- [ ] **Step 10: 按四个验收场景实测**

1. “帮我查一下上海今天的天气”只调用一次天气工具，不因提示词强制建立 Todo。
2. “检查这个项目的取消链路并给出修复建议”预计包含至少两个 execution step / tool round，昔涟优先建立简短 Todo。
3. 执行中发现入口文件与预期不同，昔涟更新或重写 Todo，再按新方向继续；旧计划不会阻止新行动。
4. 用户中途说“先别查取消了，改看流式输出”，昔涟取消/替换旧项并建立新方向，后续模型调用看到更新后的只读快照。

- [ ] **Step 11: 提交实时笔记注入**

```bash
git add src/main/orchestrator/harness/todo-working-notebook.ts src/main/orchestrator/harness/todo-working-notebook.test.ts src/main/orchestrator/harness/cyrene-harness.ts src/main/orchestrator/harness/cyrene-harness.test.ts
git commit -m "feat: inject mutable todo notebook into harness rounds"
```
