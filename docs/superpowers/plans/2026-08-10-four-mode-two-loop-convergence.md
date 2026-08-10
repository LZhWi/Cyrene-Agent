# Four Modes / Two Loops Convergence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将桌面会话收敛为 `work / chat / learn / code` 四种模式，并在类型和运行入口上保证系统只存在 `chatLoop` 与 `cyreneHarness` 两条 Agent 循环。

**Architecture:** `chat` 由 `CyreneAgent` 分流到 `runChatLoop`；`work / learn / code` 统一由 `CyreneAgent` 分流到现有 `runCyreneHarness`。旧 Daily 会话在存储初始化时原地迁移为 Work，保留标题、消息、工作区绑定和文件；Cline Runtime、SDK、后台任务、IPC、会话元数据及前端专属 UI 全部删除，不保留兼容分支。

**Tech Stack:** Electron、TypeScript、React、Vitest、RxJS、AG-UI、现有 CyreneHarness。

## Global Constraints

- 最终用户模式只能是 `work | chat | learn | code`。
- 最终 Agent 循环只能是 `runChatLoop` 与 `runCyreneHarness`；不得保留 legacy、LangGraph 或 Cline Runtime 分流。
- 旧 `daily` 会话迁移为 `work` 时，必须保留 `id`、标题、消息、置顶状态、时间戳和已有 `workspaceBinding`。
- 迁移不得移动、重命名或删除用户工作区中的磁盘文件。
- 旧 Daily 会话缺少工作区绑定时，继续使用现有 `userData/迁移文件夹` 兜底，以满足 Work 的可信工作区约束。
- 旧 Code 会话保留为 Code，删除持久化的 `codeSession` Cline 元数据，消息和工作区绑定保持不变。
- `daily_recommendation` 音乐来源、Scheduler 的 daily 周期、游戏脚本名等非会话概念不在删除范围。
- Learn 继续保留现有学习人设、Obsidian 工作区配置、学习进度 hook 和 Learn 工具，只替换执行循环。
- Code 第一阶段直接复用 Harness，不实现 Code 专属 prompt、工具集、Git、Plan/Act 或任务历史。
- 保留现有 canonical runId、exactly-once settlement、AbortSignal 取消、Ask、Todo、工具状态和终态展示语义。
- 不提交构建产物 `dist/renderer/react/index.html`。

---

## File Map

### 保留并修改

- `src/shared/chat-types.ts`：四模式领域类型；移除 Cline 会话元数据。
- `src/shared/chat-ui.ts`、`src/shared/todo-types.ts`：同步四模式和 Todo 模式类型。
- `src/main/chats/chats-store.ts`：Daily → Work 与 Code 元数据清理的持久化迁移。
- `src/main/chats/chats-ipc.ts`：移除 Cline mode IPC，只允许四种模式。
- `src/main/agui-bridge.ts`：四模式统一进入 `CyreneAgent`，删除 Code 旁路和 Code IPC。
- `src/main/orchestrator/cyrene-agent.ts`：以 execution mode 唯一决定 chatLoop / Harness。
- `src/main/orchestrator/chat-loop.ts`、`src/main/orchestrator/harness-adapter.ts`：把遗留 `TwoPhase*` 结果/事件类型改为中性的 Agent loop 类型。
- `src/main/orchestrator/build-options.ts`：不再产生旧 runtime selector。
- `src/main/orchestrator/context-manager.ts`、`src/main/orchestrator/tone-injector.ts`：移除会话 Daily 分支。
- `src/main/index.ts`：移除 Cline worker 生命周期。
- `src/shared/ipc-channels.ts`、`src/preload/index.ts`：删除 Cline/CodeRun IPC API。
- `src/renderer/react/components/ui/ModeSwitch.tsx`：只展示四种模式。
- `src/renderer/react/features/chat/pages/ChatPage.tsx`：删除 Daily 与 Cline/CodeRun 状态机。
- `src/renderer/react/features/chat/pages/openSessionByDeps.ts`：旧 Daily 深链归一为 Work。
- `src/renderer/react/features/chat/pages/conversation-run-policy.ts`：只接受四模式。
- `src/renderer/react/features/chat/components/ChatComposer.tsx`：移除 Daily 欢迎图和 Cline 控件。
- `src/renderer/react/features/chat/components/ConversationSidebar.tsx`：项目模式只包含 Work / Code。
- `src/renderer/react/features/chat/components/TodoPanel.tsx`：Todo 展示只覆盖 Work / Learn。
- `src/renderer/react/features/chat/components/ChatMessageList.tsx`：删除 Cline CodeRun 专属消息角色。
- `src/renderer/react/features/chat/components/run-presentation.ts`：保留 Harness Ask，删除 Cline verification/ask 适配。
- 与上述文件同目录的现有测试：更新为四模式、两循环断言。

