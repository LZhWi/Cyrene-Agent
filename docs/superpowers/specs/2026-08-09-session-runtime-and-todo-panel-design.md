# Session Runtime and Todo Panel Design

**Status:** Approved in conversation on 2026-08-09; written review pending

## Goal

Keep every conversation's live Agent presentation intact while it runs in the background, restore Work mode correctly on cold start, bind Todo state to the owning conversation/run, and keep the TodoPanel footer permanently visible regardless of task count.

## Current Failures

1. `activeRunsBySessionRef` is a ref containing another ref. Session hydration therefore fails to detect a live run and replaces its in-memory assistant presentation with an older disk snapshot.
2. The cold-start effect invokes default no-op `openSessionByIdRef` and `refreshSessionsRef` functions before later effects install their real implementations. Bootstrap is then marked complete without loading the Work session list or workspace binding.
3. Todo presentation is keyed by `work | daily | learn`, so conversations in the same mode share one card.
4. TodoPanel enforces a `3 / 4` aspect ratio while its children can exceed that height. The parent clips overflow, allowing the progress and workspace footer to disappear.

## Approaches Considered

### A. Session-scoped live store plus durable checkpoints — selected

Keep active run control and high-frequency presentation in memory, keyed by `sessionId` and canonical `runId`. Persist serializable snapshots at meaningful boundaries using the existing chat store. Renderer views select a session projection and never overwrite a newer live projection with an older persisted snapshot.

This reuses the existing chat store, AG-UI run identifiers, and React session maps. It requires a small state reducer but no new database or state-management dependency.

### B. Disk-first event sourcing

Persist every stream event and rebuild all UI from an append-only event log. This gives strong crash recovery but adds schema migration, compaction, ordering, and I/O complexity. It is unnecessary for the current local learning project.

### C. Renderer-only memory

Keep all active UI in component state and fix only the current hydration check. This is the smallest change but leaves restart recovery weak and encourages more per-component state drift. It also does not give Todo and Ask a single owner.

## State Ownership

### Main process

The main process continues to own non-serializable execution control:

- `AbortController`
- stream subscription
- pending permission and Ask promises
- canonical `runId`
- terminal settlement

These values remain in memory and are never serialized.

### Renderer session runtime state

The renderer owns a serializable presentation projection:

```ts
interface SessionRunPresentation {
  sessionId: string;
  runId?: string;
  assistantId: string;
  mode: ConversationMode;
  status: "starting" | "running" | "waiting_user" | "terminal";
  reasoningBlocks: ReasoningBlock[];
  processMessages: ProcessMessageRecord[];
  toolExecutions: ToolExecutionRecord[];
  todos: TodoItem[];
  interaction?: ComposerInteraction;
  runActivity?: RunActivityRecord;
  updatedAt: number;
}
```

The authoritative in-memory key is `sessionId`. `runId` guards event ownership inside that session.

### Disk

The existing chat store persists serializable assistant fields and terminal results. During an active run it may receive debounced or boundary-based snapshots, but it must not receive every token as an individual write.

Persist immediately after:

- a tool reaches a terminal state;
- Todo changes;
- Ask or permission interaction appears or is resolved;
- the run reaches a terminal state.

Text and provider reasoning may be checkpointed in a short debounce window. If the app restarts with a non-terminal snapshot, present it as `interrupted`; never claim that the old network stream is still running.

## Session Switching

When selecting a conversation:

1. Load its persisted `ChatSession`.
2. Check the session runtime map for a live projection.
3. If a live projection exists, keep it and merge only persisted data that is newer and non-conflicting.
4. If no live projection exists, hydrate from disk.
5. Render the selected session's messages, interaction, and Todo.

Background AG-UI events continue updating their owning `sessionId`, even when another conversation is visible.

## Cold Start

Cold-start initialization must call real stable functions, not function refs populated by later effects.

The sequence is:

1. Register the main-to-renderer session switch listener.
2. Load the URL session when present; otherwise list the restored mode's sessions.
3. Select the requested, active, or first session.
4. Hydrate messages and workspace binding.
5. Mark bootstrap ready and notify the main process.

Bootstrap readiness must be React state or another observable value when later effects depend on it. A ref mutation alone must not be used as a render trigger.

## Todo Ownership

Todo state belongs to a conversation, not a mode:

```ts
type TodoStateBySession = Record<string, {
  runId?: string;
  todos: TodoItem[];
  updatedAt: number;
}>;
```

The active TodoPanel reads `todoStateBySession[activeSessionId]`. A background run updates only its own entry. Switching between two Work conversations switches Todo content immediately.

Cancelled items are excluded from the current-task panel but remain available in the run activity evidence where applicable.

## TodoPanel Layout

TodoPanel uses three vertical regions:

```text
fixed header
scrollable task list
fixed footer: progress, workspace, future Git status/configuration
```

Layout requirements:

- remove the fixed aspect ratio;
- cap the expanded panel height to the viewport;
- make the body a flex or grid column with `min-height: 0`;
- allow scrolling only inside the task-list region;
- give the header and footer `flex-shrink: 0`;
- keep progress, workspace, and future Git content visible for any Todo count;
- keep long task content inside the list's scrollable area;
- preserve collapsed and draggable behavior.

## Error and Race Handling

- Reject or ignore AG-UI events whose `runId` does not match the session's active run.
- A stale disk read must not replace a live projection.
- Rapid session selections use the existing generation guard so an older request cannot win.
- Terminal cleanup removes execution-control state only after the final presentation snapshot has been applied.
- A cancelled or failed run retains its collected evidence and remains expanded according to the existing terminal presentation rules.

## Verification

Automated coverage must prove:

1. Hydration preserves a live session projection and replaces only inactive sessions.
2. Active-run lookup uses the actual session record rather than a ref wrapper.
3. Cold-start calls the real refresh/select dependencies once and restores workspace binding without a mode toggle.
4. Two sessions in the same mode retain independent Todo states.
5. Background Todo updates do not alter the visible conversation's card.
6. TodoPanel DOM separates the scrollable list from the fixed footer.
7. Existing cancellation, Ask restoration, tool completion, reasoning, and terminal-status tests remain green.
8. Main, preload, and renderer builds succeed.

Manual smoke tests must cover both `cyrene run` and `npm run start`, cold start directly into Work, switching away during a long run, returning after background progress, and a Todo list long enough to scroll while the workspace footer remains visible.

## Non-goals

- Persisting `AbortController`, promises, subscriptions, or provider stream objects.
- Resuming an interrupted provider network stream after app restart.
- Introducing Redux, Zustand, SQLite, or a new event-store dependency for this repair.
- Changing Code mode execution behavior.
