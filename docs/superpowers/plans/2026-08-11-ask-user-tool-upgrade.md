# Ask User Tool Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade Harness `ask_user` into a general pause-and-resume question tool that accepts one to three required single-select, multi-select, or free-text questions without mode-specific behavior or a skip action.

**Architecture:** Keep Cyrene's existing Harness, `requestUserClarification`, AG-UI event, IPC, and composer-card lifecycle. Borrow OpenCode's question contract and pending-request semantics only: the model supplies structured questions, Main validates and publishes opaque option identifiers, Renderer collects every required answer, and Main maps the submission back to canonical values before the same Harness run resumes.

**Tech Stack:** TypeScript 5.6, Electron IPC, React 19, AG-UI custom events, Vitest 4.

## Global Constraints

- One `ask_user` call contains 1-3 questions; more than 3 is rejected rather than silently truncated.
- Question types are `single_select`, `multi_select`, and `text`.
- `single_select` has 2-6 options; `multi_select` has 2-8 options; `text` has no options.
- Every `ask_user` question permits a non-empty custom answer, including an explicit instruction such as "停止".
- Every question is required. The Ask card exposes no skip/ignore action and cannot submit until every question has an answer.
- Selecting options and entering custom text are mutually exclusive within one question.
- User text such as "停止" is returned verbatim to the model; Runtime does not reinterpret it as cancellation.
- Timeout, unavailable UI, malformed submission, and cancellation are not valid user answers. Cancellation continues to propagate through the existing `AbortSignal` path.
- Work, Code, and Learn share the same Ask tool contract and common prompt. Chat remains on `chatloop` and does not gain Harness tools.
- Preserve `confirm_uncertain_effect` as a Runtime-owned fixed-choice card with custom input disabled.
- Do not introduce OpenCode's `Effect` runtime or copy its session service. Cyrene already owns the required pending Promise, event, IPC, cancellation, and session identity chain.
- Do not add a new dependency.

---

## File Structure

- `src/shared/ask-clarification.ts`: shared Main/Renderer card and submission contract; allow public text questions and Runtime-owned cards with custom input disabled.
- `src/main/orchestrator/harness/builtin-tools.ts`: model-facing `ask_user` schema, runtime validation, card construction, and truthful answer observation.
- `src/main/orchestrator/harness/builtin-tools.test.ts`: contract, validation, answer mapping, timeout, and abort regression tests.
- `src/main/orchestrator/ask-card.ts`: publish opaque option IDs and validate required single/multi/text submissions.
- `src/main/orchestrator/ask-card.test.ts`: Main boundary tests, including forged, incomplete, and text-only submissions.
- `src/renderer/react/features/chat/components/run-presentation.ts`: normalize public text questions and keep option/custom answer XOR behavior.
- `src/renderer/react/features/chat/components/run-presentation.test.ts`: renderer normalization and submission tests for all three question types.
- `src/renderer/react/features/chat/components/InteractionPanel.tsx`: render text-only questions without an empty option group and expose no Ask skip action.
- `src/renderer/react/features/chat/components/InteractionPanel.test.tsx`: component-level required-answer and no-skip assertions.
- `prompts/tools_system.md`: common rule directing model questions through `ask_user` instead of a final response.
- `prompts/tools_system_optimized_first.md`: keep the optimized common tool prompt semantically identical.
- `src/main/skills/skill-catalog.ts`: replace stale `ask_user_choice` wording with the canonical `ask_user` tool name.
- `src/main/skills/skill-catalog.test.ts`: verify the generated catalog contains only the canonical Ask name.
- `src/main/orchestrator/harness/cyrene-harness.test.ts`: integration test proving Ask waits, returns structured answers, and resumes the same model loop.
- `src/main/orchestrator/harness/cyrene-harness-cancel.test.ts`: preserve cancellation while Ask is waiting.

---

### Task 1: Freeze the Ask contract and validate model input

**Files:**
- Modify: `src/shared/ask-clarification.ts:76`
- Modify: `src/main/orchestrator/harness/builtin-tools.ts:204`
- Test: `src/main/orchestrator/harness/builtin-tools.test.ts`

