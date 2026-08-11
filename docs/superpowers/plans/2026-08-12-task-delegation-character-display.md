# Task Delegation Character Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show each foreground Task in the parent run as a compact weighted-random character delegation row whose nickname is unique while active and released on settlement.

**Architecture:** Main owns a per-conversation weighted character lease pool and emits sanitized `cyrene.task` lifecycle events from TaskRuntime. Renderer persists those events on the parent assistant message and renders a borderless row with the matching PNG. No detail viewer or child transcript UI is added.

**Tech Stack:** TypeScript 5.6, Electron Main, AG-UI custom events, React 19, Vitest 4.

## Global Constraints

- Active nicknames are unique within one parent conversation.
- Weights are renormalized over available candidates; relative weights never change.
- Completed, failed, and cancelled invocations release their lease in `finally`.
- Main chooses identity; Renderer only validates and displays it.
- Parent events contain no child prompt, reasoning, trace, or tool arguments.
- The row is persisted with the owning assistant message and has no card or detail panel.

---

### Task 1: Weighted character lease pool

**Files:**
- Create: `src/main/tasks/task-character-pool.ts`
- Create: `src/main/tasks/task-character-pool.test.ts`

**Interfaces:**
- Produces: `TaskCharacterLeasePool.acquire(conversationId, random): TaskCharacterLease` and idempotent `release()`.
- Produces: nickname and asset filename only; Renderer resolves the actual URL.

- [ ] Write literal-boundary tests using random values `0`, `0.149`, and `0.15`, plus a sequence proving an active 风堇 cannot be selected twice.
- [ ] Run `npx vitest run src/main/tasks/task-character-pool.test.ts` and confirm failure because the module does not exist.
- [ ] Implement weighted selection by subtracting candidate weights from `random() * availableWeightTotal`; ordinary characters each use `45 / 7`.
- [ ] Add exhaustion behavior that rejects with `TASK_CHARACTER_POOL_EXHAUSTED`; make release idempotent.
- [ ] Re-run the test and commit the pool files.

### Task 2: TaskRuntime lifecycle events

**Files:**
- Modify: `src/shared/task-session.ts`
- Modify: `src/main/orchestrator/task-runtime.ts`
- Modify: `src/main/orchestrator/task-runtime.test.ts`
- Modify: `src/main/orchestrator/harness-adapter.ts`
- Modify: `src/main/orchestrator/harness/builtin-tools.ts`
- Modify: `src/main/orchestrator/harness/tool-dispatcher.ts`
- Modify: `src/main/orchestrator/harness/types.ts`
- Modify only the Task dispatch hunk: `src/main/orchestrator/harness/cyrene-harness.ts`

**Interfaces:**
- Produces: sanitized `TaskDelegationPresentation` with `invocationId`, `taskId`, `description`, `nickname`, `assetFileName`, and `status`.
- Consumes: one lease per Task invocation.

- [ ] Add TaskRuntime tests asserting a running event precedes Harness execution, terminal event reuses invocation/nickname, prompt is absent, and release happens for completed, failed, and cancelled paths.
- [ ] Run the TaskRuntime tests and confirm the missing lifecycle API failures.
- [ ] Extend `createTaskExecutor` dependencies with a lease pool and `onLifecycle`; emit running after session creation and terminal in `finally`.
- [ ] Have the adapter send lifecycle records as `CUSTOM` event `cyrene.task`; remove the temporary `progress_text` Task label.
- [ ] Run TaskRuntime, builtin, adapter tests and Main build; commit only Task-related hunks, excluding the user's prompt trace hunk.

### Task 3: Persist and render the delegation row

**Files:**
- Modify: `src/shared/chat-types.ts`
- Create: `src/renderer/react/features/chat/components/task-delegations.ts`
- Create: `src/renderer/react/features/chat/components/task-delegations.test.ts`
- Create: `src/renderer/react/features/chat/components/TaskDelegationRow.tsx`
- Create: `src/renderer/react/features/chat/components/TaskDelegationRow.test.tsx`
- Modify: `src/renderer/react/features/chat/components/ChatMessageList.tsx`
- Modify: `src/renderer/react/features/chat/pages/ChatPage.tsx`
- Modify: `src/renderer/react/features/chat/components/RunExperience.css`

**Interfaces:**
- Produces: `applyTaskDelegationEvent(records, event, roundId)` that upserts by invocation ID.
- Produces: compact `TaskDelegationRow` with running/completed/failed/cancelled states.

- [ ] Add reducer tests proving start inserts, terminal updates instead of appending, and different conversations remain isolated through existing message checkpoints.
- [ ] Add server-rendered component tests proving nickname, exact copy, PNG alt text, and terminal state marker.
- [ ] Run the tests and confirm failures because reducer/component do not exist.
- [ ] Implement shared persisted records, event normalization, `ChatPage` checkpoint updates, and row rendering inside its owning agent round.
- [ ] Add scoped white/pink borderless styling and a running-only breathing animation honoring reduced-motion preferences.
- [ ] Run renderer tests and all three builds; commit renderer/shared files.

### Task 4: Regression verification

**Files:** No production files unless a verified defect requires correction.

- [ ] Run Task-focused tests: character pool, TaskRuntime, Harness builtins, adapter, task reducer, and row component.
- [ ] Run `npm run build:main`, `npm run build:preload`, and `npm run build:renderer`.
- [ ] Run `npx vitest run`; report unrelated pre-existing failures separately and do not change them without a failing Task-specific reproduction.
- [ ] Inspect `git diff --check` and ensure `src/renderer/tast/*.png` are included while the user's prompt trace remains unstaged.