### 删除

- `src/main/orchestrator/code/` 整个目录及其中测试。
- `src/renderer/lib/code-run-view-model.ts`。
- `src/renderer/react/features/chat/components/ClineModeSwitch.tsx`。
- `src/renderer/react/features/chat/components/ClineModeSwitch.css`。
- `src/renderer/react/features/chat/components/CodeRunPanel.tsx`。
- `src/renderer/react/features/chat/components/CodeRunPanel.css`。
- `src/renderer/react/assets/welcome/daily.png`。
- `package.json` 中 `@cline/sdk` 依赖和复制 `cline-esm-bridge.mjs` 的构建步骤；同步更新 `package-lock.json`。

---

### Task 1: 四模式类型与无损会话迁移

**Files:**
- Modify: `src/shared/chat-types.ts`
- Modify: `src/shared/chat-ui.ts`
- Modify: `src/shared/todo-types.ts`
- Modify: `src/main/chats/chats-store.ts`
- Modify: `src/main/chats/chats-store.test.ts`
- Modify: `src/main/chats/chats-ipc.ts`
- Modify: `src/main/chats/chats-ipc.test.ts`
- Modify: `src/preload/index.ts`

**Interfaces:**
- Produces: `ConversationMode = "chat" | "work" | "code" | "learn"`。
- Produces: 初始化后磁盘与 index 中均不存在会话模式 `daily`。
- Produces: `ChatSession` 不再暴露 `codeSession`。
- Consumes: 现有 `atomicWriteJson`、`legacyMigrationBinding` 与工作区绑定模型。

- [ ] **Step 1: 写 Daily 原地迁移的失败测试**

在 `chats-store.test.ts` 添加一个带真实临时存储的测试，手工写入 `index.json` 和 `sessions/daily-1.json`：

```ts
it("migrates persisted daily sessions to work without changing project data", () => {
  const binding = { workspaceRoot: "C:\\projects\\journal", displayName: "journal", boundAt: 123 };
  writePersistedSession({
    id: "daily-1",
    title: "原来的 Daily 项目",
    mode: "daily",
    messages: [{ id: "m1", role: "user", content: "保留我", at: 100 }],
    workspaceBinding: binding,
    codeSession: undefined,
  });

  initialize(testRoot);

  expect(getSession("daily-1")).toMatchObject({
    id: "daily-1",
    title: "原来的 Daily 项目",
    mode: "work",
    messages: [{ content: "保留我" }],
    workspaceBinding: binding,
  });
  expect(readPersistedSession("daily-1").mode).toBe("work");
  expect(readPersistedIndex()[0].mode).toBe("work");
});
```

同时添加：

```ts
it("removes obsolete Cline metadata while retaining a persisted code session", () => {
  writePersistedSession({
    id: "code-1",
    title: "代码项目",
    mode: "code",
    workspaceBinding: projectBinding,
    messages: retainedMessages,
    codeSession: { clineMode: "act", activeClineSessionId: "cline-1", tasks: [] },
  });

  initialize(testRoot);

  const session = readPersistedSession("code-1") as Record<string, unknown>;
  expect(session.mode).toBe("code");
  expect(session.messages).toEqual(retainedMessages);
  expect(session).not.toHaveProperty("codeSession");
});
```

- [ ] **Step 2: 运行测试并确认因旧模式仍存在而失败**

Run:

```powershell
npx vitest run src/main/chats/chats-store.test.ts src/main/chats/chats-ipc.test.ts
```

Expected: Daily 仍返回 `daily`，Code 仍包含 `codeSession`，测试失败。

- [ ] **Step 3: 实现单次、幂等的存储迁移**

将 `isConversationMode` 收紧为四模式；为磁盘中的旧值使用独立兼容判断，避免重新把 `daily` 加回领域类型：

```ts
function normalizePersistedMode(value: unknown, purpose?: ChatSessionPurpose): ConversationMode {
  if (value === "daily") return "work";
  if (value === "chat" || value === "work" || value === "code" || value === "learn") return value;
  return inferLegacyMode(purpose);
}
```

初始化迁移必须同时更新 session 文件与 index；若 Daily 已有 `workspaceBinding`，原样保留。仅当迁移后的非 Chat 会话没有 binding 时调用 `legacyMigrationBinding()`。迁移 Code 时删除旧字段：

```ts
const persisted = session as ChatSession & { mode?: unknown; codeSession?: unknown };
const nextMode = normalizePersistedMode(persisted.mode, persisted.purpose);
const changed = persisted.mode !== nextMode || "codeSession" in persisted;
persisted.mode = nextMode;
delete persisted.codeSession;
```

迁移函数重复执行不得再次修改 `updatedAt`、`boundAt` 或消息。

- [ ] **Step 4: 删除 Cline 会话 API 与五模式类型**

- 删除 `CodeSessionMetadata`、`ChatSession.codeSession`。
- 删除 `chatsStore.updateCodeSession` 与 `CHATS_SET_CODE_MODE` handler。
- Preload 的 `list/create` mode 参数收紧为四模式，删除 `setCodeMode`。
- `createSession({ mode: "code" })` 不再自动创建 Cline 元数据。
- 更新 store/ipc 测试，四模式集合必须精确为：

```ts
expect(new Set(listSessions().map((session) => session.mode))).toEqual(
  new Set(["chat", "work", "code", "learn"]),
);
```

- [ ] **Step 5: 验证迁移与类型测试**

Run:

```powershell
npx vitest run src/main/chats/chats-store.test.ts src/main/chats/chats-ipc.test.ts
npm run build:main
npm run build:preload
```

Expected: 测试通过；Main 和 Preload 编译通过。

- [ ] **Step 6: 提交 Task 1**

```powershell
git add src/shared/chat-types.ts src/shared/chat-ui.ts src/shared/todo-types.ts src/main/chats/chats-store.ts src/main/chats/chats-store.test.ts src/main/chats/chats-ipc.ts src/main/chats/chats-ipc.test.ts src/preload/index.ts
git commit -m "refactor: migrate conversations to four modes"
```

---

### Task 2: 在类型层固定两条 Agent Loop

**Files:**
- Modify: `src/main/orchestrator/cyrene-agent.ts`
- Modify: `src/main/orchestrator/cyrene-agent-runtime.test.ts`
- Modify: `src/main/orchestrator/chat-loop.ts`
- Modify: `src/main/orchestrator/harness-adapter.ts`
- Modify: `src/main/orchestrator/build-options.ts`
- Modify: `src/main/orchestrator/build-options.test.ts`
- Modify: `src/main/orchestrator/context-manager.ts`
- Modify: `src/main/orchestrator/tone-injector.ts`

**Interfaces:**
- Produces: `executionMode === "chat"` 唯一调用 `runChatLoop`；其余调用 Harness adapter。
- Produces: `CyreneRunOptions` 不再含 `agentRuntime`。
- Produces: 共享返回类型名为 `AgentLoopResult`，共享过程事件名为 `AgentLoopEvent`，源码不再残留 `TwoPhase*` 架构命名。
- Consumes: `conversationMode` 继续把 `work / learn / code` 传入 Harness、工具上下文和模式 prompt。

- [ ] **Step 1: 写两循环选择的失败测试**

将 runtime 测试改为观察真实分流，而非测试旧字符串 resolver：

