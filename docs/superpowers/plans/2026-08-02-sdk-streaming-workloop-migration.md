# SDK Streaming WorkLoop Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace WorkLoop's buffered model calls with real OpenAI/Anthropic SDK streaming so reasoning, text, and tool-call state can reach AG-UI incrementally, while preserving the existing two-phase tool/soul semantics and using each SDK's terminal result as the protocol authority where available.

**Architecture:** Add the two SDKs as direct dependencies, introduce a vendor-neutral stream delta contract plus a small accumulator, and put provider-specific event interpretation in OpenAI and Anthropic normalizers. A thin SDK runtime owns client construction, timeout/cancellation, and iteration. `two-phase-fc-loop.ts` consumes only unified deltas and final `ChatResponse` values. Existing adapter request builders remain the request-shape authority during this phase; the legacy HTTP/SSE reader remains in place for Chat and Memory until their later migration.

**Tech Stack:** TypeScript 5.6, Node.js 24, Vitest 4, `openai` 6.49, `@anthropic-ai/sdk` 0.115, AG-UI core 0.0.57.

## Global Constraints

- Preserve every pre-existing uncommitted workspace change. In particular, integrate rather than revert the current reasoning event work in `two-phase-fc-loop.ts`, the `resolvedWorkspaceRoot` plumbing, and the React reasoning block types.
- Do not edit React, legacy DOM/CSS, Chat/Work/Code mode routing, `ChatSession.mode`, Cline Runtime, or session-list behavior.
- Do not migrate `chat-loop.ts`, Memory, structured-output runners, or `src/main/index.ts` in this phase.
- Do not delete `createSseReader`, `StreamEvent`, `StreamChunk`, `buildStreamRequest`, or `parseStreamEvent` yet; they still have unmigrated consumers.
- Keep A/B/M/D structured-output policy, schema repair, local validation, prompt construction, retry policy, tool permission, tool execution, and model routing out of the accumulator.
- Configure both SDKs with `maxRetries: 0`; existing Cyrene layers remain the sole retry-policy owner.
- The runtime must never make network calls in unit tests. Inject SDK stream factories and use async-iterable fixtures.
- `index` is the OpenAI stream-time tool-call key. A non-empty `id` is assigned once and must remain consistent. Only `function.name` and `function.arguments` are concatenated.
- Anthropic is dual-track: raw delta events drive live UI state; `finalMessage()` is the terminal authority for thinking blocks, signatures, tool-use blocks, usage, and the saved assistant message.
- Each task follows red-green-refactor: add one focused failing test, confirm the expected failure, implement only enough production code to pass, then run the focused file again.
- Make one implementation commit per task group below. Do not include unrelated dirty files in any commit.

---

### Task 1: Make both transport SDKs explicit production dependencies

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Confirm the current dependency relationship**

Run:

```powershell
npm ls openai @anthropic-ai/sdk --depth=2
```

Expected: both packages are present only through LangChain packages, not as top-level dependencies.

- [ ] **Step 2: Add direct dependencies without changing the resolved major versions**

Run:

```powershell
npm install --save "openai@^6.49.0" "@anthropic-ai/sdk@^0.115.0"
```

Expected: `package.json` contains both under `dependencies`, and the lockfile records them as root dependencies without an unrelated mass upgrade.

- [ ] **Step 3: Verify the imports and dependency tree**

Run:

```powershell
npm ls openai @anthropic-ai/sdk --depth=0
npx tsc -p tsconfig.main.json --noEmit
```

Expected: both packages resolve at depth 0 and main-process TypeScript still passes.

- [ ] **Step 4: Commit only dependency manifests**

```powershell
git add package.json package-lock.json
git commit -m "build: add direct provider sdk dependencies"
```

---

### Task 2: Define the vendor-neutral stream contract and accumulator

**Files:**
- Create: `src/main/orchestrator/vendors/sdk-stream/types.ts`
- Create: `src/main/orchestrator/vendors/sdk-stream/accumulator.ts`
- Create: `src/main/orchestrator/vendors/sdk-stream/accumulator.test.ts`

- [ ] **Step 1: Write accumulator contract tests first**

Create tests covering all of these cases:

1. Interleaved reasoning and text deltas are retained in arrival order per channel and finalize to `thinking` and `text`.
2. Tool-call slots are keyed by `index` while streaming, even before an `id` arrives.
3. The first non-empty `id` becomes stable; repeating the same `id` is accepted.
4. A different later `id` for the same `index` throws `ProviderProtocolError` with code `E_TOOL_CALL_ID_CHANGED`.
5. `nameDelta` and argument deltas concatenate; `id` never concatenates.
6. A finalized tool call without `id`, without a name, with truncated/invalid JSON arguments, or with a finish reason inconsistent with open tool state throws a specific protocol error instead of generating an identifier or silently dropping the call.
7. Usage deltas retain the most recent defined input/output counts without turning absent fields into zero.
8. Refusal and finish reason survive finalization.

The public contract in `types.ts` must be exactly transport-neutral:

```ts
export type UnifiedStreamDelta =
  | { type: "reasoning_delta"; delta: string }
  | { type: "text_delta"; delta: string }
  | { type: "tool_call_start"; index: number; id?: string; nameDelta?: string }
  | { type: "tool_call_arguments_delta"; index: number; id?: string; delta: string }
  | { type: "tool_call_end"; index: number; id?: string }
  | { type: "usage"; inputTokens?: number; outputTokens?: number }
  | { type: "finish"; reason: string }
  | { type: "refusal"; reason?: string };

export interface StreamAccumulatorSnapshot {
  text: string;
  thinking?: string;
  toolCalls: ReadonlyArray<{
    index: number;
    id?: string;
    name: string;
    arguments: string;
    ended: boolean;
  }>;
  finishReason?: string;
  refusal?: string;
  usage?: { input: number; output: number };
}
```

Also define:

```ts
export class ProviderProtocolError extends Error {
  constructor(
    readonly code:
      | "E_TOOL_CALL_ID_CHANGED"
      | "E_TOOL_CALL_INCOMPLETE"
      | "E_STREAM_TERMINAL_MISMATCH"
      | "E_UNSUPPORTED_STREAM_EVENT",
    message: string,
  ) {
    super(message);
    this.name = "ProviderProtocolError";
  }
}
```

- [ ] **Step 2: Run the new test and confirm red**

Run:

```powershell
npx vitest run src/main/orchestrator/vendors/sdk-stream/accumulator.test.ts
```

Expected: failure because the accumulator and/or types do not exist.

- [ ] **Step 3: Implement the smallest pure accumulator**

Implement `CyreneStreamAccumulator` with these methods only:

```ts
export class CyreneStreamAccumulator {
  apply(delta: UnifiedStreamDelta): void;
  snapshot(): StreamAccumulatorSnapshot;
  finalize(raw: unknown): ChatResponse;
}
```

Implementation rules:

- Use `Map<number, MutableToolCall>` internally.
- On either tool delta carrying `id`, call one shared `assignStableId` helper.
- Append only `nameDelta` and `delta` arguments.
- Sort tool calls by `index` when snapshotting/finalizing.
- `finalize` builds the existing `ChatResponse` and its `assistantMessage`; it does not choose a provider, retry, repair JSON, or emit AG-UI events.
- Preserve `undefined` usage until both numbers can be represented accurately. If only one side is reported, retain the known value internally and expose the completed pair after the normalizer supplies the terminal usage.

- [ ] **Step 4: Run focused tests and main type-check**

Run:

```powershell
npx vitest run src/main/orchestrator/vendors/sdk-stream/accumulator.test.ts
npx tsc -p tsconfig.main.json --noEmit
```

Expected: all accumulator tests and TypeScript pass.

- [ ] **Step 5: Commit the neutral contract**

```powershell
git add src/main/orchestrator/vendors/sdk-stream/types.ts src/main/orchestrator/vendors/sdk-stream/accumulator.ts src/main/orchestrator/vendors/sdk-stream/accumulator.test.ts
git commit -m "feat: add provider-neutral stream accumulator"
```

---

### Task 3: Normalize OpenAI-compatible SDK chunks correctly