**Interfaces:**
- Produces: `HarnessAskQuestionType`, `HarnessAskQuestion`, and `parseAskQuestions(raw): HarnessAskQuestion[]` local to `builtin-tools.ts`.
- Produces: `AskQuestionView.customInput.enabled: boolean`, allowing general Ask cards to publish `true` while `confirm_uncertain_effect` publishes `false`.
- Consumes: existing `AskClarificationCard`, `AskUserAnswer`, `ToolCall`, and `ToolObservation` types.

- [ ] **Step 1: Write failing tests for the public tool schema**

Add assertions that the tool advertises one to three questions and all three types:

```ts
import {
  askUserToolSpec,
  executeAskUser,
} from "./builtin-tools";

it("advertises one to three required single, multiple, or text questions", () => {
  const questions = askUserToolSpec.parameters.properties?.questions as Record<string, unknown>;
  expect(questions).toMatchObject({ type: "array", minItems: 1, maxItems: 3 });
  expect(JSON.stringify(questions)).toContain("single_select");
  expect(JSON.stringify(questions)).toContain("multi_select");
  expect(JSON.stringify(questions)).toContain("text");
  expect(askUserToolSpec.description).toContain("不要用最终回复向用户提问");
});
```

- [ ] **Step 2: Run the schema test and verify it fails**

Run:

```powershell
npx vitest run src/main/orchestrator/harness/builtin-tools.test.ts
```

Expected: FAIL because the current schema has no question `type`, no `minItems`/`maxItems`, and still requires options for every question.

- [ ] **Step 3: Define the model-facing discriminated contract**

Change `askUserToolSpec` so its question item describes this exact shape:

```ts
type HarnessAskQuestionType = "single_select" | "multi_select" | "text";

interface HarnessAskQuestion {
  id: string;
  question: string;
  type: HarnessAskQuestionType;
  options: Array<{ label: string; value: string; description?: string }>;
}
```

The JSON schema must set `questions.minItems = 1`, `questions.maxItems = 3`, require `id`, `question`, and `type`, and make `options` optional so `text` is representable. Do not expose `allowCustom`; this tool always enables custom input by contract.

Use this tool description:

```text
在执行过程中需要用户提供偏好、澄清歧义、选择方向或补充自由文本时调用。一次可问 1-3 个问题；支持单选、多选和自由填写。每题都必须回答，用户也可以自由填写“停止”等明确意图。不要用最终回复向用户提问；需要用户回答后继续当前任务时，应调用此工具。
```

- [ ] **Step 4: Write failing runtime-validation tests**

Cover exact invalid inputs without invoking `requestUserClarification`:

```ts
it.each([
  { name: "four questions", questions: Array.from({ length: 4 }, (_, i) => ({ id: `q${i}`, question: "?", type: "text" })) },
  { name: "single with one option", questions: [{ id: "q", question: "?", type: "single_select", options: [{ label: "A", value: "a" }] }] },
  { name: "single with seven options", questions: [{ id: "q", question: "?", type: "single_select", options: Array.from({ length: 7 }, (_, i) => ({ label: `${i}`, value: `${i}` })) }] },
  { name: "multi with nine options", questions: [{ id: "q", question: "?", type: "multi_select", options: Array.from({ length: 9 }, (_, i) => ({ label: `${i}`, value: `${i}` })) }] },
  { name: "text with options", questions: [{ id: "q", question: "?", type: "text", options: [{ label: "A", value: "a" }, { label: "B", value: "b" }] }] },
])("rejects $name", async ({ questions }) => {
  const request = vi.fn();
  const result = await executeAskUser({ id: "ask", name: "ask_user", arguments: JSON.stringify({ questions }) }, request);
  expect(result).toMatchObject({ outcome: "failure", category: "invalid_arguments" });
  expect(request).not.toHaveBeenCalled();
});
```

Also reject duplicate/blank question IDs, blank prompts, duplicate option values, and blank labels/values.