```ts
it.each(["work", "learn", "code"] as const)(
  "routes %s through the harness adapter",
  async (conversationMode) => {
    await collectRun({ executionMode: "work", conversationMode });
    expect(runHarnessAgent).toHaveBeenCalledTimes(1);
    expect(runChatLoop).not.toHaveBeenCalled();
  },
);

it("routes chat through the SDK streaming chat loop", async () => {
  await collectRun({ executionMode: "chat", conversationMode: "chat" });
  expect(runChatLoop).toHaveBeenCalledTimes(1);
  expect(runHarnessAgent).not.toHaveBeenCalled();
});
```

为 `build-options.test.ts` 添加断言：结果不存在旧 runtime selector。

```ts
expect(result.options).not.toHaveProperty("agentRuntime");
```

- [ ] **Step 2: 运行测试并确认旧 API 导致失败**

Run:

```powershell
npx vitest run src/main/orchestrator/cyrene-agent-runtime.test.ts src/main/orchestrator/build-options.test.ts
```

Expected: 旧 `agentRuntime` 字段/断言仍存在，测试失败。

- [ ] **Step 3: 删除 runtime selector，保留直接二分**

从 `CyreneRunOptions` 删除：

```ts
agentRuntime?: "langgraph" | "legacy" | "harness";
```

删除 `resolveAgentRuntime`。`runWithEvents` 只保留：

```ts
if (executionMode === "chat") {
  result = await runChatLoop(chatInput);
} else {
  result = await runHarnessAgent(harnessInput);
}
```

不要依据 `conversationMode` 添加新的循环分支；Learn / Code 差异继续通过 prompt、Skill、工具注册和 `ToolContext.mode` 表达。

同时将已经被 ChatLoop 与 Harness 共用的遗留类型改名：

```ts
export interface AgentLoopResult {
  reply: string;
  toolResults: ToolCallResult[];
  completionReason: "no_tool" | "timeout" | "max_rounds" | "tool_error";
  totalUsage?: { input: number; output: number };
  terminal?: CyreneRunTerminalResult;
}

export interface AgentLoopEvent {
  type: string;
  messageId?: string;
  role?: string;
  delta?: string;
  toolCallId?: string;
  toolCallName?: string;
  stepName?: string;
  totalUsage?: unknown;
  content?: string;
  status?: string;
  snapshot?: unknown;
  taskPlan?: unknown;
}
```

迁移 `soulPhaseReason` 消费点到 `completionReason`；终态映射语义保持原样。不要保留类型别名兼容层，因为仓库内调用方会在同一 Task 一次性迁完。

- [ ] **Step 4: 清理旧 Daily 上下文分支**

- `context-manager.ts` 删除会话 `daily` case。
- `tone-injector.ts` 删除 `daily: "日常闲聊"`。
- `build-options.ts` 删除 `agentRuntime: "langgraph"`，保留四模式的人设和工具上下文构建。
- 更新注释，把“非 code 模式”“Work/Daily”等表述改成 Chat/Harness 边界。

- [ ] **Step 5: 验证 Agent 与选项构建**

Run:

```powershell
npx vitest run src/main/orchestrator/cyrene-agent-runtime.test.ts src/main/orchestrator/cyrene-agent.test.ts src/main/orchestrator/chat-loop.test.ts src/main/orchestrator/harness-adapter.test.ts src/main/orchestrator/build-options.test.ts
npm run build:main
```

Expected: 测试通过；Main 编译通过；源码中不再声明 `agentRuntime`。

- [ ] **Step 6: 提交 Task 2**

```powershell
git add src/main/orchestrator/cyrene-agent.ts src/main/orchestrator/cyrene-agent-runtime.test.ts src/main/orchestrator/chat-loop.ts src/main/orchestrator/harness-adapter.ts src/main/orchestrator/build-options.ts src/main/orchestrator/build-options.test.ts src/main/orchestrator/context-manager.ts src/main/orchestrator/tone-injector.ts
git commit -m "refactor: enforce chat and harness loops"
```

---

### Task 3: AG-UI 将 Work / Learn / Code 全部接入 Harness

**Files:**
- Modify: `src/main/agui-bridge.ts`
- Modify: `src/main/agui-bridge.test.ts`
- Modify: `src/main/orchestrator/harness-adapter.ts`
- Modify: `src/main/orchestrator/harness-adapter.test.ts`

