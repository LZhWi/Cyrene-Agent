# Session Runtime and Todo Panel Implementation Plan

> **For Cyrene maintainers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task by task. Each behavior change must follow `superpowers:test-driven-development`; run `superpowers:verification-before-completion` before claiming completion.

**Goal:** Preserve each conversation's live Agent UI across session switches, make Work cold-start deterministic, scope Todo state to the owning conversation/run, checkpoint recoverable run presentation to the existing chat store, and keep the Todo footer visible.

**Architecture:** Keep non-serializable execution control in main and serializable presentation in renderer, keyed first by `sessionId` and guarded by canonical `runId`. Reuse the existing JSON chat store and IPC bridge for snapshots; do not add Redux, Zustand, SQLite, an event log, or another state dependency. Disk data may hydrate an inactive session, but may never replace a live in-memory projection.

**Tech Stack:** Electron, React 19, TypeScript, Vitest, existing JSON chat store, AG-UI events, CSS flex layout.

---

## Global constraints

- Do not change Code mode execution behavior.
- Do not serialize `AbortController`, subscriptions, promises, provider streams, or other execution-control objects.
- Keep `sessionId` as the primary presentation owner; use `runId` only to reject stale/misrouted events within that session.
- Do not write every token to disk. Persist only run start, Todo/interaction/tool boundaries, debounced text/reasoning, and terminal state.
- Exclude the pre-existing generated change `dist/renderer/react/index.html` from every commit.
- Keep the existing legacy mode Todo store available for non-Harness compatibility, but do not let its mode-wide broadcast overwrite a session-owned Harness Todo card.

## Task 1: Repair live-session ownership and hydration

**Files:**

- Modify: `src/renderer/react/features/chat/pages/ChatPage.tsx`
- Modify: `src/renderer/react/features/chat/pages/session-runtime-state.test.ts`

1. Add a failing regression test proving that an actual active-run record preserves the current session's live assistant message while an inactive session still hydrates from disk.
2. Run `npx vitest run src/renderer/react/features/chat/pages/session-runtime-state.test.ts` and confirm the new integration-facing assertion fails against the ref-wrapper-shaped input or missing helper.
3. Remove `activeRunsBySessionRef = useRef(activeRunsBySession)` from `ChatPage.tsx`.
4. Replace every `activeRunsBySessionRef.current` read/write with `activeRunsBySession.current`. Do not duplicate the run map.
5. Keep `hydrateSessionMessages(..., Boolean(activeRunsBySession.current[sessionId]))` as the only disk-overwrite gate.
6. Ensure permission ownership lookup also reads the real map:

   ```ts
   const ownerSessionId = findSessionIdForRun(activeRunsBySession.current, request.runId)
     ?? currentSessionId;
   ```

7. Run the focused test, then `npx vitest run src/renderer/react/features/chat/pages/session-runtime-state.test.ts src/renderer/react/features/chat/pages/ChatPage.test.ts`.
8. Commit as `fix: preserve live session presentation across switches`.

## Task 2: Make cold-start call real dependencies

**Files:**

- Modify: `src/renderer/react/features/chat/pages/openSessionByDeps.ts`
- Modify: `src/renderer/react/features/chat/pages/openSessionByDeps.test.ts`
- Modify: `src/renderer/react/features/chat/pages/ChatPage.tsx`

1. Add failing tests for a pure `bootstrapReactSession` helper:
   - URL session opens successfully, then `refreshSessions(currentMode, false)` runs once;
   - missing/invalid URL session falls back to `refreshSessions(currentMode, true)`;
   - no URL session refreshes/selects immediately;
   - an open failure still executes the fallback refresh before rejecting or returning.
