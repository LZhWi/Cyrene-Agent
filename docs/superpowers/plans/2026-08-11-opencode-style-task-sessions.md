# OpenCode-Style Task Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Cyrene's disposable legacy sub-agents with persistent, resumable Harness child sessions exposed through one foreground `task` tool, while showing only “昔涟委托了 xxx” in the parent conversation and reserving a read-only trace boundary for a future right-side viewer.

**Architecture:** Borrow OpenCode's parent/child session identity, resumable `task_id`, permission inheritance, foreground wait, and cancellation propagation, but keep Cyrene's existing Harness, vendor SDK adapters, permission service, AG-UI bridge, and atomic JSON persistence patterns. A new `TaskSessionStore` persists private child transcripts and traces outside normal chat sessions; `TaskRuntime` owns child lifecycle; the Harness `task` builtin is a thin model-facing adapter. The first release has no background execution, no nested Task, no direct user interaction from a child, and no child sessions in the chat sidebar.

**Tech Stack:** TypeScript 5.6, Electron 43, React 19, AG-UI 0.0.57, Vitest 4, Node.js filesystem APIs, existing CyreneHarness and vendor SDK adapters.

## Global Constraints

- Reuse OpenCode's lifecycle ideas only; do not add OpenCode, Effect, its database layer, or another agent runtime as a dependency.
- Persist task data under `<userData>/cyrene-tasks/`, separate from `<userData>/cyrene-chats/`; private task sessions never appear in the left chat list.
- The model-facing tool is named `task` and accepts `description`, `prompt`, `subagent_type`, and optional `task_id`.
- `description` is the only parent-conversation label and must be 3-40 trimmed characters. The renderer displays exactly `昔涟委托了 ${description}`.
- `prompt` is the full child instruction and is not rendered in the parent conversation.
- The first release supports foreground execution only. The parent Harness waits for the child result before continuing.
- A supplied `task_id` resumes the same child transcript. It must belong to the current parent conversation and use the same sub-agent profile.
- A task child inherits the parent's vendor/model, conversation mode, trusted workspace root, enabled tool set, permission callback, and cancellation signal.
- Child tool execution uses a distinct child run ID for ledger identity and trace storage. Permission prompts remain bound to the parent run ID so the existing parent cancellation cleanup remains correct.
- Child sessions cannot call `task`, `ask_user`, or `confirm_uncertain_effect`. There is no nested task execution and no direct child-to-user conversation.
- Parent cancellation settles the child as `cancelled`; application restart normalizes an on-disk `running` task to `interrupted`, which is resumable but never auto-resumed.
- Task lifecycle states are `running`, `completed`, `failed`, `cancelled`, and `interrupted`.
- Child internal reasoning, progress text, tool events, and Todo snapshots are stored in the private task trace. They are not forwarded into the parent conversation in this release.
- The parent conversation stores a compact delegation record containing `taskId`, `description`, `subagentType`, `status`, and timestamps. This is the stable extension point for a future right-side trace viewer.
- Work and Code expose `task`; Learn and Chat do not expose it in this release.
- Existing `delegate_task`, `delegate_document`, `delegate_search`, and the LangGraph-era `subagents/` runtime are removed only after compatibility tests prove the new profiles cover their live behavior.
- No background tasks, child chat sidebar, child composer, user-to-child messages, nested tasks, or automatic restart recovery are implemented in this plan.
- Preserve the existing dirty `dist/renderer/react/index.html`; it is a generated artifact and is not included in task commits.

---

## File Structure

- `src/shared/task-session.ts`: serializable task session, trace, lifecycle, result, and parent-conversation presentation contracts.
- `src/main/tasks/task-session-store.ts`: atomic private task persistence, parent ownership checks, resume updates, and restart interruption normalization.
- `src/main/tasks/task-session-store.test.ts`: disk layout, ownership, atomic updates, and restart recovery tests.
- `src/main/orchestrator/task-profiles.ts`: built-in `general`, `document`, and `search` child profile registry and tool allowlists.
- `src/main/orchestrator/task-profiles.test.ts`: profile lookup and blocked-tool invariants.
- `src/main/orchestrator/task-runtime.ts`: create/resume child session, derive child Harness input, checkpoint transcript/trace, map terminal state, and return the parent observation.
- `src/main/orchestrator/task-runtime.test.ts`: lifecycle, resume, isolation, cancellation, and permission binding tests.
- `src/main/orchestrator/harness/types.ts`: transcript checkpoint callback and injected task executor boundary.
- `src/main/orchestrator/harness/cyrene-harness.ts`: configurable builtin exposure and round-level transcript checkpoints.
- `src/main/orchestrator/harness/builtin-tools.ts`: `task` schema, strict argument validation, and thin executor.
- `src/main/orchestrator/harness/builtin-tools.test.ts`: schema, validation, missing-runtime, resume, and cancellation tests.
- `src/main/orchestrator/harness/tool-dispatcher.ts`: dispatch the new Harness builtin without treating it as an atomic registry tool.
- `src/main/orchestrator/harness-adapter.ts`: construct the parent-bound `TaskRuntime` callback for Work and Code.
- `src/main/orchestrator/harness-adapter.test.ts`: mode visibility and parent dependency propagation tests.
- `src/main/orchestrator/task-events.ts`: convert child Harness events into serializable private trace records and parent lifecycle events.
- `src/main/orchestrator/task-events.test.ts`: event sanitization and parent-event minimality tests.
- `src/shared/chat-types.ts`: persisted `TaskDelegationRecord[]` on an assistant message.
- `src/renderer/react/features/chat/components/run-presentation.ts`: validate `cyrene.task` parent events.
- `src/renderer/react/features/chat/components/TaskDelegationRow.tsx`: compact “昔涟委托了 xxx” presentation with a stable future-open callback.
- `src/renderer/react/features/chat/components/TaskDelegationRow.test.tsx`: exact copy and no leaked child transcript tests.
- `src/renderer/react/features/chat/components/ChatMessageList.tsx`: render persisted task delegation rows inside the parent run activity.
- `src/renderer/react/features/chat/components/RunExperience.css`: minimal white/pink task row styling.
- `src/renderer/react/features/chat/pages/ChatPage.tsx`: consume `cyrene.task`, checkpoint delegation records, and keep them scoped to the owning conversation.
- `src/main/orchestrator/built-in-tools.ts`: remove deprecated delegation tool registrations after migration.
- `src/main/orchestrator/sub-agent.ts`: delete the disposable old FC-loop child runner after migration.
- `src/main/orchestrator/subagents/`: delete the old graph, runner, profile, result parser, and their obsolete tests after behavior moves to Task profiles.
- `prompts/tools_system.md`: teach Work and Code when to delegate and how to resume.
- `prompts/tools_system_optimized_first.md`: keep the optimized common tool guidance semantically identical.