**Interfaces:**
- Produces: 四模式共用同一 canonical runId、AbortController、settlement gate 与 AG-UI 事件转发。
- Produces: `code` 不再绕过 `CyreneAgent`。
- Consumes: Task 2 的 `executionMode` 二分与四模式 `ConversationMode`。

- [ ] **Step 1: 写 Code/Learn 进入标准链路的失败测试**

在 `agui-bridge.test.ts` 删除 `runCodeRequest` mock，添加：

```ts
it.each(["work", "learn", "code"] as const)(
  "routes %s through CyreneAgent and the harness run contract",
  async (mode) => {
    mocks.getSession.mockReturnValue({
      id: `${mode}-session`,
      mode,
      workspaceBinding: { workspaceRoot: `C:\\${mode}`, displayName: mode, boundAt: 1 },
    });

    const ack = await invokeAguiRun({ sessionId: `${mode}-session`, messages: userMessages });

    expect(mocks.agentRunOptions).toMatchObject({
      executionMode: "work",
      conversationMode: mode,
      runId: ack.runId,
    });
    expect(events).toContainEqual(expect.objectContaining({ type: "RUN_STARTED", runId: ack.runId }));
  },
);
```

为 Code 添加取消断言，证明它使用与 Work 相同的 AbortSignal：

```ts
expect(capturedOptions.signal?.aborted).toBe(false);
await invokeCancel(ack.runId);
expect(capturedOptions.signal?.aborted).toBe(true);
```

- [ ] **Step 2: 运行测试并确认 Code 仍旁路失败**

Run:

```powershell
npx vitest run src/main/agui-bridge.test.ts
```

Expected: Code 仍调用 `runCodeRequest`，没有捕获到标准 `CyreneAgent` options，测试失败。

- [ ] **Step 3: 删除 Code 顶层旁路**

从 `agui-bridge.ts` 删除：

- `runCodeRequest` 动态导入。
- `normalizeCodeRendererEvent` 与 `CODE_RENDERER_EVENT_TYPES`。
- `if (mode === "code")` 整个旁路。
- Cline run store/coordinator/ask imports。

把统一入口表达为：

```ts
const agentExecutionMode: AgentExecutionMode = mode === "chat" ? "chat" : "work";
const built = await buildOptionsFn({ ...input, mode, executionMode: agentExecutionMode });
built.options.executionMode = agentExecutionMode;
built.options.conversationMode = mode;
built.options.runId = runId;
built.options.signal = runAbortController.signal;
```

删除 bridge 对 `options.agentRuntime` 的赋值。Learn 的 Obsidian 注册/注销和 post-turn hook 必须保持原位置与终态条件。

- [ ] **Step 4: 验证 Harness 终态与取消不变量**

Run:

```powershell
npx vitest run src/main/agui-bridge.test.ts src/main/orchestrator/harness-adapter.test.ts src/main/orchestrator/harness-adapter-cancel.test.ts src/main/orchestrator/run-settlement.test.ts
```

Expected: Code/Work/Learn 均走 canonical run；cancelled/runtime_error/exactly-once 测试全部通过。

- [ ] **Step 5: 提交 Task 3**

```powershell
git add src/main/agui-bridge.ts src/main/agui-bridge.test.ts src/main/orchestrator/harness-adapter.ts src/main/orchestrator/harness-adapter.test.ts
git commit -m "refactor: route project modes through harness"
```

---

### Task 4: 删除 Cline Main Runtime、SDK 与 IPC

**Files:**
- Delete: `src/main/orchestrator/code/`
- Modify: `src/main/index.ts`
- Modify: `src/shared/ipc-channels.ts`
- Modify: `src/preload/index.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/main/orchestrator/model-config/model-runtime-profile.ts`
- Create: `src/main/runtime-surface.test.ts`

**Interfaces:**
- Produces: Main/Preload 不再导出任何 Cline、CodeRun 或 Code verification IPC。
- Produces: 依赖树中不再包含直接依赖 `@cline/sdk`。
- Consumes: Task 3 已使 Code 不依赖 Cline。