**Files:**
- Create: `src/main/orchestrator/vendors/sdk-stream/openai-normalizer.ts`
- Create: `src/main/orchestrator/vendors/sdk-stream/openai-normalizer.test.ts`
- Test fixtures inside the test file: OpenAI, Kimi, Doubao, DeepSeek, Qwen, GLM, MiMo, MiniMax OpenAI-compatible chunk shapes

- [ ] **Step 1: Write table-driven fixture tests**

Test `normalizeOpenAIChunk(chunk: unknown): UnifiedStreamDelta[]` against fixtures that prove:

- `delta.content` maps to `text_delta`.
- `delta.reasoning_content`, `delta.reasoning`, `delta.thinking`, and text-bearing entries in `delta.reasoning_details` map to `reasoning_delta` without assuming the OpenAI SDK aggregates those extension fields.
- `delta.tool_calls[].index` remains the primary key.
- The first chunk may provide `id` and partial `function.name`; later chunks may omit `id` and continue name/arguments.
- Repeated identical `id` is emitted unchanged for accumulator validation; no normalizer concatenates it.
- Multiple tool calls interleaved by index remain distinguishable.
- `finish_reason`, refusal content, and usage map to terminal deltas.
- An empty/role-only chunk produces an empty delta array.

- [ ] **Step 2: Run the test and confirm red**

```powershell
npx vitest run src/main/orchestrator/vendors/sdk-stream/openai-normalizer.test.ts
```

Expected: module-not-found or missing-export failure.

- [ ] **Step 3: Implement a pure, exhaustive normalizer**

Use narrow local type guards over `unknown`; do not cast the entire chunk to `any`. The function must not keep cross-chunk state. Emit, in wire order:

1. reasoning deltas;
2. text deltas;
3. tool-call start/argument deltas by `index`;
4. refusal;
5. usage;
6. finish.

Do not use an SDK snapshot as the authority for custom reasoning fields because the standard SDK accumulator overwrites unknown extension fields. The Cyrene accumulator is the authority for OpenAI-compatible streamed reasoning.

- [ ] **Step 4: Verify focused fixtures**

```powershell
npx vitest run src/main/orchestrator/vendors/sdk-stream/openai-normalizer.test.ts src/main/orchestrator/vendors/sdk-stream/accumulator.test.ts
```

Expected: all cases pass without network access.

- [ ] **Step 5: Commit the OpenAI normalizer**

```powershell
git add src/main/orchestrator/vendors/sdk-stream/openai-normalizer.ts src/main/orchestrator/vendors/sdk-stream/openai-normalizer.test.ts
git commit -m "feat: normalize openai-compatible stream deltas"
```

---

### Task 4: Normalize Anthropic events and reconcile the SDK terminal message

**Files:**
- Create: `src/main/orchestrator/vendors/sdk-stream/anthropic-normalizer.ts`
- Create: `src/main/orchestrator/vendors/sdk-stream/anthropic-normalizer.test.ts`

- [ ] **Step 1: Write raw-event and reconciliation tests**

Cover this exact lifecycle:

```text
content_block_start(thinking)
content_block_delta(thinking_delta)
content_block_delta(signature_delta)
content_block_stop
content_block_start(text)
content_block_delta(text_delta)
content_block_stop
content_block_start(tool_use)
content_block_delta(input_json_delta)
content_block_stop
message_delta(usage, stop_reason)
message_stop
```

Assertions:

- Raw `thinking_delta`, `text_delta`, and tool-use lifecycle produce immediate unified deltas.
- The normalizer tracks only the active content block's index/type/id/name needed for business event mapping.
- Each `input_json_delta.partial_json` is forwarded immediately as `tool_call_arguments_delta`, but the normalizer never parses or independently reassembles it into a final object; the SDK final message supplies the authoritative `tool_use.input`.
- Signature fragments are not displayed as reasoning text.
- `reconcileAnthropicTerminal(liveSnapshot, finalMessage, adapter)` calls the existing Anthropic adapter's `parseResponse` once and returns that parsed `ChatResponse` as terminal authority.
- Equivalent live/final text, thinking, and tool calls pass.
- A mismatch invokes an injected diagnostic callback with code `E_STREAM_TERMINAL_MISMATCH` while retaining the SDK terminal response. The diagnostic must contain counts/lengths and IDs, not full prompt or reasoning content.
- A missing or malformed terminal tool-use block fails before execution.

