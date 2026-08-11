# Task Delegation Character Display Design

## Goal

Give foreground Task delegations a compact, playful presentation in the parent run flow without exposing child transcripts or adding a detail panel.

## Presentation

Each active Task invocation renders one borderless row in the existing run flow:

```text
◌ 昔涟委托了 [角色 PNG] 风堇 · 正在运行
```

The running indicator uses the existing activity motion language. Terminal settlement updates the same row and stops the motion:

```text
✓ 昔涟委托了 [角色 PNG] 风堇 · 已完成
× 昔涟委托了 [角色 PNG] 风堇 · 执行失败
```

Cancellation is also terminal and releases the character lease. There is no Task card, right-side viewer, child transcript, or child conversation UI in this phase.

## Character Assets and Weights

Assets come from `src/renderer/tast/`. The PNG filename without its extension is the character nickname.

- 风堇: weight 15
- 刻律德菈, 长夜月, 遐蝶, 缇宝: weight 10 each
- 阿格莱雅, 白厄, 丹恒, 海瑟音, 那刻夏, 赛飞儿, 万敌: split the remaining weight 45 equally, so each has weight `45 / 7`

Weights are not directly redistributed when a character is unavailable. Selection removes active leases from the candidate set and renormalizes every remaining weight by the same denominator:

```text
probability(character) = characterWeight / sum(weights of available characters)
```

For example, while 风堇 is leased, the remaining denominator is 85. Each weight-10 character has probability `10 / 85`, and each ordinary character has probability `(45 / 7) / 85`. Relative ordering therefore never reverses.

## Lifecycle and Ownership

The Main process owns character selection and leases. The Renderer never chooses or changes identity.

- Lease scope: one Task invocation inside one parent conversation.
- Uniqueness: an active nickname cannot be selected again in the same parent conversation.
- Acquisition: immediately before a child Task starts.
- Release: exactly once after completion, failure, or cancellation.
- Resume: resuming a settled Task creates a new invocation and draws a new available character.
- Exhaustion: if all 12 characters are active in one conversation, the invocation waits for the first released lease rather than duplicating a nickname.

The Task lifecycle event contains an invocation ID, Task ID, description, nickname, and status. The full child prompt and private trace are never included.

## Data Flow

1. Parent Harness invokes `task` with a validated description.
2. Task runtime acquires a weighted character lease for the parent conversation.
3. Main emits a sanitized start event.
4. Renderer inserts or updates the matching run-flow row by invocation ID.
5. Task settles as completed, failed, or cancelled.
6. Main emits the matching terminal event and releases the lease in `finally`.

## Persistence Boundary

The displayed delegation row is checkpointed with the owning parent assistant run so switching conversations does not erase it. Active leases remain runtime-owned; after application restart, no previous process is active, so all in-memory leases are naturally released while persisted interrupted Task sessions remain resumable.

## Verification

- Deterministic weighted-selection tests prove renormalization and relative weight ordering.
- Lease tests prove no duplicate active nickname within one conversation and release on every terminal path.
- Event tests prove prompts and child traces never enter parent events.
- Renderer tests prove start inserts a running row and terminal events update the same row rather than append a duplicate.
- Conversation-switch tests prove the row remains scoped to and restored with its owning conversation.