- [ ] **Step 1: 写静态架构门禁的失败测试**

新建或扩展现有架构测试，读取 `package.json`、IPC 常量和 `src/main` 文件列表：

```ts
it("has no Cline runtime dependency or IPC surface", () => {
  const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
  expect(pkg.dependencies).not.toHaveProperty("@cline/sdk");
  expect(Object.keys(IPC).filter((key) => key.startsWith("CODE_"))).toEqual([]);
  expect(Object.keys(IPC)).not.toContain("CHATS_SET_CODE_MODE");
  expect(existsSync(resolve("src/main/orchestrator/code"))).toBe(false);
});
```

建议放入 `src/main/agui-bridge.test.ts` 旁的 `runtime-surface.test.ts`，该测试保护用户要求的架构边界，不检查具体实现文本。

- [ ] **Step 2: 运行门禁并确认失败**

Run:

```powershell
npx vitest run src/main/runtime-surface.test.ts
```

Expected: SDK、IPC 和目录仍存在，测试失败。

- [ ] **Step 3: 删除 Cline 生命周期与 IPC**

- 从 `src/main/index.ts` 删除 `codeRunWorker` import 和 `cleanup()`。
- 从 `src/shared/ipc-channels.ts` 删除 `CHATS_SET_CODE_MODE` 及所有 `CODE_*` 常量。
- 从 `src/preload/index.ts` 删除 `codeRunApi` 和 `contextBridge.exposeInMainWorld("codeRun", ...)`。
- 从 `agui-bridge.ts` 删除文件尾部 Code run、verification、Ask 和 new-task handlers。
- `model-runtime-profile.ts` 只删除 Cline 专属注释/死字段；仍被 Harness 模型配置使用的字段保留。

- [ ] **Step 4: 删除 Runtime 文件与依赖**

使用 Git 可恢复删除：

```powershell
git rm -r -- src/main/orchestrator/code
npm uninstall @cline/sdk
```

将 `package.json` 的 `build:main` 恢复为纯 TypeScript 构建：

```json
"build:main": "tsc -p tsconfig.main.json"
```

- [ ] **Step 5: 验证 Main/Preload 与门禁**

Run:

```powershell
npx vitest run src/main/runtime-surface.test.ts src/main/agui-bridge.test.ts src/main/chats/chats-ipc.test.ts
npm run build:main
npm run build:preload
node -e "const p=require('./package.json'); process.exit(p.dependencies?.['@cline/sdk'] ? 1 : 0)"
```

Expected: 测试与构建通过；Node 依赖门禁 exit 0。若其他第三方包传递依赖同名包，只记录来源，不重新添加直接依赖。

- [ ] **Step 6: 提交 Task 4**

```powershell
git add package.json package-lock.json src/main/index.ts src/main/agui-bridge.ts src/shared/ipc-channels.ts src/preload/index.ts src/main/orchestrator/model-config/model-runtime-profile.ts src/main/runtime-surface.test.ts
git add -u src/main/orchestrator/code
git commit -m "refactor: remove Cline runtime"
```

---

### Task 5: 删除 Daily 与 Cline Renderer UI

**Files:**
- Modify: `src/renderer/react/components/ui/ModeSwitch.tsx`
- Modify: `src/renderer/react/features/chat/pages/ChatPage.tsx`
- Modify: `src/renderer/react/features/chat/pages/openSessionByDeps.ts`
- Modify: `src/renderer/react/features/chat/pages/openSessionByDeps.test.ts`
- Modify: `src/renderer/react/features/chat/pages/conversation-run-policy.ts`
- Modify: `src/renderer/react/features/chat/components/ChatComposer.tsx`
- Modify: `src/renderer/react/features/chat/components/ChatComposer.test.ts`
- Modify: `src/renderer/react/features/chat/components/ConversationSidebar.tsx`
- Modify: `src/renderer/react/features/chat/components/TodoPanel.tsx`
- Modify: `src/renderer/react/features/chat/components/last-turn-actions.test.ts`
- Modify: `src/renderer/react/features/chat/components/ChatMessageList.tsx`
- Modify: `src/renderer/react/features/chat/components/ChatMessageList.test.ts`
- Modify: `src/renderer/react/features/chat/components/run-presentation.ts`
- Modify: `src/renderer/react/features/chat/components/run-presentation.test.ts`
- Delete: `src/renderer/lib/code-run-view-model.ts`
- Delete: `src/renderer/react/features/chat/components/ClineModeSwitch.tsx`
- Delete: `src/renderer/react/features/chat/components/ClineModeSwitch.css`
- Delete: `src/renderer/react/features/chat/components/CodeRunPanel.tsx`
- Delete: `src/renderer/react/features/chat/components/CodeRunPanel.css`
- Delete: `src/renderer/react/assets/welcome/daily.png`