- [ ] **Step 2: Run the test and confirm red**

```powershell
npx vitest run src/main/orchestrator/vendors/sdk-stream/anthropic-normalizer.test.ts
```

Expected: module-not-found or missing-export failure.

- [ ] **Step 3: Implement dual-track state**

Expose only these public pieces:

```ts
export class AnthropicEventNormalizer {
  normalize(event: unknown): UnifiedStreamDelta[];
}

export function reconcileAnthropicTerminal(
  live: StreamAccumulatorSnapshot,
  finalMessage: unknown,
  adapter: ChatVendorAdapter,
  onDiagnostic?: (diagnostic: StreamDiagnostic) => void,
): ChatResponse;
```

`AnthropicEventNormalizer` may remember active block metadata, but must not own retries, routing, permissions, schemas, prompts, or final JSON assembly. Let the SDK's `MessageStream` own block snapshots and `input_json_delta` assembly.

- [ ] **Step 4: Verify both protocol families together**

```powershell
npx vitest run src/main/orchestrator/vendors/sdk-stream/anthropic-normalizer.test.ts src/main/orchestrator/vendors/sdk-stream/openai-normalizer.test.ts src/main/orchestrator/vendors/sdk-stream/accumulator.test.ts
```

Expected: all protocol and reconciliation fixtures pass.

- [ ] **Step 5: Commit the Anthropic dual-track normalizer**

```powershell
git add src/main/orchestrator/vendors/sdk-stream/anthropic-normalizer.ts src/main/orchestrator/vendors/sdk-stream/anthropic-normalizer.test.ts
git commit -m "feat: reconcile anthropic streaming terminal state"
```

---

### Task 5: Build SDK clients and a cancellable streaming runtime

**Files:**
- Create: `src/main/orchestrator/vendors/sdk-stream/client-config.ts`
- Create: `src/main/orchestrator/vendors/sdk-stream/client-config.test.ts`
- Create: `src/main/orchestrator/vendors/sdk-stream/runtime.ts`
- Create: `src/main/orchestrator/vendors/sdk-stream/runtime.test.ts`
- Modify: `src/main/orchestrator/vendors/index.ts`

- [ ] **Step 1: Write client configuration tests**

Test endpoint derivation without HTTP:

- OpenAI `https://host/v1/chat/completions` becomes SDK `baseURL=https://host/v1`.
- OpenAI prefixed endpoints retain the prefix and strip only `/chat/completions`.
- Anthropic `https://host/v1/messages` becomes `baseURL=https://host` because the SDK adds `/v1/messages`.
- Anthropic `/v1/messages` endpoints are represented by stripping that fixed suffix from the SDK `baseURL`.
- A user-supplied full Anthropic endpoint ending in a nonstandard `<prefix>/messages` is preserved exactly through a narrowly scoped SDK `fetch` URL-rewrite wrapper. The wrapper may replace only the request URL; it must delegate method, headers, body, signal, response parsing, and streaming to the SDK/native fetch unchanged.
- `authStyle: "x-api-key"` maps to Anthropic `apiKey`; `authStyle: "bearer"` maps to `authToken`.
- Both client option objects contain `maxRetries: 0`.
- No API key, URL, prompt, or streamed content appears in diagnostic objects.

- [ ] **Step 2: Write runtime tests with injected async iterables**

Define the dependency seam:

```ts
export interface SdkStreamRuntimeDeps {
  openAI: (input: OpenAIStreamFactoryInput) => Promise<AsyncIterable<unknown>>;
  anthropic: (input: AnthropicStreamFactoryInput) => Promise<{
    events: AsyncIterable<unknown>;
    finalMessage: () => Promise<unknown>;
  }>;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

export interface SdkStreamRunInput {
  adapter: ChatVendorAdapter;
  request: ChatRequest;
  config: VendorConfig;
  timeoutMs: number;
  signal?: AbortSignal;
  onDelta?: (delta: UnifiedStreamDelta) => void;
  onDiagnostic?: (diagnostic: StreamDiagnostic) => void;
}

export async function streamChatWithSdk(
  input: SdkStreamRunInput,
  deps?: SdkStreamRuntimeDeps,
): Promise<ChatResponse>;
```

