# Task Todo Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve Cyrene's mutable, non-binding Todo notebook inside persistent Task child sessions so a resumed `task_id` continues with the last truthful working state.

**Architecture:** Keep the existing Harness `update_todo` contract and `AgentState.todoItems`; do not introduce OpenCode's `todowrite` name or database. Extend Task session checkpoints with a Todo snapshot, initialize resumed child Harness state from that snapshot, and keep parent and child Todos isolated.

**Tech Stack:** TypeScript 5.6, existing CyreneHarness, TaskSessionStore JSON persistence, Vitest 4.

## Global Constraints

- `update_todo` remains the only model-facing Todo tool.
- Todo remains a mutable working notebook and never becomes a completion guard or forced workflow.
- Persist Todos per private Task session, not globally and not in the normal chat index.
- New Task sessions begin with an empty Todo notebook.
- Resuming the same `task_id` restores its last Todo snapshot before the next model call.
- A child Todo never overwrites the parent Run Todo or another child Task Todo.
- Restart recovery preserves the Todo snapshot while converting `running` to `interrupted`.
- No new dependency.

---

### Task 1: Persist Todo state in Task sessions

**Files:**
- Modify: `src/shared/task-session.ts`
- Modify: `src/main/tasks/task-session-store.ts`
- Modify: `src/main/tasks/task-session-store.test.ts`

**Interfaces:**
- Produces: `TaskSession.todoItems: TodoItem[]` and `TaskSessionCheckpoint.todoItems?: TodoItem[]`.
- Consumes: shared `TodoItem` moved from Harness-only types to a shared Todo contract if required by import boundaries.

- [ ] **Step 1: Write the failing persistence test**

```ts
const task = store.create(createInput());
store.checkpoint(task.id, {
  todoItems: [{ id: "inspect", content: "检查取消链路", status: "in_progress" }],
});
const restarted = new TaskSessionStore(root);
expect(restarted.get(task.id)?.todoItems).toEqual([
  { id: "inspect", content: "检查取消链路", status: "in_progress" },
]);
```

Also mutate the returned array and assert the persisted session does not change.

- [ ] **Step 2: Run RED**

```powershell
npx vitest run src/main/tasks/task-session-store.test.ts
```

Expected: FAIL because Task sessions do not contain `todoItems`.

- [ ] **Step 3: Add the serialized snapshot**

Add `todoItems: TodoItem[]` to `TaskSession`, initialize it to `[]`, defensively validate status/content/id when reading disk, and deep-clone checkpoint input. Keep the existing 2,000-record trace cap unrelated to Todo length; enforce the current Harness Todo item bounds rather than inventing another limit.

- [ ] **Step 4: Verify and commit**

```powershell
npx vitest run src/main/tasks/task-session-store.test.ts
npm run build:main
git add src/shared/task-session.ts src/main/tasks/task-session-store.ts src/main/tasks/task-session-store.test.ts
git commit -m "feat: persist task todo notebooks"
```

---

### Task 2: Restore Todo when resuming a child Harness

**Files:**
- Modify: `src/main/orchestrator/harness/types.ts`
- Modify: `src/main/orchestrator/harness/cyrene-harness.ts`
- Modify: `src/main/orchestrator/harness/cyrene-harness.test.ts`
- Modify: `src/main/orchestrator/task-runtime.ts`
- Modify: `src/main/orchestrator/task-runtime.test.ts`

**Interfaces:**
- Produces: `HarnessInput.initialState?: AgentState`.
- Consumes: `TaskSession.todoItems` and existing `HarnessCheckpoint.state`.

- [ ] **Step 1: Write failing Harness initialization tests**

Pass:

```ts
initialState: {
  todoItems: [{ id: "inspect", content: "检查取消链路", status: "in_progress" }],
  uncertainEffects: [],
}
```

Assert the first model request contains that notebook. Mutate the original input after starting and prove Harness owns a clone.

- [ ] **Step 2: Run RED**

```powershell
npx vitest run src/main/orchestrator/harness/cyrene-harness.test.ts
```

Expected: FAIL because Harness always initializes an empty state.

- [ ] **Step 3: Initialize from a defensive clone**

Replace the fixed state initializer with a clone of `initialState` when supplied, otherwise preserve the empty default. Do not add completion obligations or continuation logic.

- [ ] **Step 4: Write failing Task resume tests**

Create a completed child with a persisted Todo, resume it, capture the next child Harness input, and assert `initialState.todoItems` matches. Create another Task under the same parent and assert it starts empty.

- [ ] **Step 5: Wire checkpoint and resume state**

In `TaskRuntime`, persist `checkpoint.state.todoItems` with every transcript checkpoint and pass the stored session Todo as `initialState.todoItems`. Keep `uncertainEffects` invocation-scoped until a separate safety design explicitly defines durable unresolved effects.

- [ ] **Step 6: Verify and commit**

```powershell
npx vitest run src/main/orchestrator/harness/cyrene-harness.test.ts src/main/orchestrator/task-runtime.test.ts src/main/tasks/task-session-store.test.ts
npm run build:main
git add src/main/orchestrator/harness/types.ts src/main/orchestrator/harness/cyrene-harness.ts src/main/orchestrator/harness/cyrene-harness.test.ts src/main/orchestrator/task-runtime.ts src/main/orchestrator/task-runtime.test.ts
git commit -m "feat: resume task todo context"
```

---

### Task 3: Close Todo recovery regressions

**Files:**
- Modify: `src/main/orchestrator/harness/todo-working-notebook.test.ts`
- Modify only if a proven defect exists: `src/main/orchestrator/harness/todo-working-notebook.ts`

- [ ] **Step 1: Add acceptance regressions**

Cover: empty new child, resumed mutable snapshot, model replacing an outdated resumed list, parent/child isolation, and restart `interrupted` recovery.

- [ ] **Step 2: Run focused and full verification**

```powershell
npx vitest run src/main/tasks/task-session-store.test.ts src/main/orchestrator/task-runtime.test.ts src/main/orchestrator/harness/cyrene-harness.test.ts src/main/orchestrator/harness/todo-working-notebook.test.ts
npx vitest run
npm run build:main
npm run build:preload
npm run build:renderer
```

- [ ] **Step 3: Commit regressions**

```powershell
git add src/main/orchestrator/harness/todo-working-notebook.test.ts
git commit -m "test: cover resumed task todo notebooks"
```

## Definition of Done

- Task Todo survives checkpoints and application restart.
- `task_id` resume restores the latest notebook before the next model call.
- New tasks and sibling tasks remain isolated.
- `update_todo` remains mutable, optional for simple work, and non-binding.
- No `todowrite` alias or new persistence dependency exists.