- [ ] **Step 5: Run the validation tests and verify they fail**

Run:

```powershell
npx vitest run src/main/orchestrator/harness/builtin-tools.test.ts
```

Expected: FAIL because the current implementation accepts and normalizes malformed questions.

- [ ] **Step 6: Implement strict parsing without silent correction**

Add a parser that returns either validated questions or an explanatory invalid-arguments observation. Its cardinality rules are:

```ts
const limits = {
  single_select: { min: 2, max: 6 },
  multi_select: { min: 2, max: 8 },
  text: { min: 0, max: 0 },
} as const;
```

Do not slice excess questions or options. A rejected call returns an observation telling the model which rule failed so it can issue a corrected logical invocation.

- [ ] **Step 7: Build all three card types and map every answer truthfully**

Construct `AskClarificationCard.questions` as follows:

```ts
{
  field: question.id,
  question: question.question,
  type: question.type,
  options: question.options,
  allowCustom: true,
  freeTextPlaceholder: question.type === "text" ? "请输入回答" : "或填写其他回答",
}
```

Return arrays for multi-select answers and preserve trimmed custom text:

```ts
interface AskAnswer {
  questionId: string;
  selectedValues?: string[];
  selectedLabels?: string[];
  customInput?: string;
}
```

If `requestUserClarification` returns fewer answers than questions, return `outcome: "failure"`, `category: "timeout"`, and do not manufacture `null` answers. Continue rethrowing `AbortError`.

- [ ] **Step 8: Run the Task 1 tests**

Run:

```powershell
npx vitest run src/main/orchestrator/harness/builtin-tools.test.ts
npm run build:main
```

Expected: all targeted tests PASS and Main TypeScript compilation exits 0.

- [ ] **Step 9: Commit Task 1**

```powershell
git add src/shared/ask-clarification.ts src/main/orchestrator/harness/builtin-tools.ts src/main/orchestrator/harness/builtin-tools.test.ts
git commit -m "feat: expand harness ask contract"
```

---

### Task 2: Enforce required answers at the Main/Renderer boundary

**Files:**
- Modify: `src/main/orchestrator/ask-card.ts:52`
- Test: `src/main/orchestrator/ask-card.test.ts`
- Modify: `src/renderer/react/features/chat/components/run-presentation.ts:265`
- Test: `src/renderer/react/features/chat/components/run-presentation.test.ts`

**Interfaces:**
- Consumes: `AskClarificationCard` produced by Task 1.
- Produces: opaque `AskCardPayload` supporting zero-option text questions, option questions, and `customInput.enabled: boolean`.
- Preserves: `resolveAskCardSubmission(publication, submission): AskUserAnswer` as the sole canonical-value reconstruction boundary.

- [ ] **Step 1: Write failing Main publication tests**

Add a mixed three-question card test:

```ts
const card: AskClarificationCard = {
  mode: "semantic_clarification",
  intro: "确认三件事。",
  questions: [
    { field: "format", question: "格式？", type: "single_select", options: [{ value: "md", label: "Markdown" }, { value: "docx", label: "Word" }], allowCustom: true, freeTextPlaceholder: "其他格式" },
    { field: "sections", question: "包含哪些章节？", type: "multi_select", options: [{ value: "summary", label: "摘要" }, { value: "risks", label: "风险" }], allowCustom: true, freeTextPlaceholder: "其他章节" },
    { field: "note", question: "还有什么要求？", type: "text", options: [], allowCustom: true, freeTextPlaceholder: "请输入要求" },
  ],
  deferredFields: [],
};
```

Assert that publication preserves `multiple`, emits no options for `text`, and enables custom input for all three. Add a separate Runtime-owned card assertion proving `allowCustom: false` becomes `customInput.enabled: false`.

- [ ] **Step 2: Write failing Main submission tests**

Assert that:

- a mixed single/multi/text submission maps opaque IDs back to canonical values;
- multi-select keeps all selected values in submitted order;
- a custom answer is mutually exclusive with option IDs;
- blank custom text fails;
- a missing question, duplicate question, forged option ID, or mismatched run/revision fails with `E_ASK_ANSWER_INVALID`.

