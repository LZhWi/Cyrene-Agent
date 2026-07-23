# Chat and Collaboration Mode Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make tool permission `off` and desktop Talk mode run Soul-only, while `safe-only` and `all` retain the complete collaboration pipeline.

**Architecture:** Add an explicit `executionMode` to the AG-UI input and Cyrene runtime options. `buildAgentRunOptions` resolves the mode before CITA preparation; `CyreneAgent` dispatches Soul-only runs to a dedicated one-call loop and collaboration runs to the existing LangGraph/legacy runtime. Channel settings keep their existing sandbox field and add an `off` value.

**Tech Stack:** TypeScript, Electron, AG-UI, RxJS, Vitest.

## Global Constraints

- Soul-only must not invoke full CITA, Action Gate, Native Function Calling, permissions, or Tool Runtime.
- Soul-only must expose zero tools, including music tools.
- Soul-only must preserve the Soul system, conversation history, image fallback, usage accounting, AG-UI text events, and existing post-run side effects.
- Existing `safe-only` and `all` settings must retain current collaboration behavior.
- Unknown persisted sandbox values normalize to `safe-only`.
- The future lightweight CITA is outside this implementation.

---

### Task 1: Persist the third tool permission state

**Files:**
- Modify: `src/main/channels/settings-store.ts`
- Test: `src/main/channels/settings-store.test.ts`

**Interfaces:**
- Produces: `type ChannelToolSandbox = "off" | "safe-only" | "all"`
- Produces: `ChannelsSettings.toolSandbox: ChannelToolSandbox`

- [ ] **Step 1: Write the failing persistence test**

```ts
it("saveChannelsSettings: persists the off tool sandbox", () => {
  saveChannelsSettings({ toolSandbox: "off" });
  expect(loadChannelsSettings().toolSandbox).toBe("off");
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npm test -- src/main/channels/settings-store.test.ts`

Expected: FAIL because `off` is rejected by the current union/normalizer.

- [ ] **Step 3: Implement the three-value type and normalization**

```ts
export type ChannelToolSandbox = "off" | "safe-only" | "all";

function normalizeToolSandbox(value: unknown): ChannelToolSandbox {
  if (value === "off" || value === "all") return value;
  return "safe-only";
}
```

Use the type in `ChannelsSettings` and `ChannelConfigPatch`, and call the normalizer from `normalize`.

- [ ] **Step 4: Run the test and verify GREEN**

Run: `npm test -- src/main/channels/settings-store.test.ts`

Expected: PASS.

### Task 2: Resolve Soul-only before full CITA and tools

**Files:**
- Modify: `src/main/agui-bridge.ts`
- Modify: `src/main/orchestrator/build-options.ts`
- Test: `src/main/orchestrator/build-options.test.ts`

**Interfaces:**
- Produces: `type AgentExecutionMode = "soul-only" | "collaboration"`
- Consumes: `AguiRunInput.executionMode?: AgentExecutionMode`
- Produces: `CyreneRunOptions.executionMode: AgentExecutionMode`

- [ ] **Step 1: Replace the old Talk music test with failing Soul-only assertions**

```ts
it("builds Talk mode as Soul-only without CITA or tools", async () => {
  const deps = createBuildDeps();
  deps.prepareCitaTurn = vi.fn(async () => ({ contextBlock: "unexpected" }));
  deps.toolRegistry.getEnabled = () => [{ id: "music_search" }, { id: "weather" }];

  const result = await buildAgentRunOptions({
    messages: [{ role: "user", content: "陪我聊聊" }],
    style: "talk",
  }, deps);

  expect(deps.prepareCitaTurn).not.toHaveBeenCalled();
  expect(result.options.executionMode).toBe("soul-only");
  expect(result.options.tools).toEqual([]);
  expect(result.options.citaContextBlock).toBe("");
});
```

Add a second test proving an explicit channel `executionMode: "soul-only"` overrides its non-Talk style, and keep the existing CITA collaboration test.

- [ ] **Step 2: Run the tests and verify RED**

Run: `npm test -- src/main/orchestrator/build-options.test.ts`

Expected: FAIL because Talk still preserves music tools and calls CITA before resolving mode.

- [ ] **Step 3: Implement early execution-mode resolution**

Resolve:

```ts
const executionMode =
  input.executionMode ?? ((input.style || "").startsWith("talk") ? "soul-only" : "collaboration");
const isSoulOnly = executionMode === "soul-only";
```

Guard `prepareCitaTurn` with `!isSoulOnly`, set `runTools` to `[]` for Soul-only, and include `executionMode` on `CyreneRunOptions`.

- [ ] **Step 4: Run the tests and verify GREEN**

Run: `npm test -- src/main/orchestrator/build-options.test.ts`

Expected: PASS.

### Task 3: Add the dedicated Soul-only runtime

**Files:**
- Create: `src/main/orchestrator/soul-only-loop.ts`
- Create: `src/main/orchestrator/soul-only-loop.test.ts`
- Modify: `src/main/orchestrator/cyrene-agent.ts`
- Modify: `src/main/orchestrator/cyrene-agent-runtime.test.ts`

**Interfaces:**
- Produces: `runSoulOnlyLoop(options: SoulOnlyLoopOptions): Promise<TwoPhaseFcResult>`
- Consumes: `CyreneRunOptions.executionMode`