**Interfaces:**
- Produces: Renderer 只展示四模式，Code 使用标准 Harness 工具/Reasoning/Todo/Ask UI。
- Produces: 旧 Daily session 深链选择 Work。
- Consumes: Task 1 的四模式 API 与 Task 3 的统一 AG-UI 事件。

- [ ] **Step 1: 写四模式与 Daily 深链归一测试**

更新 `openSessionByDeps.test.ts`：

```ts
expect(normalizeSessionMode("daily")).toBe("work");
expect(normalizeSessionMode("chat")).toBe("chat");
expect(normalizeSessionMode("work")).toBe("work");
expect(normalizeSessionMode("learn")).toBe("learn");
expect(normalizeSessionMode("code")).toBe("code");
```

更新 ModeSwitch/Composer 测试，使 ModeSwitch 精确包含四个按钮，并证明 Code composer 不再渲染 Plan/Act 或“新 Cline Task”。

- [ ] **Step 2: 运行测试并确认 Daily/Cline UI 仍存在**

Run:

```powershell
npx vitest run src/renderer/react/features/chat/pages/openSessionByDeps.test.ts src/renderer/react/features/chat/components/ChatComposer.test.ts src/renderer/react/features/chat/components/ChatMessageList.test.ts
```

Expected: Daily 仍归一为 Daily，Cline props/UI 仍存在，测试失败。

- [ ] **Step 3: 移除 Daily 模式 UI**

- `ModeSwitch.tsx` 删除 DailyIcon 和 Daily item。
- `ChatPage.tsx` 的 `CONVERSATION_MODES` 改为 `chat/work/code/learn`；所有 `targetMode` 类型与创建标题判断同步收紧。
- `openSessionByDeps.ts` 将历史输入 `daily` 映射到 `work`，但 `ReactSessionMode` 不包含 Daily。
- `ChatComposer.tsx` 删除 Daily welcome asset 与映射；工作区文件支持改为 Work/Code，Learn 继续走 Obsidian 入口。
- `TodoPanel.tsx` mode 类型改为 `work | learn`。
- `ConversationSidebar.tsx` 的项目分组只包含 Work/Code。

- [ ] **Step 4: 移除 Cline/CodeRun UI 状态机**

从 `ChatPage.tsx` 删除：

- `CodeRunApi`、`codeRunApi()`、`selectedClineMode`。
- CodeRun 恢复、事件应用和 verification interaction 分支。
- `changeClineMode`、`createNewClineTask` 与三个 approval/ask handler。
- 传给 `ChatComposer` 的 Cline props。

从 `ChatComposer.tsx` 删除 Cline imports、props 与底部控件。Code 模式继续使用普通发送/停止/工作区交互。

从 `ChatMessageList.tsx` 删除 `CodeRunViewModel`、`CodeRunPanel`、`codeRun` 消息字段和 `codeRun` role。Harness 原有 reasoning、round、tool、Ask 展示保持不变。

从 `run-presentation.ts` 只删除 Cline verification/ask 的专属标准化；保留 `cyrene.choice` 对应的 Harness Ask。

删除列出的五个 Renderer 文件/资源。

- [ ] **Step 5: 验证 Renderer 行为**

Run:

```powershell
npx vitest run src/renderer/react/features/chat/pages/openSessionByDeps.test.ts src/renderer/react/features/chat/components/ChatComposer.test.ts src/renderer/react/features/chat/components/ChatMessageList.test.ts src/renderer/react/features/chat/components/run-presentation.test.ts src/renderer/react/features/chat/components/TodoPanel.test.ts src/renderer/react/features/chat/components/last-turn-actions.test.ts
npm run build:renderer
```

Expected: 测试和 Renderer 构建通过；Code 消息使用与 Work/Learn 相同的 Harness 活动展示。

- [ ] **Step 6: 提交 Task 5**

```powershell
git add src/renderer/react src/renderer/lib/code-run-view-model.ts
git add -u src/renderer/react/assets/welcome/daily.png
git commit -m "refactor: expose four harness-backed modes"
```

---

### Task 6: 全局架构验收与残留清理

**Files:**
- Modify: 仅修改残留扫描明确发现、且属于会话 Daily 或 Cline 的文件。
- Test: 全量 Vitest 与三端构建。

**Interfaces:**
- Produces: 四模式、两循环的可重复架构门禁。
- Consumes: Tasks 1–5 的全部结果。

- [ ] **Step 1: 扫描 Cline 与旧循环残留**

Run:

```powershell
rg -n -i "cline|runCodeRequest|CodeRunViewModel|agentRuntime|TwoPhaseFcResult|TwoPhaseEvent|runTwoPhaseFcLoop|runLangGraphAgentLoop" src package.json
```

Expected: 无产品代码命中。测试 fixture 若只用于验证迁移旧 JSON，可保留 `cline` 字符串并加注释说明其为历史数据输入。

- [ ] **Step 2: 扫描会话 Daily 残留并分类**

Run:

```powershell
rg -n "daily" src
```

允许保留：

- `daily_recommendation` 音乐领域。
- Scheduler `schedule.kind === "daily"`。
- 游戏脚本/配方名称。
- Daily → Work 存储迁移与深链兼容测试中的历史字面量。

不允许保留：

- `ConversationMode`、React 模式数组、Preload 会话 API、Todo 模式类型中的 Daily。
- Daily welcome、模式按钮、独立执行路径、旧 runtime assignment。

- [ ] **Step 3: 运行全量测试**

Run:

```powershell
npx vitest run
```

Expected: 0 failed；项目既有 skip 数量可以保留并在施工汇报中记录。

- [ ] **Step 4: 运行三端构建**

Run:

```powershell
npm run build:main
npm run build:preload
npm run build:renderer
```

Expected: 三条命令 exit 0。Renderer 既有 chunk-size warning 不是本次阻塞项。

- [ ] **Step 5: 人工验收四模式**

逐项验证：

1. 打开旧 Daily 会话：出现在 Work，标题、消息和绑定工作区不变。
2. Chat：首 token 持续流式出现；工具、Todo、Ask 不可用。
3. Work：工具、Todo、Ask、停止、终态展示正常。
4. Learn：Obsidian 工具、学习人设、Todo、停止、终态展示正常。
5. Code：不显示 Plan/Act/Cline Task；通过 Harness 正常调用文件/终端工具，停止键可取消。
6. 在 Work/Learn/Code 运行期间切换会话再返回：已展示活动、Todo 和待处理 Ask 按会话恢复。

- [ ] **Step 6: 检查工作树并提交残留清理**

Run:

```powershell
git status --short
git diff --check
```

确认不暂存 `dist/renderer/react/index.html`，然后：

```powershell
git add -u src package.json package-lock.json
git commit -m "test: enforce four modes and two loops"
```

---

## Final Invariants

实施结束后，以下语句必须同时为真：

```text
ConversationMode = chat | work | learn | code

chat
  -> CyreneAgent
  -> runChatLoop

work | learn | code
  -> CyreneAgent
  -> harness-adapter
  -> runCyreneHarness

不存在：
  Cline Runtime
  legacy TwoPhaseFC runtime selector
  LangGraph runtime selector
  Daily conversation mode
```

终态、取消和副作用不变量保持：

```text
每个 canonical runId
  -> exactly one terminal settlement
  -> success | cancelled | timeout | runtime_error

Run cancelled
  != 已发生的外部效果一定撤销
```