---

### Task 1: Freeze the persistent Task session contract and store

**Files:**
- Create: `src/shared/task-session.ts`
- Create: `src/main/tasks/task-session-store.ts`
- Create: `src/main/tasks/task-session-store.test.ts`

**Interfaces:**
- Produces: `TaskSession`, `TaskSessionStatus`, `TaskTraceRecord`, `TaskDelegationRecord`, `TaskSessionStore`.
- Produces: `createTaskSession`, `getTaskSession`, `resumeTaskSession`, `checkpointTaskSession`, and `listTaskSessionsForParent` methods.
- Consumes: vendor `ChatMessage`, `ConversationMode`, and trusted workspace data already derived by the parent conversation.

- [ ] **Step 1: Write failing persistence and ownership tests**

Use a temporary user-data root and assert the exact private layout and restart behavior:

```ts
const store = new TaskSessionStore(tempRoot, () => 1000, () => "task-1");
const created = store.create({
  parentConversationId: "chat-1",
  parentRunId: "run-1",
  description: "检查取消链路",
  prompt: "检查项目的取消传播并报告证据",
  subagentType: "general",
  mode: "code",
  resolvedWorkspaceRoot: "E:\\project",
  messages: [{ role: "user", content: "检查项目的取消传播并报告证据" }],
});

expect(created.status).toBe("running");
expect(store.get("task-1")?.parentConversationId).toBe("chat-1");
expect(store.listForParent("chat-2")).toEqual([]);
expect(fs.existsSync(path.join(tempRoot, "cyrene-tasks", "sessions", "task-1.json"))).toBe(true);
```

Recreate the store from disk and assert a persisted `running` session becomes `interrupted`. Assert `resume("task-1", { parentConversationId: "chat-2" })` throws `TASK_PARENT_MISMATCH`, while a matching parent appends a new user prompt and returns `running`.

- [ ] **Step 2: Run the store test and verify it fails**

Run:

```powershell
npx vitest run src/main/tasks/task-session-store.test.ts
```

Expected: FAIL because the Task session contract and store do not exist.

- [ ] **Step 3: Define the serializable contracts**

Create these exact public shapes:

```ts
export type TaskSessionStatus = "running" | "completed" | "failed" | "cancelled" | "interrupted";
export type TaskSubagentType = "general" | "document" | "search";

export interface TaskTraceRecord {
  id: string;
  at: number;
  kind: "round" | "progress" | "reasoning" | "tool" | "todo" | "terminal";
  phase?: "start" | "delta" | "end";
  label?: string;
  content?: string;
  status?: string;
}

export interface TaskSession {
  schemaVersion: 1;
  id: string;
  parentConversationId: string;
  parentRunId: string;
  childRunId: string;
  description: string;
  subagentType: TaskSubagentType;
  mode: "work" | "code";
  resolvedWorkspaceRoot?: string;
  status: TaskSessionStatus;
  messages: import("../main/orchestrator/vendors/types").ChatMessage[];
  trace: TaskTraceRecord[];
  resultText?: string;
  error?: { code: string; message: string };
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface TaskDelegationRecord {
  taskId: string;
  description: string;
  subagentType: TaskSubagentType;
  status: TaskSessionStatus;
  delegatedAt: number;
  updatedAt: number;
}
```

If importing a Main-only vendor type into `shared` breaks the Renderer compilation boundary, move the minimal serializable model message shape into this shared file and make vendor `ChatMessage` structurally satisfy it. Do not import Electron or filesystem code into `shared`.

- [ ] **Step 4: Implement the atomic store**