- [ ] **Step 1: Write a failing one-call Soul test**

Build a fake adapter that records `ChatRequest`s and returns `"只是陪你聊聊。"`. Assert:

```ts
const result = await runSoulOnlyLoop({
  settings,
  adapter,
  messages: [{ role: "user", content: "陪我聊聊" }],
  soulSystemBaseContent: "SOUL_SYSTEM",
  timeoutMs: 30_000,
  onEvent,
});

expect(adapter.requests).toHaveLength(1);
expect(adapter.requests[0].messages[0]).toEqual({ role: "system", content: "SOUL_SYSTEM" });
expect(adapter.requests[0].tools).toBeUndefined();
expect(adapter.requests[0].structuredOutput).toBeUndefined();
expect(result.toolResults).toEqual([]);
expect(result.reply).toBe("只是陪你聊聊。");
```

- [ ] **Step 2: Run the new test and verify RED**

Run: `npm test -- src/main/orchestrator/soul-only-loop.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the minimal Soul-only loop**

The loop must:

1. Build exactly one request with `[system Soul, ...messages]`, `stream: false`, and no tools.
2. Apply adapter cache hints and existing HTTP timeout/abort behavior.
3. Retry once with `imageCaptionFallback` only when the first request fails.
4. Record usage and emit `text_message_start/content/end`.
5. Strip leaked chat-time markers and return `toolResults: []`.

- [ ] **Step 4: Route CyreneAgent explicitly**

Add:

```ts
export type AgentExecutionMode = "soul-only" | "collaboration";

export function resolveExecutionMode(mode: CyreneRunOptions["executionMode"]): AgentExecutionMode {
  return mode === "soul-only" ? "soul-only" : "collaboration";
}
```

In `runWithEvents`, call `runSoulOnlyLoop` before constructing execution-ledger/tool callbacks when the mode is Soul-only. Otherwise retain the current runtime branch unchanged.

- [ ] **Step 5: Run runtime tests and verify GREEN**

Run:

`npm test -- src/main/orchestrator/soul-only-loop.test.ts src/main/orchestrator/cyrene-agent-runtime.test.ts`

Expected: PASS.

### Task 4: Expose Off in the channel UI and map channels to execution mode

**Files:**
- Modify: `src/renderer/settings/index.html`
- Modify: `src/renderer/settings/settings.ts`
- Modify: `src/main/index.ts`

**Interfaces:**
- Consumes: `ChannelsSettings.toolSandbox`
- Produces: `AguiRunInput.executionMode`

- [ ] **Step 1: Add the Off radio option**

Add `channels-tool-sandbox-off` with title `关闭` and description:

```text
仅进行日常聊天，不启用 CITA、Action Gate 或任何工具。
```

- [ ] **Step 2: Bind and persist the new radio**

Load all three states explicitly and save:

```ts
toolSandbox: channelsToolSandboxOffEl?.checked
  ? "off"
  : channelsToolSandboxSafeEl?.checked
    ? "safe-only"
    : "all",
```

- [ ] **Step 3: Map the channel dispatcher**

Use no tools for `off`; preserve risk filtering for `safe-only`; pass:

```ts
executionMode: sandbox === "off" ? "soul-only" : "collaboration",
```

to `buildAgentRunOptions`. Continue overriding `options.tools` with the filtered tools.

- [ ] **Step 4: Build all TypeScript surfaces**

Run: `npm run build:main && npm run build:preload && npm run build:renderer`

Expected: all builds exit 0.

### Task 5: Regression verification

**Files:**
- Test: `src/main/channels/settings-store.test.ts`
- Test: `src/main/orchestrator/build-options.test.ts`
- Test: `src/main/orchestrator/soul-only-loop.test.ts`
- Test: `src/main/orchestrator/cyrene-agent-runtime.test.ts`
- Test: `src/main/orchestrator/langgraph-agent-loop.test.ts`

- [ ] **Step 1: Run the focused suite**

Run:

```powershell
npm test -- src/main/channels/settings-store.test.ts src/main/orchestrator/build-options.test.ts src/main/orchestrator/soul-only-loop.test.ts src/main/orchestrator/cyrene-agent-runtime.test.ts src/main/orchestrator/langgraph-agent-loop.test.ts
```

Expected: all tests pass.

- [ ] **Step 2: Run repository checks**

Run:

```powershell
npm test
npm run build
git diff --check
```

Expected: all commands exit 0 and the diff contains only the planned files.

- [ ] **Step 3: Commit implementation**

```powershell
git add -- src/main/channels/settings-store.ts src/main/channels/settings-store.test.ts src/main/agui-bridge.ts src/main/orchestrator/build-options.ts src/main/orchestrator/build-options.test.ts src/main/orchestrator/soul-only-loop.ts src/main/orchestrator/soul-only-loop.test.ts src/main/orchestrator/cyrene-agent.ts src/main/orchestrator/cyrene-agent-runtime.test.ts src/renderer/settings/index.html src/renderer/settings/settings.ts src/main/index.ts docs/superpowers/plans/2026-07-23-chat-collaboration-mode-routing.md
git commit -m "feat: route chat mode through Soul only"
```