Runtime cases:

1. OpenAI factory receives `stream: true`, the existing adapter-built request body, an abort signal, and no SDK retries.
2. Every normalized delta reaches both the accumulator and `onDelta` before the async iterable completes.
3. Anthropic raw events reach `onDelta` before `finalMessage()` resolves; terminal reconciliation happens afterward.
4. Timeout aborts the in-flight SDK request and throws `AgentRuntimeError` code `E_MODEL_REQUEST_TIMEOUT` quickly under fake timers.
5. Caller cancellation preserves an `AbortError` (or the caller signal's `Error` reason), never masquerades as timeout.
6. Timer and abort listeners are cleaned on success, timeout, protocol error, and caller cancellation.
7. No test constructs a real SDK client or accesses the network.

- [ ] **Step 3: Run both new files and confirm red**

```powershell
npx vitest run src/main/orchestrator/vendors/sdk-stream/client-config.test.ts src/main/orchestrator/vendors/sdk-stream/runtime.test.ts
```

Expected: missing modules/exports.

- [ ] **Step 4: Implement client factories and runtime**

Production defaults must:

- Instantiate `OpenAI` or `Anthropic` lazily inside the selected transport branch.
- Build the body through `adapter.buildStreamRequest({ ...request, stream: true }, config)` and parse its JSON body. This is an intentional migration bridge that preserves all existing provider request quirks while retiring only the network/SSE layer in this phase.
- Treat that adapter-produced `HttpRequest.url` as the exact endpoint authority. Derive the normal SDK `baseURL` when the standard fixed suffix can reproduce it; otherwise use the tested URL-only wrapper above so custom D endpoints do not regress.
- Use the adapter capability and explicit transport already selected by the caller; do not infer transport from URL.
- Pass the combined cancellation/timeout signal into the SDK request.
- Iterate OpenAI chunks and Anthropic raw events with `for await`.
- Finalize OpenAI from `CyreneStreamAccumulator`.
- Call Anthropic `finalMessage()` after event iteration and reconcile it with the live snapshot.
- Clear the timeout and detach caller-signal listeners in one `finally` block.
- Wrap runtime-owned timeout as the existing `AgentRuntimeError` code `E_MODEL_REQUEST_TIMEOUT`. Preserve caller cancellation as an `AbortError` (or the caller signal's `Error` reason), preserve `ProviderProtocolError` unchanged, and wrap other provider failures as existing `E_MODEL_REQUEST_FAILED` with the original error as `cause`.

- [ ] **Step 5: Export the new runtime without removing legacy exports**

Add named exports from `src/main/orchestrator/vendors/index.ts` for `streamChatWithSdk`, `UnifiedStreamDelta`, the accumulator, and protocol error types. Keep `createSseReader` exported for unmigrated paths.

- [ ] **Step 6: Run focused runtime, adapter, and type tests**

```powershell
npx vitest run src/main/orchestrator/vendors/sdk-stream/*.test.ts src/main/orchestrator/vendors/openai-adapter.test.ts src/main/orchestrator/vendors/anthropic-adapter.test.ts
npx tsc -p tsconfig.main.json --noEmit
```

Expected: all pass.

- [ ] **Step 7: Commit the runtime seam**

```powershell
git add src/main/orchestrator/vendors/sdk-stream/client-config.ts src/main/orchestrator/vendors/sdk-stream/client-config.test.ts src/main/orchestrator/vendors/sdk-stream/runtime.ts src/main/orchestrator/vendors/sdk-stream/runtime.test.ts src/main/orchestrator/vendors/index.ts
git commit -m "feat: add sdk streaming runtime"
```

---

### Task 6: Add neutral incremental tool-argument events to the Work pipeline

**Files:**
- Modify: `src/main/orchestrator/two-phase-fc-loop.ts`
- Modify: `src/main/orchestrator/cyrene-agent.ts`
- Modify: `src/main/orchestrator/cyrene-agent.test.ts`

- [ ] **Step 1: Add a failing AG-UI mapping test**

Extend `cyrene-agent.test.ts` with a `TwoPhaseEvent` fixture:

```ts
{ type: "tool_call_args", toolCallId: "call-1", delta: "{\"path\":" }
```

Assert that `toAguiEvent` returns:

```ts
{
  type: EventType.TOOL_CALL_ARGS,
  toolCallId: "call-1",
  delta: "{\"path\":",
}
```

- [ ] **Step 2: Run the focused test and confirm red**

```powershell
npx vitest run src/main/orchestrator/cyrene-agent.test.ts
```

Expected: the event is not assignable or is not mapped.

- [ ] **Step 3: Extend only the neutral event union and mapper**

Add:

```ts
| { type: "tool_call_args"; toolCallId: string; delta: string }
```

to `TwoPhaseEvent`, then map it to AG-UI `EventType.TOOL_CALL_ARGS`. Do not put SDK event names or provider checks in `CyreneAgent`.

- [ ] **Step 4: Verify mapping and type-check**

```powershell
npx vitest run src/main/orchestrator/cyrene-agent.test.ts
npx tsc -p tsconfig.main.json --noEmit
```

Expected: mapping and TypeScript pass.

- [ ] **Step 5: Commit the event-contract extension**

Because `two-phase-fc-loop.ts` already contains user-authored uncommitted reasoning changes, inspect the staged diff and stage only the intentional contract hunk if needed:

```powershell
git diff -- src/main/orchestrator/two-phase-fc-loop.ts src/main/orchestrator/cyrene-agent.ts src/main/orchestrator/cyrene-agent.test.ts
git add -p src/main/orchestrator/two-phase-fc-loop.ts src/main/orchestrator/cyrene-agent.ts src/main/orchestrator/cyrene-agent.test.ts
git diff --cached --check
git commit -m "feat: map streamed tool arguments to agui"
```

Expected: no unrelated `resolvedWorkspaceRoot` or React changes are staged.

---

### Task 7: Migrate the two-phase WorkLoop to true SDK streaming

**Files:**
- Modify: `src/main/orchestrator/two-phase-fc-loop.ts`
- Modify: `src/main/orchestrator/two-phase-fc-loop.test.ts`

- [ ] **Step 1: Add an injectable model-call seam to tests**

Extend `TwoPhaseFcOptions` with an optional dependency used only to replace the production SDK runtime in tests:

```ts
streamChat?: typeof streamChatWithSdk;
```

Default it inside `runTwoPhaseFcLoop`:

```ts
const streamChat = options.streamChat ?? streamChatWithSdk;
```

This keeps all WorkLoop tests deterministic and network-free.

- [ ] **Step 2: Write failing live-reasoning tests**

Add tests where the injected `streamChat` calls `onDelta` asynchronously before resolving its final `ChatResponse`. Assert:

- `reasoning_message_start` is emitted on the first non-empty reasoning delta.
- Each reasoning delta is forwarded immediately, not collapsed into the final full thinking string.
- `reasoning_message_end` is emitted exactly once when that model call ends, including calls that then execute tools.
- The existing buffered `emitReasoningMessage` does not emit a duplicate after the final response.
- Blank reasoning deltas do not open a reasoning message.

- [ ] **Step 3: Write failing soul-text streaming tests**

For the Soul phase, assert:

- `text_message_start` opens on the first non-empty text delta.
- Every text delta is emitted before the model promise resolves.
- `text_message_end` occurs once after successful terminal reconciliation.
- The returned `reply` equals the final authoritative `ChatResponse.text`.
- If live text and final Anthropic text differ, the UI receives live deltas but persistence/return uses the SDK terminal value; diagnostic handling remains in the runtime.

- [ ] **Step 4: Write failing tool lifecycle tests**

Drive unified tool deltas for two interleaved tool calls and assert standard ordering:

```text
tool_call_start
tool_call_args (zero or more)
tool_call_end
tool_call_result (after actual execution)
```

Additional assertions:

- Start opens on the first argument delta (or tool-call end when there are no arguments) after a stable server `id` and non-empty accumulated name exist. This lets partial name fragments finish before AG-UI receives `toolCallName`; buffered earlier fragments flush when start opens.
- No fabricated tool-call ID is generated.
- Existing execution code does not emit a second start/end pair.
- Tool permission checks, execution ordering, truncation, `appendToolResults`, and `ToolExecutionContext` are unchanged.
- A protocol error prevents the incomplete call from reaching `executeTool` and enters the existing safe Soul fallback path.

- [ ] **Step 5: Write failing timeout and phase-semantics tests**

Assert:

- `E_MODEL_REQUEST_TIMEOUT` increments the existing consecutive-timeout counter and follows the current fallback threshold.
- Caller `AbortError` exits as cancellation and is not counted as provider timeout.
- Tool-phase free text remains hidden and is not appended to `conversation`.
- In optimized first round with no tools, buffered tool-phase text is emitted once as the direct final response.
- Soul phase sends no tools and applies `soulSampling` exactly as before.
- Usage is recorded once per SDK call from the final authoritative response.

- [ ] **Step 6: Run the WorkLoop file and confirm red**

```powershell
npx vitest run src/main/orchestrator/two-phase-fc-loop.test.ts
```

Expected: new streaming-order assertions fail against the current buffered `callAdapter` path.

- [ ] **Step 7: Replace only WorkLoop model I/O**

In `two-phase-fc-loop.ts`:

- Remove the local fetch-based `callAdapter` after all call sites are migrated.
- Call `streamChat` for every tool and Soul model request with the existing adapter, request, settings, per-phase timeout, and caller signal.
- Introduce a small per-call event bridge that owns only open/closed message state and tool UI lifecycle.
- Stream reasoning in both phases.
- Buffer tool-phase text because the loop cannot know until terminal state whether the call is an intermediate tool decision; emit it only for the existing optimized direct-answer branch.
- Stream Soul text immediately.
- Close any opened reasoning/text/tool event exactly once on success or failure.
- Use final `ChatResponse` for conversation persistence, tool execution, usage, and returned reply.
- Delete `sliceToDeltas` and buffered `emitReasoningMessage` only after their last use is gone. Retain `emitTextMessage` only for synthetic fallback replies that never came from a model stream.

- [ ] **Step 8: Verify WorkLoop, AG-UI mapping, and provider runtime together**

```powershell
npx vitest run src/main/orchestrator/two-phase-fc-loop.test.ts src/main/orchestrator/cyrene-agent.test.ts src/main/orchestrator/vendors/sdk-stream/*.test.ts
npx tsc -p tsconfig.main.json --noEmit
```

Expected: all pass, with no real HTTP.

- [ ] **Step 9: Inspect overlap and commit only this migration**

```powershell
git diff -- src/main/orchestrator/two-phase-fc-loop.ts src/main/orchestrator/two-phase-fc-loop.test.ts
git add -p src/main/orchestrator/two-phase-fc-loop.ts src/main/orchestrator/two-phase-fc-loop.test.ts
git diff --cached --check
git commit -m "feat: stream workloop through provider sdks"
```

Expected: the commit contains the integrated reasoning-stream replacement, not a reversal of the pre-existing work.

---

### Task 8: Lock provider compatibility with transport-contract fixtures

**Files:**
- Create: `src/main/orchestrator/vendors/sdk-stream/provider-contracts.test.ts`
- Modify only if a fixture proves it necessary: `src/main/orchestrator/vendors/sdk-stream/openai-normalizer.ts`
- Modify only if a fixture proves it necessary: `src/main/orchestrator/vendors/sdk-stream/anthropic-normalizer.ts`
- Modify only if a fixture proves it necessary: `src/main/orchestrator/vendors/sdk-stream/client-config.ts`

- [ ] **Step 1: Add one compact fixture per built-in provider**

Use the capability table as the provider list: MiniMax, DeepSeek, Doubao, GLM, Kimi, Qwen, OpenAI, Claude, and MiMo. For each fixture assert:

- selected transport matches the existing capability/explicit transport result;
- endpoint and auth mapping are correct;
- model/provider extension fields survive the adapter-built body passed to the SDK;
- text, reasoning, tool call, usage, and finish fields normalize when supported;
- unsupported fields are ignored safely rather than mistaken for user text.

The nine-provider table must collectively include ordinary text, reasoning, one tool, interleaved multiple tools, fragmented arguments, and all supported finish reasons. Cancellation/timeout remain transport-level runtime fixtures from Task 5 rather than being redundantly repeated nine times. Run the existing `json-agent-provider-compat.test.ts` beside this table to prove the A/B/M/D structured-output tiers did not change.

For providers exposing both protocols, include one additional explicit-transport fixture. Do not change the user's configured transport or silently switch MiniMax defaults as part of this task.

- [ ] **Step 2: Run the contract file and confirm any genuine gaps**

```powershell
npx vitest run src/main/orchestrator/vendors/sdk-stream/provider-contracts.test.ts
```

Expected: initially fails only on unimplemented provider field differences, not on network access.

- [ ] **Step 3: Make minimal normalizer/config corrections**

Add only data-field aliases or endpoint/auth mapping proven by fixtures. Do not add provider branches to the accumulator or WorkLoop.

- [ ] **Step 4: Run all vendor tests**

```powershell
npx vitest run src/main/orchestrator/vendors src/main/orchestrator/vendors/json-agent-provider-compat.test.ts
```

Expected: SDK-stream and legacy adapter/SSE tests all pass side-by-side.

- [ ] **Step 5: Commit the provider contract suite**

```powershell
git add src/main/orchestrator/vendors/sdk-stream/provider-contracts.test.ts src/main/orchestrator/vendors/sdk-stream/openai-normalizer.ts src/main/orchestrator/vendors/sdk-stream/anthropic-normalizer.ts src/main/orchestrator/vendors/sdk-stream/client-config.ts
git diff --cached --check
git commit -m "test: lock provider sdk streaming contracts"
```

---

### Task 9: Verify the migration without touching later-phase consumers

**Files:**
- No planned source changes
- Update only if test evidence reveals a defect inside Tasks 1-8 scope

- [ ] **Step 1: Run the focused suite five consecutive times**

```powershell
1..5 | ForEach-Object {
  npx vitest run src/main/orchestrator/vendors/sdk-stream src/main/orchestrator/two-phase-fc-loop.test.ts src/main/orchestrator/cyrene-agent.test.ts
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
```

Expected: five clean runs with no timing flake and no network access.

- [ ] **Step 2: Run the complete suite serially**

```powershell
npx vitest run --maxWorkers=1 --no-file-parallelism
```

Expected: all tests pass serially.

- [ ] **Step 3: Run the default complete suite**

```powershell
npm test
```

Expected: all tests pass under the repository's normal concurrency.

- [ ] **Step 4: Run TypeScript and production build**

```powershell
npx tsc -p tsconfig.main.json --noEmit
npm run build
```

Expected: both pass.

- [ ] **Step 5: Audit architecture boundaries and repository state**

Run:

```powershell
rg -n "fetch\(|createSseReader|parseStreamEvent" src/main/orchestrator/two-phase-fc-loop.ts
rg -n "openai|anthropic|provider|schema|retry|permission|prompt" src/main/orchestrator/vendors/sdk-stream/accumulator.ts
git status --short
git log --oneline -8
```

Expected:

- WorkLoop has no direct fetch/SSE parsing.
- The accumulator contains no provider selection, schema repair, retry, permission, or prompt logic.
- Legacy SSE code still exists only for explicitly deferred consumers.
- Pre-existing unrelated dirty files remain intact and unstaged.

- [ ] **Step 6: Record the phase boundary in the completion report**

The report must state:

- WorkLoop now streams through official SDK transports.
- Anthropic live deltas and terminal snapshots are both consumed.
- OpenAI tool IDs use first-value consistency, never concatenation.
- No production default retry/timeout policy outside WorkLoop changed.
- Chat, Memory, structured output, and final legacy SSE deletion remain separate follow-up migrations.
- Exact focused-repeat, serial-suite, default-suite, type-check, build, commit, and `git status --short` results.

Do not start the later migration in the same implementation series.

---

## Follow-up Phase (Explicitly Out of Scope Here)

After this plan is complete and stable, write a separate plan to migrate `chat-loop.ts`, the direct stream path in `src/main/index.ts`, Memory/structured-output consumers where appropriate, and only then remove the legacy HTTP/SSE protocol infrastructure. That later phase must re-evaluate whether SDK-native schema helpers can replace any remaining A/B/M/D transport parsing without weakening local validation or repair.
