# Harness Round Presentation and Todo Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Present each model function-calling turn as one collapsible activity round and restore interrupted Todo context without forcing model behavior.

**Architecture:** Harness emits explicit model-round boundaries while retaining standard AG-UI reasoning and tool events. Renderer persists round membership in the existing ChatMessage checkpoint and derives truthful summaries from tool names, arguments, and outcomes. Interrupted Todo recovery reuses the existing session JSON and injects a read-only recovery context into the next run.

**Tech Stack:** TypeScript, Electron IPC, RxJS/AG-UI, React, Ant Design X, Vitest.

## Global Constraints

- Do not change Code mode.
- Do not force `update_todo` through tool choice or Runtime continuation.
- Do not add a new UI or persistence dependency.
- Preserve old persisted messages through a legacy rendering fallback.
- Only count successful operations as completed facts; show failures separately.

---

### Task 1: Explicit Harness Round Boundaries

**Files:**
- Modify: `src/main/orchestrator/harness/types.ts`
- Modify: `src/main/orchestrator/harness/cyrene-harness.ts`
- Modify: `src/main/orchestrator/harness-adapter.ts`
- Test: `src/main/orchestrator/harness/cyrene-harness.test.ts`
- Test: `src/main/orchestrator/harness-adapter.test.ts`

**Interfaces:**
- Produces `HarnessEvent` variants `{ type: "round_start" | "round_end"; roundId: string }`.
- Maps them to `CUSTOM` events named `cyrene.round` with `{ action: "start" | "end", roundId }`.
- Emits standard `TOOL_CALL_ARGS` from existing `tool_start.args`.

- [ ] Add failing tests proving one start/end pair surrounds a tool round, a final round ends before final answer, and tool arguments reach AG-UI.
- [ ] Run the two targeted test files and confirm the new assertions fail.
- [ ] Emit `round-${rounds}` boundaries in every normally completed model call and map them through the adapter.
- [ ] Emit `TOOL_CALL_ARGS` immediately after `TOOL_CALL_START` using `JSON.stringify(event.args)`.
- [ ] Run the targeted tests and commit the passing task.

### Task 2: Persisted Round Presentation Model

**Files:**
- Modify: `src/shared/chat-types.ts`
- Modify: `src/renderer/react/features/chat/pages/ChatPage.tsx`
- Create: `src/renderer/react/features/chat/components/agent-rounds.ts`
- Create: `src/renderer/react/features/chat/components/agent-rounds.test.ts`

**Interfaces:**
- Produces `AgentRoundRecord { id, status, startedAt, completedAt?, processMessageIds, reasoningBlockIds, toolExecutionIds }`.
- Extends `ReasoningBlock`, `ProcessMessageRecord`, and `ToolExecutionRecord` with optional `roundId`; tools also retain optional `argsText`.
- Produces pure helpers `startAgentRound`, `finishAgentRound`, `attachRoundItem`, and `summarizeAgentRound`.

- [ ] Write failing reducer tests for start/end, event membership, successful counts, failure counts, and unknown-tool fallback.
- [ ] Run the new test and confirm failure.
- [ ] Implement the pure reducer and truthful Chinese summary mapping for `list_dir`, `read_file`, `write_file`, `edit_file`, `search_code`, and `run_shell`.
- [ ] Update ChatPage to bind ordered AG-UI events to the active round, accumulate `TOOL_CALL_ARGS`, and checkpoint `agentRounds`.
- [ ] Run reducer and session-runtime tests and commit the passing task.

### Task 3: Round-Based Activity UI

**Files:**
- Modify: `src/renderer/react/features/chat/components/ChatMessageList.tsx`
- Modify: `src/renderer/react/features/chat/components/ChatMessageList.css`
- Modify: `src/renderer/react/features/chat/components/ChatMessageList.test.ts`
- Modify: `src/renderer/react/features/chat/components/run-activity.test.ts`

**Interfaces:**
- Consumes `agentRounds` plus existing reasoning, process, and tool arrays.
- Keeps the existing legacy flat timeline only when a persisted message has no `agentRounds`.

- [ ] Add failing render tests proving one round produces one activity group and reasoning is not rendered as a peer item.
- [ ] Run renderer tests and confirm failure.
- [ ] Render one collapsible row per round: running title from current tool, completed title from `summarizeAgentRound`, and expanded body ordered as process text, reasoning, then tools.
- [ ] Preserve Run-level auto-collapse semantics and interrupted `keepExpanded` behavior.
- [ ] Run renderer tests and `npm run build:renderer`, then commit.

### Task 4: Todo Policy and Interrupted Recovery

**Files:**
- Modify: `src/main/orchestrator/harness/builtin-tools.ts`
- Modify: `src/shared/chat-types.ts`
- Modify: `src/renderer/react/features/chat/pages/ChatPage.tsx`
- Modify: `src/main/orchestrator/cyrene-agent.ts`
- Modify: `src/main/orchestrator/harness-adapter.ts`
- Test: `src/main/orchestrator/harness/builtin-tools.test.ts`
- Test: `src/main/orchestrator/harness-adapter.test.ts`
- Test: `src/renderer/react/features/chat/pages/session-runtime-state.test.ts`

**Interfaces:**
- Adds optional `recoveryContext` to the AG-UI run input and `CyreneRunOptions`.
- Builds recovery context only from the same session's latest interrupted snapshot with incomplete Todos.
- Appends `[RECOVERY_CONTEXT]` to the Harness system prompt.

- [ ] Add failing tests for soft Todo usage guidance and interrupted-only recovery context.
- [ ] Run targeted tests and confirm failure.
- [ ] Port the old tool's “when to use / when not to use” guidance into `update_todo` without forcing it.
- [ ] Build and inject the read-only recovery context, including the warning that Todo does not prove side effects completed.
- [ ] Run targeted tests and commit.

### Task 5: Remove Legacy Todo Infrastructure

**Files:**
- Modify: `src/main/orchestrator/built-in-tools.ts`
- Delete: `src/main/orchestrator/todo-store.ts`
- Delete: `src/main/todos/bootstrap.ts`
- Modify: `src/main/index.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/shared/ipc-channels.ts`
- Modify: related Todo tests and declarations discovered by `rg`.

**Interfaces:**
- `update_todo` remains the only model-visible Todo tool.
- ChatSession `runSnapshot.todos` remains the only active Todo persistence path.

- [ ] Add or update a registry test asserting `todo_write` is absent and `update_todo` remains available through Harness.
- [ ] Run the targeted test and confirm it fails before cleanup.
- [ ] Remove the legacy registration, store bootstrap, IPC channel, preload method, exports, and stale comments.
- [ ] Use `rg` to confirm there are no runtime references to `todo_write`, `TODOS_GET_CURRENT`, or `todo-store`.
- [ ] Run the full test suite and all three builds, then commit.

### Task 6: Final Regression Verification

**Files:**
- Modify only tests if a regression test exposes a product defect.

- [ ] Run all round, adapter, Todo, session, and activity tests.
- [ ] Run `npx vitest run`.
- [ ] Run `npm run build:main`, `npm run build:preload`, and `npm run build:renderer`.
- [ ] Confirm `dist/renderer/react/index.html` is not included in source commits.
- [ ] Review the final diff against every frozen semantic in the design spec.