Use the proven `chats-store.ts` pattern: `index.json`, `sessions/<id>.json`, write a sibling `.tmp`, then rename. The store constructor accepts a root path for testability and production receives `app.getPath("userData")`. Validate parsed JSON defensively; ignore malformed index rows, but never silently return a foreign-parent session from `resume`.

```ts
export class TaskSessionStore {
  constructor(root: string, now = Date.now, createId = randomUUID) {}
  create(input: CreateTaskSessionInput): TaskSession;
  get(taskId: string): TaskSession | null;
  listForParent(parentConversationId: string): TaskSession[];
  resume(taskId: string, input: ResumeTaskSessionInput): TaskSession;
  checkpoint(taskId: string, patch: TaskSessionCheckpoint): TaskSession;
}
```

During initialization, rewrite every valid `running` session to `interrupted`, update its timestamp, and preserve transcript and trace. Cap trace persistence at the newest 2,000 records per child session so a long task cannot grow without bound.

- [ ] **Step 5: Run Task 1 verification**

Run:

```powershell
npx vitest run src/main/tasks/task-session-store.test.ts
npm run build:main
```

Expected: all Task store tests PASS and Main compilation exits 0.

- [ ] **Step 6: Commit Task 1**

```powershell
git add src/shared/task-session.ts src/main/tasks/task-session-store.ts src/main/tasks/task-session-store.test.ts
git commit -m "feat: persist private task sessions"
```

---

### Task 2: Replace graph profiles with declarative Harness profiles

**Files:**
- Create: `src/main/orchestrator/task-profiles.ts`
- Create: `src/main/orchestrator/task-profiles.test.ts`

**Interfaces:**
- Consumes: `TaskSubagentType`, parent-enabled `ToolDefinition[]`, and `ConversationMode`.
- Produces: `TaskAgentProfile`, `getTaskAgentProfile(type)`, and `resolveTaskTools(profile, parentTools)`.

- [ ] **Step 1: Write failing profile tests**

Assert all live legacy capabilities have a profile and that forbidden tools never reach children:

```ts
expect(getTaskAgentProfile("general").id).toBe("general");
expect(getTaskAgentProfile("document").allowedToolIds).toContain("write_word");
expect(getTaskAgentProfile("search").allowedToolIds).toEqual(expect.arrayContaining(["web_search", "fetch_url"]));

const resolved = resolveTaskTools(getTaskAgentProfile("general"), parentTools);
expect(resolved.map((tool) => tool.id)).not.toEqual(expect.arrayContaining([
  "task", "delegate_task", "delegate_document", "delegate_search", "ask_user", "confirm_uncertain_effect",
]));
```

Also prove a profile cannot gain a tool the parent did not have enabled.

- [ ] **Step 2: Run the profile test and verify it fails**

Run:

```powershell
npx vitest run src/main/orchestrator/task-profiles.test.ts
```

Expected: FAIL because the declarative Task profile registry does not exist.

- [ ] **Step 3: Implement three focused profiles**

Define:

```ts
export interface TaskAgentProfile {
  id: TaskSubagentType;
  name: string;
  description: string;
  systemPrompt: string;
  allowedToolIds: "inherit" | readonly string[];
  maxRounds: number;
  timeoutMs: number;
}
```

Profiles:

- `general`: inherit parent tools after the universal blocklist; concise investigation/implementation prompt; 30 rounds; 240 seconds.
- `document`: allow `write_word`, `write_excel`, `write_pdf`, `write_markdown`, `write_file`, `read_file`, and `list_dir`; require reporting exact artifact paths and verifying created files; 20 rounds; 180 seconds.
- `search`: allow `web_search` and `fetch_url`; require source URLs and distinguish facts from inference; 20 rounds; 180 seconds.

The child system prompt must say it reports to the parent agent, cannot contact the user, must use existing context before guessing, and must finish with a concise evidence-backed result. It must not include Cyrene's full user-facing persona because the child does not author the formal reply.

- [ ] **Step 4: Run Task 2 verification**

Run:

```powershell
npx vitest run src/main/orchestrator/task-profiles.test.ts
npm run build:main
```

Expected: tests PASS and Main compilation exits 0.

- [ ] **Step 5: Commit Task 2**

```powershell
git add src/main/orchestrator/task-profiles.ts src/main/orchestrator/task-profiles.test.ts
git commit -m "feat: define harness task profiles"
```

---

### Task 3: Add child transcript checkpoints and private trace projection

**Files:**
- Modify: `src/main/orchestrator/harness/types.ts`
- Modify: `src/main/orchestrator/harness/cyrene-harness.ts`
- Modify: `src/main/orchestrator/harness/cyrene-harness.test.ts`
- Create: `src/main/orchestrator/task-events.ts`
- Create: `src/main/orchestrator/task-events.test.ts`

**Interfaces:**
- Produces: `HarnessCheckpoint`, `HarnessInput.onCheckpoint`, and `projectTaskTraceEvent(event)`.
- Preserves: existing Harness finalization ownership and public event behavior.
- Consumes: serializable `TaskTraceRecord` from Task 1.

- [ ] **Step 1: Write failing round-checkpoint tests**

Run a two-round Harness response containing one tool call and assert the callback receives a cloned transcript after the assistant/tool result pair and again at terminal settlement:

```ts
const checkpoints: HarnessCheckpoint[] = [];
await runCyreneHarness({
  ...input,
  onCheckpoint: (checkpoint) => { checkpoints.push(checkpoint); },
});
expect(checkpoints.at(-1)?.messages.some((message) => message.role === "tool")).toBe(true);
expect(checkpoints.at(-1)?.rounds).toBe(2);
```

Assert mutating a received checkpoint does not mutate Harness's live message array.

- [ ] **Step 2: Run the checkpoint test and verify it fails**

Run:

```powershell
npx vitest run src/main/orchestrator/harness/cyrene-harness.test.ts
```

Expected: FAIL because `onCheckpoint` is not part of `HarnessInput`.

- [ ] **Step 3: Implement the checkpoint boundary**

Add:

```ts
export interface HarnessCheckpoint {
  messages: ChatMessage[];
  state: AgentState;
  rounds: number;
  at: number;
}
```

Call `onCheckpoint` after every completed round and immediately before each terminal return. Clone messages, Todo items, and uncertain effects before invoking external code. A checkpoint failure must be logged and converted to a `runtime_error`; persistent child context is part of Task correctness and must not be silently discarded.

- [ ] **Step 4: Write failing trace projection tests**

Prove that reasoning deltas, progress, tool lifecycle, Todo snapshots, and terminal state become bounded serializable records, while an unknown event becomes `undefined`. Verify no raw tool arguments or full tool outputs are stored in the trace record.

```ts
expect(projectTaskTraceEvent({ type: "tool_start", toolCallId: "c1", toolName: "read_file", args: { secret: "x" } }, 1000))
  .toMatchObject({ kind: "tool", phase: "start", label: "read_file" });
expect(JSON.stringify(record)).not.toContain("secret");
```

- [ ] **Step 5: Implement private trace projection**

Generate stable record IDs with `randomUUID`, keep text fields at most 2,000 characters, and store only tool name/status—not tool arguments. This boundary is deliberately UI-independent so a future right panel can query it without replaying AG-UI events.

- [ ] **Step 6: Run Task 3 verification**

Run:

```powershell
npx vitest run src/main/orchestrator/harness/cyrene-harness.test.ts src/main/orchestrator/task-events.test.ts
npm run build:main
```

Expected: tests PASS and Main compilation exits 0.

- [ ] **Step 7: Commit Task 3**

```powershell
git add src/main/orchestrator/harness/types.ts src/main/orchestrator/harness/cyrene-harness.ts src/main/orchestrator/harness/cyrene-harness.test.ts src/main/orchestrator/task-events.ts src/main/orchestrator/task-events.test.ts
git commit -m "feat: checkpoint harness child runs"
```

---

### Task 4: Implement foreground TaskRuntime create, resume, and cancel

**Files:**
- Create: `src/main/orchestrator/task-runtime.ts`
- Create: `src/main/orchestrator/task-runtime.test.ts`

**Interfaces:**
- Consumes: `TaskSessionStore`, Task profiles, `runCyreneHarness`, parent vendor/model/tools/workspace/mode/permission callback/signal.
- Produces: `TaskExecuteRequest`, `TaskExecuteResult`, and `createTaskExecutor(parent): (request) => Promise<TaskExecuteResult>`.

- [ ] **Step 1: Write failing create-and-complete tests**

Mock `runCyreneHarness` and assert a fresh task creates a private session, uses a distinct child run ID, filters tools through its profile, omits interactive builtins, persists checkpoints, and completes with a truthful result:

```ts
const result = await execute({
  description: "检查取消链路",
  prompt: "检查取消传播并列出证据",
  subagentType: "general",
});
expect(result).toMatchObject({ status: "completed", taskId: expect.any(String), text: "检查完成" });
expect(store.get(result.taskId)?.resultText).toBe("检查完成");
expect(childInput.toolContext?.runId).not.toBe(parent.runId);
```

- [ ] **Step 2: Write failing resume and ownership tests**

Resume with `taskId` and assert the prior transcript is passed into the next child Harness call with one new user prompt appended. Assert foreign parent conversation, changed profile, active running session, and missing task ID each fail with stable codes:

```text
TASK_NOT_FOUND
TASK_PARENT_MISMATCH
TASK_PROFILE_MISMATCH
TASK_ALREADY_RUNNING
```

- [ ] **Step 3: Write failing cancellation and permission tests**

Abort the parent signal while the child Harness is pending. Assert the same signal reaches the child, the store records `cancelled`, and no second child round begins. Capture the child's permission callback and prove it still uses the parent run's permission function while the child's `ToolContext.runId` remains distinct.

- [ ] **Step 4: Run TaskRuntime tests and verify they fail**

Run:

```powershell
npx vitest run src/main/orchestrator/task-runtime.test.ts
```

Expected: FAIL because `TaskRuntime` does not exist.

- [ ] **Step 5: Implement the foreground runtime**

Use dependency injection rather than importing application singletons in tests:

```ts
export interface TaskRuntimeParentContext {
  parentConversationId: string;
  parentRunId: string;
  mode: "work" | "code";
  systemPrompt: string;
  vendorConfig: VendorConfig;
  tools: ToolDefinition[];
  resolvedWorkspaceRoot?: string;
  signal?: AbortSignal;
  checkPermission?: HarnessInput["checkPermission"];
}

export function createTaskExecutor(input: {
  parent: TaskRuntimeParentContext;
  store: TaskSessionStore;
  runHarness?: typeof runCyreneHarness;
}): (request: TaskExecuteRequest) => Promise<TaskExecuteResult>;
```

