# Chat Social Context Implementation Plan

> **Owner note:** This feature stays deliberately small: one synchronous Soul call and at most one asynchronous extraction call per enabled Chat turn. No local model, repair loop, confidence system, or event-sourcing layer.

**Goal:** Give Chat mode lightweight, evidence-backed continuity while keeping the hot response path fast and leaving Work mode unchanged.

**Architecture:** Chat mode optionally compiles a short background block from active social atoms using local BM25 plus time decay. After Soul replies, one queued cloud-model call may add, supersede, or resolve up to three atoms. Every accepted atom must carry a strict source quote and stable turn ID. The existing legacy memory write is skipped for enabled Chat turns so the feature never adds a second background model workflow.

**Tech Stack:** TypeScript, Electron IPC, Vitest, existing vendor adapters and settings store.

---

## Task 1: Preference flag and capsule switch

**Files:**
- Modify: `src/main/index.ts`
- Modify: `src/renderer/settings/index.html`
- Modify: `src/renderer/settings/settings.ts`
- Modify: `src/main/preferences.test.ts`
- Modify: `src/renderer/settings/appearance-settings-markup.test.ts`

1. Add failing tests for a persisted `chatSocialContextEnabled` boolean with a default of `false`.
2. Add a failing markup test proving the Preferences panel uses the existing `.switch` capsule structure.
3. Implement normalization, renderer load/save wiring, and the switch markup.
4. Run the focused tests.

## Task 2: Social atom protocol, storage, retrieval, and context compilation

**Files:**
- Create: `src/main/social-context/types.ts`
- Create: `src/main/social-context/store.ts`
- Create: `src/main/social-context/retrieval.ts`
- Create: `src/main/social-context/context.ts`
- Create: `src/main/social-context/social-context.test.ts`

1. Add failing tests for the three atom types and operations, active/expired filtering, supersede/resolve updates, and conversation isolation.
2. Add failing retrieval tests for BM25 relevance, time decay, five-item limit, and empty output.
3. Add failing compiler tests for natural, bounded injection text and omission when no useful background exists.
4. Implement a small atomic JSON store under Electron user data and pure local retrieval.
5. Run the focused tests.

## Task 3: One-shot asynchronous extractor

**Files:**
- Create: `src/main/social-context/extractor.ts`
- Create: `src/main/social-context/extractor.test.ts`
- Create: `src/main/social-context/scheduler.ts`
- Create: `src/main/social-context/scheduler.test.ts`

1. Add failing validator tests for strict-substring quotes, user-only fact evidence, expiry requirements, valid targets, maximum three writes, and `resolve` evidence.
2. Add failing scheduler tests proving exactly one queued model call, no repair/retry, and drop-on-failure behavior.
3. Implement a concise extraction prompt using the current configured cloud provider and the existing JSON-candidate parser.
4. Persist only locally validated operations and emit aggregate diagnostics without raw private content.
5. Run the focused tests.

## Task 4: Wire only the Chat Soul path

**Files:**
- Modify: `src/main/agui-bridge.ts`
- Modify: `src/main/orchestrator/cyrene-agent.ts`
- Modify: `src/main/orchestrator/build-options.ts`
- Modify: `src/main/orchestrator/build-options.test.ts`
- Modify: `src/main/index.ts`
- Modify: `src/renderer/chat/main.ts`
- Modify: relevant preload AG-UI declaration

1. Add failing tests proving enabled Chat uses only the latest 12 messages, retrieves at most five atoms, and injects no empty block.
2. Add failing tests proving Work mode and disabled Chat do not call the new retrieval/extractor path.
3. Carry stable user/assistant turn IDs from the renderer through the run result.
4. Inject the compiled background only into Chat Soul.
5. Queue extraction after a successful enabled Chat reply and skip the legacy memory writer for that turn.
6. Run focused integration tests.

## Task 5: Verification

1. Run all new focused tests.
2. Run the full Vitest suite.
3. Run the production build.
4. Inspect the final diff for accidental Work/CITA/Action Gate changes and confirm no API key is logged or stored outside the existing local settings path.
5. Leave changes uncommitted until the owner requests a commit.