Use this expected answer shape:

```ts
{
  requestId: "choice-1",
  answers: [
    { field: "format", selectedValues: ["md"] },
    { field: "sections", selectedValues: ["summary", "risks"] },
    { field: "note", customText: "停止当前任务" },
  ],
}
```

- [ ] **Step 3: Run Main boundary tests and verify they fail**

Run:

```powershell
npx vitest run src/main/orchestrator/ask-card.test.ts
```

Expected: FAIL because `publishAskCard` currently always enables custom input and existing builders reject zero-option text questions.

- [ ] **Step 4: Implement card publication and strict reconstruction**

In `publishAskCard`, emit:

```ts
customInput: {
  enabled: question.allowCustom,
  ...(question.freeTextPlaceholder ? { placeholder: question.freeTextPlaceholder } : {}),
}
```

Allow an empty option map only when `question.type === "text"`. In `resolveAskCardSubmission`, require one answer for every published question and reject any custom answer when that question's `allowCustom` is false. Extend private publication metadata with `allowCustom: boolean` so this rule remains Main-owned.

- [ ] **Step 5: Write failing Renderer normalization tests**

Add one public payload containing a text question with `options: []` and assert it normalizes. Add mixed multi-select/custom drafts and assert submission is disabled until all three questions are answered. Assert the final submission contains `optionId`, `optionIds`, and custom `text` in the correct union members.

- [ ] **Step 6: Run Renderer presentation tests and verify they fail**

Run:

```powershell
npx vitest run src/renderer/react/features/chat/components/run-presentation.test.ts
```

Expected: FAIL because public card normalization currently requires at least two options for every question.

- [ ] **Step 7: Normalize questions according to their actual type**

Change the public normalization guard from a universal `options.length < 2` rejection to:

```ts
const multiple = question.multiple === true;
const isText = options.length === 0;
if (!id || !prompt || typeof customInput?.enabled !== "boolean") return [];
if (!isText && options.length < 2) return [];
if (isText && customInput.enabled !== true) return [];
```

Represent text questions as `options: []`, `multiple: false`, `allowCustomInput: true`. Keep `isAskComplete` unchanged in principle: every question requires either at least one selected option or non-empty custom text.

- [ ] **Step 8: Run Task 2 tests**

Run:

```powershell
npx vitest run src/main/orchestrator/ask-card.test.ts src/renderer/react/features/chat/components/run-presentation.test.ts
npm run build:main
npm run build:renderer
```

Expected: all targeted tests PASS and both builds exit 0.

- [ ] **Step 9: Commit Task 2**

```powershell
git add src/main/orchestrator/ask-card.ts src/main/orchestrator/ask-card.test.ts src/renderer/react/features/chat/components/run-presentation.ts src/renderer/react/features/chat/components/run-presentation.test.ts
git commit -m "feat: validate required ask submissions"
```

---

### Task 3: Finish the required-answer Ask card UI

**Files:**
- Modify: `src/renderer/react/features/chat/components/InteractionPanel.tsx:26`
- Create: `src/renderer/react/features/chat/components/InteractionPanel.test.tsx`
- Modify: `src/renderer/react/features/chat/components/RunExperience.css:120`

**Interfaces:**
- Consumes: `AskUserInteraction` and draft helpers from Task 2.
- Produces: a single composer-slot card with 1-3 paged questions, no skip action, and submit enabled only when all required answers are complete.

- [ ] **Step 1: Write failing component tests**

Render `AskUserPanel` with React DOM server or the repository's existing jsdom pattern and assert:

```tsx
const interaction: AskUserInteraction = {
  kind: "ask",
  id: "choice-1",
  runId: "run-1",
  revision: 1,
  responseKind: "submission",
  question: "格式？",
  options: [],
  questions: [
    { id: "q1", question: "格式？", options: [{ id: "md", label: "Markdown" }, { id: "docx", label: "Word" }], multiple: false, allowCustomInput: true },
    { id: "q2", question: "章节？", options: [{ id: "summary", label: "摘要" }, { id: "risks", label: "风险" }], multiple: true, allowCustomInput: true },
    { id: "q3", question: "补充要求？", options: [], multiple: false, allowCustomInput: true },
  ],
};
```

Assertions:

- no button named `忽略` or `跳过` exists;
- the text question renders an input but no empty radio/checkbox group;
- a Runtime-owned question with `allowCustomInput: false` renders no custom input;
- submit begins disabled;
- answering only two questions keeps submit disabled;
- answering all three enables `提交全部`;
- entering custom text clears selected options for that question, and selecting an option clears its custom text.

- [ ] **Step 2: Run the component test and verify it fails**

Run:

```powershell
npx vitest run src/renderer/react/features/chat/components/InteractionPanel.test.tsx
```

Expected: at least the text-only rendering assertion fails because the component always renders an options container.

- [ ] **Step 3: Render text, single-select, and multi-select intentionally**

In `AskUserPanel`:

```tsx
{current.options.length > 0 && (
  <div className="cy-interaction-panel__options" role={current.multiple ? "group" : "radiogroup"} aria-label={current.question}>
    {/* existing option buttons */}
  </div>
)}
```

Use `当前问题已回答 / 当前问题待回答` as accessible status text in the pager. Render the custom field conditionally:

```tsx
{current.allowCustomInput !== false && (
  <label className="cy-interaction-panel__custom-answer">
    {/* existing input */}
  </label>
)}
```

General `ask_user` always supplies `true`; `confirm_uncertain_effect` supplies `false` and must not gain a text override.

- [ ] **Step 4: Remove the Ask skip affordance**

Remove the `忽略` button from `AskUserPanel` for every Ask response kind. The existing callback prop may remain temporarily for caller compatibility, but no Ask card may expose a skip/ignore control. Legacy callers still permit a non-empty custom answer, so users can explicitly state "停止" or "不继续".

- [ ] **Step 5: Add only the CSS needed by the new states**

Add a visually muted current-question completion label and keep the existing white/pink styling. Do not replace the PNG mood artwork, resize the composer slot, or introduce a new panel component.

- [ ] **Step 6: Run Task 3 tests and build**

Run:

```powershell
npx vitest run src/renderer/react/features/chat/components/InteractionPanel.test.tsx src/renderer/react/features/chat/components/run-presentation.test.ts
npm run build:renderer
```

Expected: tests PASS and Renderer build exits 0.

- [ ] **Step 7: Commit Task 3**

```powershell
git add src/renderer/react/features/chat/components/InteractionPanel.tsx src/renderer/react/features/chat/components/InteractionPanel.test.tsx src/renderer/react/features/chat/components/RunExperience.css
git commit -m "feat: support required multi-question ask cards"
```

---

### Task 4: Teach every Harness mode when to use Ask

**Files:**
- Modify: `prompts/tools_system.md:15`
- Modify: `prompts/tools_system_optimized_first.md:18`
- Modify: `src/main/skills/skill-catalog.ts:13`
- Test: `src/main/skills/skill-catalog.test.ts`
- Test: `src/main/orchestrator/harness-adapter.test.ts`

**Interfaces:**
- Consumes: canonical tool name `ask_user` and the Task 1 contract.
- Produces: one common Harness instruction shared by Work, Code, and Learn; no per-mode Ask prompt.

- [ ] **Step 1: Write failing common-prompt tests**

Add assertions to `harness-adapter.test.ts`:

```ts
it("uses the same general Ask guidance in every Harness mode", () => {
  const common = {
    soulSystemBaseContent: "persona",
    toolSystemContent: "需要用户回答后才能继续时，调用 ask_user；不要生成最终回复来提问。",
  };
  const prompts = (["work", "code", "learn"] as const)
    .map((conversationMode) => buildHarnessSystemPrompt({ ...common, conversationMode } as never));
  expect(new Set(prompts).size).toBe(1);
  expect(prompts[0]).toContain("调用 ask_user");
  expect(prompts[0]).toContain("不要生成最终回复来提问");
});
```