For a new task, create one child session. For resume, validate parent/profile before appending the new user prompt. Build the child system prompt from the profile plus a short trusted workspace/mode envelope; do not append the full user-facing persona. Pass the parent's vendor config, filtered tool definitions, trusted workspace, permission callback, and signal. Do not pass a child task executor or user clarification callback.

Map terminal results exactly:

```ts
success       -> completed
cancelled     -> cancelled
timeout       -> failed with TASK_TIMEOUT
runtime_error -> failed with TASK_RUNTIME_ERROR
```

Return child `finalAnswer` to the parent as `text`. Never claim completion if terminal status is not `success`.

- [ ] **Step 6: Run Task 4 verification**

Run:

```powershell
npx vitest run src/main/orchestrator/task-runtime.test.ts src/main/tasks/task-session-store.test.ts src/main/orchestrator/task-profiles.test.ts
npm run build:main
```

Expected: tests PASS and Main compilation exits 0.

- [ ] **Step 7: Commit Task 4**

```powershell
git add src/main/orchestrator/task-runtime.ts src/main/orchestrator/task-runtime.test.ts
git commit -m "feat: run resumable harness tasks"
```

---

### Task 5: Expose one strict Harness `task` tool in Work and Code

**Files:**
- Modify: `src/main/orchestrator/harness/types.ts`
- Modify: `src/main/orchestrator/harness/builtin-tools.ts`
- Modify: `src/main/orchestrator/harness/builtin-tools.test.ts`
- Modify: `src/main/orchestrator/harness/tool-dispatcher.ts`
- Modify: `src/main/orchestrator/harness/cyrene-harness.ts`
- Modify: `src/main/orchestrator/harness-adapter.ts`
- Modify: `src/main/orchestrator/harness-adapter.test.ts`

**Interfaces:**
- Consumes: `createTaskExecutor` from Task 4.
- Produces: `HarnessInput.executeTask`, `taskToolSpec`, and `executeTaskTool`.
- Preserves: `ask_user` exclusivity, normal tool dispatch, ledger semantics, and exactly-once parent settlement.

- [ ] **Step 1: Write failing schema and validation tests**

Assert this exact model-facing contract:

```ts
{
  description: string,
  prompt: string,
  subagent_type: "general" | "document" | "search",
  task_id?: string,
}
```

Reject blank/over-40-character descriptions, blank prompts, unknown profiles, blank supplied task IDs, and unavailable runtime without opening a child. Ensure the tool description says `task_id` is only for continuing an existing child session.

- [ ] **Step 2: Run builtin tests and verify they fail**

Run:

```powershell
npx vitest run src/main/orchestrator/harness/builtin-tools.test.ts
```

Expected: FAIL because the Harness does not advertise or dispatch `task`.

- [ ] **Step 3: Implement the thin builtin**

Add:

```ts
export interface HarnessTaskRequest {
  description: string;
  prompt: string;
  subagentType: TaskSubagentType;
  taskId?: string;
}

export interface HarnessTaskResult {
  taskId: string;
  status: TaskSessionStatus;
  text: string;
}
```

`executeTaskTool` validates arguments, emits `task_delegated` once, awaits the injected executor, emits `task_settled`, and returns a structured observation containing task ID, status, and result text. It must rethrow cancellation and return a failure observation for other stable Task errors.

- [ ] **Step 4: Advertise Task only when an executor exists**

Change builtin discovery to accept capabilities:

```ts
getHarnessBuiltinToolSpecs({
  askUser: Boolean(input.requestUserClarification),
  task: Boolean(input.executeTask),
});
```

Child Harness input has neither callback, so it cannot see Ask or Task. Parent Work/Code receives `executeTask`; Learn and Chat do not.

- [ ] **Step 5: Wire TaskRuntime in the adapter**

Create a production `TaskSessionStore` rooted at `app.getPath("userData")` during Main startup or through a lazy singleton module. In `runHarnessWithAdapter`, provide `executeTask` only when mode is `work` or `code` and `conversationId` is available. Reuse the already-filtered parent tools and the existing permission callback. Pass the canonical parent run ID and existing abort signal.

- [ ] **Step 6: Run Task 5 verification**

Run:

```powershell
npx vitest run src/main/orchestrator/harness/builtin-tools.test.ts src/main/orchestrator/harness-adapter.test.ts src/main/orchestrator/harness/cyrene-harness.test.ts src/main/orchestrator/harness/cyrene-harness-cancel.test.ts
npm run build:main
```

Expected: all targeted tests PASS; Work and Code advertise `task`; Learn does not; child Harness input advertises neither Task nor Ask.

- [ ] **Step 7: Commit Task 5**

```powershell
git add src/main/orchestrator/harness/types.ts src/main/orchestrator/harness/builtin-tools.ts src/main/orchestrator/harness/builtin-tools.test.ts src/main/orchestrator/harness/tool-dispatcher.ts src/main/orchestrator/harness/cyrene-harness.ts src/main/orchestrator/harness-adapter.ts src/main/orchestrator/harness-adapter.test.ts
git commit -m "feat: expose foreground task tool"
```