2. Run `npx vitest run src/renderer/react/features/chat/pages/openSessionByDeps.test.ts` and observe failure because the helper does not exist.
3. Implement the smallest helper in `openSessionByDeps.ts`; it accepts real functions as arguments and contains no React refs.
4. In `ChatPage.tsx`, stop initializing `openSessionByIdRef` and `refreshSessionsRef` to no-op functions that bootstrap can call.
5. Assign callback refs synchronously during render, after the function declarations, or call the pure bootstrap helper with current real functions. The mount effect must not depend on a later effect to install behavior.
6. Replace the ref-only bootstrap completion signal with `useState(false)` (retain a ref only if an event callback needs latest-state access). The mode-refresh effect must be triggered by observable React state.
7. Preserve sequence: register IPC listener, open URL session or refresh restored mode, hydrate messages/workspace, mark bootstrap complete, call `notifyReactReady`.
8. Run the focused test and `npm run build:renderer`.
9. Commit as `fix: initialize work sessions on cold start`.

## Task 3: Scope Todo presentation by session and run

**Files:**

- Modify: `src/renderer/react/features/chat/pages/session-runtime-state.ts`
- Modify: `src/renderer/react/features/chat/pages/session-runtime-state.test.ts`
- Modify: `src/renderer/react/features/chat/pages/ChatPage.tsx`
- Modify: `src/main/orchestrator/harness-adapter.ts`
- Modify: `src/main/orchestrator/harness-adapter.test.ts`

1. Replace the mode reducer test with failing tests for:
   - two Work sessions keep independent Todo arrays;
   - a background update changes only its owner session;
   - an event whose `runId` conflicts with the session's current run is ignored;
   - `cancelled`, malformed, and unsupported items are omitted;
   - RUN_STARTED/reset initializes only the owner session.
2. Introduce:

   ```ts
   export interface SessionTodoState {
     runId?: string;
     todos: TodoItem[];
     updatedAt: number;
   }

   export type TodoStateBySession = Record<string, SessionTodoState>;
   ```

   Add pure `mergeHarnessTodosForSession` and `startSessionTodos` reducers.
3. Run `npx vitest run src/renderer/react/features/chat/pages/session-runtime-state.test.ts` and confirm red, then implement the reducers minimally.
4. Replace `todoStateByMode` with `todoStateBySession` in `ChatPage.tsx`. The panel reads only `todoStateBySession[activeSessionId]`.
5. Route `cyrene.todo` using the run's captured `input.sessionId` and current canonical run id, even when another session is visible. Reset that session at RUN_STARTED.
6. Remove the renderer's initial `getCurrentTodos()` hydration and `cyrene.todos` mode-wide listener from the Harness panel path so a legacy mode broadcast cannot be assigned to whichever session happens to be active.
7. Audit the Harness tool list. If both legacy `todo_write` and built-in `update_todo` are exposed, add a failing adapter test and filter only the legacy `todo_write` from Harness exposure; retain the legacy implementation for older/non-Harness callers.
8. Run focused renderer and adapter tests, then `npm run build:main` and `npm run build:renderer`.
9. Commit as `fix: bind harness todos to conversations`.

## Task 4: Add boundary-based durable presentation checkpoints

**Files:**

- Modify: `src/shared/chat-types.ts`
- Modify: `src/main/chats/chats-store.ts`
- Modify: `src/main/chats/chats-store.test.ts`
- Modify: `src/shared/ipc-channels.ts`
- Modify: `src/main/chats/chats-ipc.ts`
- Modify: `src/main/chats/chats-ipc.test.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/react/features/chat/pages/ChatPage.tsx`
- Modify: `src/renderer/react/features/chat/pages/session-runtime-state.ts`
- Modify: `src/renderer/react/features/chat/pages/session-runtime-state.test.ts`

1. Add a serializable message-level run snapshot marker to `ChatMessage`:

   ```ts
   runSnapshot?: {
     runId?: string;
     status: "running" | "waiting_user" | "interrupted" | "terminal";
     todos?: TodoItem[];
     updatedAt: number;
   };
   ```

   Import only shared serializable Todo types. Do not persist UI callbacks or full `ComposerInteraction` handlers.