Add a catalog assertion:

```ts
expect(buildSkillCatalog(skills)).toContain("ask_user");
expect(buildSkillCatalog(skills)).not.toContain("ask_user_choice");
```

- [ ] **Step 2: Run prompt tests and verify the stale wording fails**

Run:

```powershell
npx vitest run src/main/orchestrator/harness-adapter.test.ts src/main/skills/skill-catalog.test.ts
```

Expected: skill catalog assertion FAILS because it still names `ask_user_choice`.

- [ ] **Step 3: Replace the common tool rule**

Use the same rule in both common tool prompt variants:

```text
7. 当继续任务需要用户提供偏好、澄清歧义、选择方向或补充信息时，调用 ask_user 并等待回答；不要生成最终回复来向用户提问。一次只问当前推进所必需的 1-3 个问题，能从上下文确定的信息不要重复询问。
```

This rule permits divergent questions but does not encourage unnecessary interruption. It is global Harness guidance, not a Work/Code/Learn branch.

- [ ] **Step 4: Replace stale skill-catalog tool names**

Change every `ask_user_choice` occurrence in `AMBIGUITY_POLICY` to `ask_user`. Keep the existing guidance that explicit details and "你自己决定" should proceed without asking.

- [ ] **Step 5: Run Task 4 tests**

Run:

```powershell
npx vitest run src/main/orchestrator/harness-adapter.test.ts src/main/skills/skill-catalog.test.ts
npm run build:main
```

Expected: tests PASS and Main build exits 0.

- [ ] **Step 6: Commit Task 4**

```powershell
git add prompts/tools_system.md prompts/tools_system_optimized_first.md src/main/skills/skill-catalog.ts src/main/skills/skill-catalog.test.ts src/main/orchestrator/harness-adapter.test.ts
git commit -m "feat: route harness questions through ask user"
```

---

### Task 5: Close the pause, resume, timeout, and cancellation loop

**Files:**
- Modify: `src/main/orchestrator/harness/cyrene-harness.test.ts`
- Modify: `src/main/orchestrator/harness/cyrene-harness-cancel.test.ts`
- Modify only if a failing integration test proves necessary: `src/main/orchestrator/harness/cyrene-harness.ts:191`
- Modify only if a failing integration test proves necessary: `src/main/user-choice.ts:101`

**Interfaces:**
- Consumes: Task 1-4 Ask contract and existing `requestUserClarification` callback.
- Proves: Ask remains exclusive, pauses active execution time, resumes the same run after a complete answer, and aborts cleanly while waiting.

- [ ] **Step 1: Write a Harness integration test for Ask then resume**

Drive two model rounds:

```ts
const generate = vi
  .fn()
  .mockResolvedValueOnce({
    text: "我需要先确认两个选择。",
    toolCalls: [{
      id: "ask-1",
      name: "ask_user",
      arguments: JSON.stringify({
        questions: [
          { id: "format", question: "格式？", type: "single_select", options: [{ label: "Markdown", value: "md" }, { label: "Word", value: "docx" }] },
          { id: "sections", question: "章节？", type: "multi_select", options: [{ label: "摘要", value: "summary" }, { label: "风险", value: "risks" }] },
          { id: "note", question: "补充要求？", type: "text" },
        ],
      }),
    }],
  })
  .mockResolvedValueOnce({ text: "已经按你的选择继续完成。", toolCalls: [] });
```

Resolve the clarification with one single option, two multi options, and custom text. Assert the second model request contains a successful `ask_user` observation with all canonical answers and retains the same run context.

- [ ] **Step 2: Run the resume test and verify the first failure**

Run:

```powershell
npx vitest run src/main/orchestrator/harness/cyrene-harness.test.ts
```

Expected before Tasks 1-4: FAIL because multi/text answers are not mapped completely. After Tasks 1-4, it should PASS without production changes unless the integration reveals a real boundary defect.