---

### Task 6: Persist the minimal parent UI delegation record

**Files:**
- Modify: `src/shared/chat-types.ts`
- Modify: `src/main/orchestrator/harness/types.ts`
- Modify: `src/main/orchestrator/harness-adapter.ts`
- Modify: `src/main/orchestrator/harness-adapter.test.ts`
- Modify: `src/renderer/react/features/chat/components/run-presentation.ts`
- Modify: `src/renderer/react/features/chat/components/run-presentation.test.ts`
- Create: `src/renderer/react/features/chat/components/TaskDelegationRow.tsx`
- Create: `src/renderer/react/features/chat/components/TaskDelegationRow.test.tsx`
- Modify: `src/renderer/react/features/chat/components/ChatMessageList.tsx`
- Modify: `src/renderer/react/features/chat/components/ChatMessageList.test.ts`
- Modify: `src/renderer/react/features/chat/components/RunExperience.css`
- Modify: `src/renderer/react/features/chat/pages/ChatPage.tsx`

**Interfaces:**
- Consumes: `task_delegated` and `task_settled` Harness events.
- Produces: AG-UI custom event `cyrene.task`, normalized `TaskDelegationRecord`, and optional `onOpenTaskTrace(taskId)` component callback.
- Persists: task delegation records on the owning assistant `ChatMessage`.

- [ ] **Step 1: Write failing event-minimality tests**

Assert the adapter emits only this public shape and stamps canonical parent thread/run IDs:

```ts
{
  type: "CUSTOM",
  name: "cyrene.task",
  value: {
    action: "delegated",
    taskId: "task-1",
    description: "检查取消链路",
    subagentType: "general",
    status: "running",
    at: 1000,
  },
}
```

Assert it does not contain `prompt`, child messages, reasoning, tool arguments, workspace path, or result text. The settled event may update `status` and `updatedAt`, but still contains no private trace.

- [ ] **Step 2: Write failing Renderer normalization and component tests**

Reject malformed IDs/status/profile and verify the rendered copy exactly:

```tsx
const html = renderToStaticMarkup(<TaskDelegationRow delegation={record} />);
expect(html).toContain("昔涟委托了 检查取消链路");
expect(html).not.toContain("检查项目的取消传播并报告证据");
expect(html).not.toContain("completed");
```

Pass `onOpenTaskTrace` and click in a DOM test; assert it receives only `taskId`. Without the callback the row remains visually present and has no fake navigation behavior. This callback is the future right-side viewer seam; do not build the panel now.

- [ ] **Step 3: Run the UI boundary tests and verify they fail**

Run:

```powershell
npx vitest run src/main/orchestrator/harness-adapter.test.ts src/renderer/react/features/chat/components/run-presentation.test.ts src/renderer/react/features/chat/components/TaskDelegationRow.test.tsx
```

Expected: FAIL because no Task event or row exists.

- [ ] **Step 4: Add persisted delegation records to assistant messages**

Add `taskDelegations?: TaskDelegationRecord[]` to shared `ChatMessage` and the Renderer message view model. In `ChatPage`, scope each event to the run's `sessionId`, upsert by `taskId`, and include the array in every running/terminal checkpoint. Switching conversations must restore the owning conversation's rows and never leak them to another session.

- [ ] **Step 5: Render one compact line per delegated task**

Render `TaskDelegationRow` inside the existing activity timeline, outside child tool/reasoning detail because those events are private. Use existing PNG mood/avatar treatment if the surrounding activity section already supplies it; do not introduce a boxed task card. Styling stays white/pink and the visible copy remains exactly `昔涟委托了 ${description}`.

- [ ] **Step 6: Run Task 6 verification**

Run:

```powershell
npx vitest run src/main/orchestrator/harness-adapter.test.ts src/renderer/react/features/chat/components/run-presentation.test.ts src/renderer/react/features/chat/components/TaskDelegationRow.test.tsx src/renderer/react/features/chat/components/ChatMessageList.test.ts
npm run build:main
npm run build:renderer
```

Expected: tests PASS; both builds exit 0; the Task row survives a persisted-chat round trip.

- [ ] **Step 7: Commit Task 6**

```powershell
git add src/shared/chat-types.ts src/main/orchestrator/harness/types.ts src/main/orchestrator/harness-adapter.ts src/main/orchestrator/harness-adapter.test.ts src/renderer/react/features/chat/components/run-presentation.ts src/renderer/react/features/chat/components/run-presentation.test.ts src/renderer/react/features/chat/components/TaskDelegationRow.tsx src/renderer/react/features/chat/components/TaskDelegationRow.test.tsx src/renderer/react/features/chat/components/ChatMessageList.tsx src/renderer/react/features/chat/components/ChatMessageList.test.ts src/renderer/react/features/chat/components/RunExperience.css src/renderer/react/features/chat/pages/ChatPage.tsx
git commit -m "feat: show persisted task delegations"
```

---

### Task 7: Migrate live legacy delegates and remove the old runtimes