2. Add failing store tests for `upsertMessage(sessionId, message)`:
   - replace the matching message id in place;
   - append when the id is new;
   - preserve all unrelated messages;
   - keep session metadata/message count correct.
3. Implement `upsertMessage`, add a dedicated IPC channel/handler and preload method, and test IPC payload validation. This is preferred over repeatedly replacing an unbounded tail.
4. Extend `ChatStoreApi` in `ChatPage.tsx` with `upsert`.
5. At run start, persist the assistant placeholder once with `status: "running"`. At Todo, tool-terminal, Ask/permission appearance/resolution, and terminal boundaries, upsert the current assistant presentation. Coalesce text/reasoning-only snapshots with a short per-session debounce; cancel the timer at terminal cleanup.
6. Ensure the terminal path updates the same assistant message instead of appending a duplicate.
7. Add a pure hydration test: a persisted `running` or `waiting_user` snapshot with no live in-memory run becomes `interrupted`, retains reasoning/tools/Todo evidence, and sets the existing expanded presentation flag. It must never render as actively streaming after restart.
8. Run store, IPC, renderer state tests and all three builds.
9. Commit as `feat: checkpoint active run presentation`.

## Task 5: Make TodoPanel footer non-scrollable and permanently visible

**Files:**

- Modify: `src/renderer/react/features/chat/components/TodoPanel.tsx`
- Modify: `src/renderer/react/features/chat/components/TodoPanel.css`
- Create: `src/renderer/react/features/chat/components/TodoPanel.test.tsx`

1. Add a jsdom render test with enough tasks to overflow. Assert the DOM has distinct `data-testid="todo-list"` and `data-testid="todo-footer"` regions and that progress/workspace live inside the footer, not the scroll list.
2. Run `npx vitest run src/renderer/react/features/chat/components/TodoPanel.test.tsx` and observe failure.
3. Wrap progress and workspace in `.cy-todo__footer`; tag list/footer for the structural test.
4. Remove the `aspect-ratio`. Set the expanded card to a viewport-bounded height/max-height, make body a flex column with `min-height: 0`, make only `.cy-todo__list` flex/scroll, and make header/footer non-shrinking.
5. Keep drag and collapse behavior unchanged. Long paths remain ellipsized; long task text stays inside the list.
6. Run the focused test and `npm run build:renderer`.
7. Commit as `fix: keep todo panel footer visible`.

## Task 6: Regression verification and manual acceptance handoff

**Files:**

- Modify only if a regression test reveals a product bug.

1. Run focused coverage:

   ```powershell
   npx vitest run `
     src/renderer/react/features/chat/pages/session-runtime-state.test.ts `
     src/renderer/react/features/chat/pages/openSessionByDeps.test.ts `
     src/renderer/react/features/chat/components/TodoPanel.test.tsx `
     src/main/chats/chats-store.test.ts `
     src/main/chats/chats-ipc.test.ts `
     src/main/orchestrator/harness-adapter.test.ts
   ```

2. Run full verification:

   ```powershell
   npm test
   npm run build:main
   npm run build:preload
   npm run build:renderer
   ```

3. Check `git status --short`; confirm only intended source/docs/tests plus the pre-existing generated renderer HTML are present.
4. Manual acceptance for both `cyrene run` and `npm run start`:
   - cold-start directly in Work shows the left session list and workspace binding without toggling Chat/Work;
   - start a long run in session A, switch to B, then return to A; streamed text, reasoning, tool states, Ask, and Todo remain;
   - answer an Ask after returning to A and confirm the response becomes visible;
   - two Work sessions display different Todo cards;
   - a long Todo list scrolls while progress/workspace remain visible;
   - cancel a run and confirm prior evidence stays visible and the terminal state is cancelled;
   - restart after an in-progress snapshot and confirm it is shown as interrupted, not still running.
5. If verification changes no code, do not create an empty commit. Report commit hashes, test totals, build results, and any manual checks left for the user.