- [ ] **Step 3: Write timeout and unavailable-UI tests**

Return `{ answers: [] }` from `requestUserClarification` and assert the tool observation is a failure, not "用户已回答 0 个问题" success. Invoke without `requestUserClarification` and preserve the existing `runtime_safety` failure.

- [ ] **Step 4: Preserve cancellation while waiting**

In `cyrene-harness-cancel.test.ts`, start a never-resolving clarification Promise, abort the run, and assert:

```ts
expect(result.terminateReason).toBe("cancelled");
expect(result.finalAnswer).not.toContain("已经按你的选择继续");
```

Also assert no subsequent model call or ordinary tool call begins after abort.

- [ ] **Step 5: Run the complete Ask regression set**

Run:

```powershell
npx vitest run src/main/orchestrator/harness/builtin-tools.test.ts src/main/orchestrator/ask-card.test.ts src/main/orchestrator/harness/cyrene-harness.test.ts src/main/orchestrator/harness/cyrene-harness-cancel.test.ts src/main/orchestrator/harness-adapter.test.ts src/main/skills/skill-catalog.test.ts src/renderer/react/features/chat/components/run-presentation.test.ts src/renderer/react/features/chat/components/InteractionPanel.test.tsx
```

Expected: all Ask-focused tests PASS.

- [ ] **Step 6: Run full verification**

Run:

```powershell
npx vitest run
npm run build:main
npm run build:preload
npm run build:renderer
```

Expected: full Vitest suite has 0 failures; all three builds exit 0. Existing intentional skips may remain skipped.

- [ ] **Step 7: Commit Task 5**

```powershell
git add src/main/orchestrator/harness/cyrene-harness.test.ts src/main/orchestrator/harness/cyrene-harness-cancel.test.ts
git commit -m "test: cover ask pause and resume lifecycle"
```

If Step 2 or Step 4 required a minimal production fix, add only the proven production file to this commit and describe the exact integration defect in the commit body.

---

## Acceptance Scenarios

### Scenario 1: One free-text question

User: `帮我把这个方案写得更贴近我的项目。`

Cyrene calls `ask_user` with one `text` question. The card contains one text input and a disabled Submit button. Entering `先强调桌面宠物，再讲 Agent` enables Submit. Cyrene resumes the same run and uses that exact text.

### Scenario 2: Three mixed questions

Cyrene asks format (single), desired sections (multiple), and special requirements (text). The card shows `1 / 3`, allows navigation without losing drafts, and enables `提交全部` only after all three have answers.

### Scenario 3: Custom answer instead of model options

For a single-select question, the user ignores all suggested options and types `用纯文本，不生成文件`. The selected options are cleared, the custom text is returned to the model, and the run resumes.

### Scenario 4: Explicit stop through free text

The user types `停止，不要继续修改文件` in the custom field and submits. The tool returns that exact answer to the model. The model should acknowledge and end semantically; Runtime does not falsely label the user answer as an `AGUI_CANCEL` event.

### Scenario 5: Cancellation while Ask is open

The user presses the application stop control instead of submitting. The pending Ask is cancelled, the card closes for the matching run, no later model/tool round starts, and the run settles as `cancelled`.

### Scenario 6: Malformed model call

The model sends four questions or a single-select question with only one option. No card appears. The model receives an `invalid_arguments` observation explaining the exact bound and may issue a corrected `ask_user` call.

## Definition of Done

- General `ask_user` works identically in Work, Code, and Learn.
- A single call accepts 1-3 questions and rejects larger calls.
- Single-select, multi-select, and text-only questions all round-trip correctly.
- Every general Ask question supports a custom answer.
- No general Ask submission can omit a question or use a skip action.
- `confirm_uncertain_effect` remains fixed-choice with custom input disabled.
- Ask timeout is never reported as a successful empty answer.
- Existing cancellation, run identity, and exactly-once settlement behavior remain green.
- No OpenCode runtime dependency or new package is introduced.
- Full tests and Main/Preload/Renderer builds pass.