**Files:**
- Modify: `src/main/orchestrator/built-in-tools.ts`
- Modify: `src/main/orchestrator/built-in-tools.test.ts`
- Delete: `src/main/orchestrator/sub-agent.ts`
- Delete: `src/main/orchestrator/sub-agent.test.ts`
- Delete: `src/main/orchestrator/subagents/document-agent.ts`
- Delete: `src/main/orchestrator/subagents/search-agent.ts`
- Delete: `src/main/orchestrator/subagents/graph.ts`
- Delete: `src/main/orchestrator/subagents/graph.test.ts`
- Delete: `src/main/orchestrator/subagents/init.ts`
- Delete: `src/main/orchestrator/subagents/outcome-adapter.ts`
- Delete: `src/main/orchestrator/subagents/repeat-protection.test.ts`
- Delete: `src/main/orchestrator/subagents/result-parser.ts`
- Delete: `src/main/orchestrator/subagents/runner.ts`
- Delete: `src/main/orchestrator/subagents/search-agent-e2e.test.ts`
- Delete: `src/main/orchestrator/subagents/search-agent.test.ts`
- Delete: `src/main/orchestrator/subagents/types.ts`
- Modify: `src/main/startup/bootstrap-config.ts`
- Modify: every remaining import/type reference reported by `rg "delegate_task|delegate_document|delegate_search|subagents/|setDelegateSettings" src`

**Interfaces:**
- Consumes: Task profiles and `task` tool from Tasks 2-5.
- Removes: legacy disposable FC loop and deterministic LangGraph-style child graph registration.
- Preserves: direct atomic document/search tools and their permission/effect metadata.

- [ ] **Step 1: Write failing registry migration tests**

Assert the new runtime exposes exactly one delegation entry and retains direct atomic tools:

```ts
expect(toolNames).not.toEqual(expect.arrayContaining(["delegate_task", "delegate_document", "delegate_search"]));
expect(harnessToolNames).toContain("task");
expect(toolNames).toEqual(expect.arrayContaining(["write_word", "web_search", "fetch_url"]));
```

Add one end-to-end TaskRuntime test per migrated profile: document receives only its document allowlist; search receives only `web_search`/`fetch_url`; both return their child final text to the parent.

- [ ] **Step 2: Run migration tests before deletion**

Run:

```powershell
npx vitest run src/main/orchestrator/built-in-tools.test.ts src/main/orchestrator/task-runtime.test.ts
```

Expected: the legacy delegation registrations are still present, so the registry assertion FAILS.

- [ ] **Step 3: Remove legacy registrations and startup injection**

Delete the three `delegate_*` registrations, `registerBuiltInSubAgentProfiles()`, `setDelegateSettings()`, and the bootstrap injection. Keep underlying atomic tools unchanged. Remove `executionKind`, `subAgentProfile`, and other registry fields only if `rg` proves no non-legacy consumer remains after deletion; otherwise retain them until a separate cleanup.

- [ ] **Step 4: Delete obsolete runtime files**

Delete only the files listed above after `rg` shows their exports have no remaining production consumer. Do not delete `task-plan.ts`, generic Harness planning/Todo support, document writers, search tools, or Soul projection code merely because the old sub-agent graph imported them.

- [ ] **Step 5: Prove no legacy path remains**

Run:

```powershell
rg -n "delegate_task|delegate_document|delegate_search|runFunctionCallingLoop|subagents/|setDelegateSettings" src/main prompts
```

Expected: no production references to the legacy delegate names or old child runtime. References inside historical design documents are allowed and are not rewritten.

- [ ] **Step 6: Run Task 7 verification**

Run:

```powershell
npx vitest run src/main/orchestrator/built-in-tools.test.ts src/main/orchestrator/task-runtime.test.ts src/main/orchestrator/task-profiles.test.ts
npm run build:main
```

Expected: tests PASS and Main compilation exits 0.

- [ ] **Step 7: Commit Task 7**

```powershell
git add -A src/main/orchestrator src/main/startup/bootstrap-config.ts
git commit -m "refactor: retire legacy subagent runtimes"
```

Before committing, inspect `git diff --cached --name-status` and unstage any unrelated file. In particular, do not stage `dist/renderer/react/index.html`.

---

### Task 8: Teach Cyrene when to delegate and close full regression

**Files:**
- Modify: `prompts/tools_system.md`
- Modify: `prompts/tools_system_optimized_first.md`
- Modify: prompt-focused tests discovered with `rg -l "tools_system|update_todo|ask_user" src/main -g '*.test.ts'`

**Interfaces:**
- Consumes: final `task` schema and profile names.
- Produces: shared Work/Code delegation policy and `task_id` resume guidance.

- [ ] **Step 1: Write failing prompt assertions**

Assert the common tool prompt includes all of these semantics:

```text
Use task for a self-contained multi-step investigation or operation whose intermediate context does not need to occupy the parent conversation.
Use task_id only to continue the same previously delegated task.
Do not delegate a single atomic tool call.
Do not delegate work that requires asking the user while the child is running.
Do not poll, duplicate, or redo the child's work while a foreground task is running.
```

The shipped Chinese prompt must express these meanings naturally; the test should assert stable key phrases rather than the entire paragraph.

- [ ] **Step 2: Run prompt tests and verify they fail**

Run the prompt-focused test file returned by the repository search.

Expected: FAIL because the existing prompt still references legacy delegates or has no resumable Task guidance.

- [ ] **Step 3: Add one shared Task policy**

Add the same policy to both prompt variants. Tell the model:

- delegate only self-contained multi-step work;
- choose `general`, `document`, or `search` by actual capability;
- pass a concise 3-40 character description for the user-visible row;
- put complete instructions in `prompt` because the child cannot ask the user;
- reuse `task_id` for follow-up work on the same child context;
- use ordinary tools directly for atomic actions;
- wait for the foreground result, then continue the parent reasoning and produce the final user-facing answer with Cyrene's full persona.

- [ ] **Step 4: Run the complete Task-focused suite**

Run:

```powershell
npx vitest run src/main/tasks/task-session-store.test.ts src/main/orchestrator/task-profiles.test.ts src/main/orchestrator/task-events.test.ts src/main/orchestrator/task-runtime.test.ts src/main/orchestrator/harness/builtin-tools.test.ts src/main/orchestrator/harness/cyrene-harness.test.ts src/main/orchestrator/harness/cyrene-harness-cancel.test.ts src/main/orchestrator/harness-adapter.test.ts src/renderer/react/features/chat/components/run-presentation.test.ts src/renderer/react/features/chat/components/TaskDelegationRow.test.tsx src/renderer/react/features/chat/components/ChatMessageList.test.ts
```

Expected: all Task lifecycle, cancellation, persistence, mode, and UI tests PASS.

- [ ] **Step 5: Run full verification**

Run:

```powershell
npx vitest run
npm run build:main
npm run build:preload
npm run build:renderer
```

Expected: all builds exit 0. If the full suite still contains independently reproducible baseline failures in untouched modules, record their exact files and assertions; do not weaken Task tests or unrelated behavior to manufacture a green run.

- [ ] **Step 6: Commit Task 8**

```powershell
git add prompts/tools_system.md prompts/tools_system_optimized_first.md src/main/**/*.test.ts
git diff --cached --name-only
git commit -m "feat: teach harness resumable task delegation"
```

Use the staged-file inspection to remove unrelated tests before committing.

---

## Acceptance Scenarios

### Scenario 1: Fresh foreground delegation

User asks Code mode to inspect a large cancellation subsystem. The parent calls:

```json
{
  "description": "检查取消链路",
  "prompt": "检查取消从 AG-UI bridge 到 Harness 和工具执行的完整传播，列出文件和证据。",
  "subagent_type": "general"
}
```

The parent message shows only `昔涟委托了 检查取消链路`. The child runs privately, the parent waits, and the result returns to the parent model before Cyrene writes the formal reply.

### Scenario 2: Resume the same child context

After Task `task-123` completes, the parent decides the same investigation needs one more check and calls `task` with `task_id: "task-123"`. The stored transcript is reused, the new prompt is appended, no new task file is created, and the same parent delegation row is updated rather than duplicated.

### Scenario 3: Conversation isolation

While a task belongs to conversation A, the user switches to conversation B. B displays no Task row. Returning to A restores `昔涟委托了 ...` from persisted assistant-message data. A model in B cannot resume A's task ID and receives `TASK_PARENT_MISMATCH`.

### Scenario 4: Parent cancellation

The user presses Stop while a child is reading files. The parent signal cancels the child Harness, the private session records `cancelled`, no later child model/tool round starts, pending permission tied to the parent run is cleaned up, and the parent run settles exactly once as `cancelled`.

### Scenario 5: Application restart during a task

The process exits after a child checkpoint was written while status was `running`. On the next startup the task becomes `interrupted`; its transcript and trace remain. Nothing auto-executes. The parent may explicitly resume it later with `task_id`.

### Scenario 6: Specialized document and search work

`document` sees only document/file tools inherited from the parent; `search` sees only web search/fetch tools. Neither sees Task or Ask. Their private transcripts remain resumable and their result text returns through the same Task observation contract.

### Scenario 7: Future right-side viewer seam

`TaskDelegationRow` can receive `onOpenTaskTrace(taskId)` and the Main task store already contains sanitized trace records. No child chat history or composer exists, and no raw child prompt or tool arguments are present in the parent message.

## Definition of Done

- One canonical `task` tool replaces all live `delegate_*` tools.
- Task children run on CyreneHarness rather than the legacy FC loop or LangGraph-style child graph.
- Fresh and resumed Task sessions are atomically persisted outside chat sessions.
- A task ID is scoped to its parent conversation and fixed sub-agent profile.
- Parent cancellation propagates to the child and produces truthful child and parent terminal states.
- Restarted `running` tasks become resumable `interrupted` tasks without automatic execution.
- Child permissions and workspace roots are inherited from trusted parent context; child model arguments cannot override them.
- Child Task, Ask, and uncertain-effect confirmation tools are unavailable.
- Work and Code expose Task; Learn and Chat do not.
- Parent UI displays only `昔涟委托了 xxx`, persists it per conversation, and leaks no private child trace.
- A typed task ID callback and sanitized task trace store exist for the future right-side process viewer.
- Legacy `sub-agent.ts`, `subagents/`, registrations, and startup injection have no remaining production references.
- No OpenCode runtime dependency or new package is introduced.
- Task-focused tests and all three application builds pass.
