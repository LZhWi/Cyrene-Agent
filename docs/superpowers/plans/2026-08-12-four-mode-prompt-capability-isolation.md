# Four-Mode Prompt and Capability Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Chat / Work / Learn / Code 的 Prompt、工具和 Skill 边界彻底隔离，并保证 UI 模式开关、模型可见 Schema 与 Runtime 执行白名单完全一致。

**Architecture:** 每个 Run 开始时先用显式 `ConversationMode` 解析一份不可变 `RunCapabilities`，然后由模式 Prompt Builder 和 Harness 共同消费这份快照。Chat 继续使用完整 `soul.md`；Work / Learn / Code 只使用各自模式规则、精简 `cyrene_harness.md` 与 `canon_quotes.md`，并且所有动态上下文只注入一次。

**Tech Stack:** TypeScript、Vitest、Electron 主进程、CyreneHarness、现有 ToolRegistry / SkillRegistry，不新增第三方依赖。

## Global Constraints

- 只保留两种 Loop：Chat 使用 ChatLoop；Work / Learn / Code 使用 CyreneHarness。
- Chat 必须拥有空工具集和空 Skill 集，不构建工具 Prompt。
- Work / Learn / Code 的任何模型调用都不得包含 `soul.md`。
- Work 不得包含 Code 或 Learn 模式文件；Learn 不得包含 Work 或 Code 模式文件；Code 不得包含 Work 或 Learn 模式文件。
- Work / Learn / Code 共同使用 `cyrene_harness.md` 和 `canon_quotes.md`。
- 用户模式覆盖优先级：`mode override > manifest modes > default visible`。
- 同一份 `RunCapabilities` 必须同时控制 Prompt 目录、Function Calling Schema、Dispatcher、Skill 加载和 Task 子会话。
- 必须满足：`Prompt 不可见 = Schema 不存在 = Runtime 拒绝执行`。
- Task 子会话能力只能是父 Run 能力的子集，不得重新从全局注册表扩大能力。
- `environmentContext`、`conversationTimeContext`、工作区、CITA、Skill catalog、`canon_quotes` 每轮最多出现一次。
- 不改 Runtime 的结束语义：模型不再调用工具时仍直接结束并提交当前正式回复。
- 保留用户未提交改动；每个 Task 只暂存本 Task 明确列出的文件。

---

## File Map

**Create**

- `src/main/orchestrator/mode-prompt-profile.ts`：四模式文件映射与显式模式 Prompt 构建。
- `src/main/orchestrator/mode-prompt-profile.test.ts`：四模式包含/排除矩阵。
- `src/main/orchestrator/run-capabilities.ts`：一次性解析工具和 Skill 快照。
- `src/main/orchestrator/run-capabilities.test.ts`：覆盖模式、用户覆盖和搜索后端过滤。
- `prompts/work_identity.md`：Work 协作身份。
- `prompts/code_identity.md`：Code 工程协作身份。

**Modify**

- `src/main/orchestrator/system-prompt-builder.ts`：删除通过文件名前缀猜模式的逻辑；工具 Prompt 只接收已过滤能力。
- `src/main/orchestrator/build-options.ts`：先解析能力快照，再组装 Prompt，并把快照传给运行层。
- `src/main/orchestrator/build-options.test.ts`：锁定四模式 Prompt、Schema 和动态上下文。
- `src/main/orchestrator/cyrene-agent.ts`：`CyreneRunOptions` 携带能力快照；禁止 Harness 回退到全局工具。
- `src/main/orchestrator/harness-adapter.ts`：只消费本 Run 工具集，移除 Git 特判与重复上下文。
- `src/main/orchestrator/harness-adapter.test.ts`：验证工作三模式首轮不含 `soul.md`，动态上下文不重复。
- `src/main/orchestrator/harness-adapter-git-tools.test.ts`：迁移为声明式能力过滤测试或删除已失效断言。
- `src/main/orchestrator/tool-context.ts`：携带 `allowedSkillIds`。
- `src/main/skills/skill-tools.ts`：执行 `invoke_skill` / `read_skill_reference` 时强制校验本轮 Skill 白名单。
- `src/main/skills/skill-tools.test.ts`：覆盖模式关闭后的直接调用拒绝。
- `src/main/orchestrator/task-runtime.ts`：Task 子会话继承父 Run 能力快照。
- `src/main/orchestrator/task-runtime.test.ts`：验证子会话无法扩大工具和 Skill。
- `src/main/orchestrator/agent-runtime.ts`：定时任务显式使用 Work profile。
- `src/main/orchestrator/git-tools.ts`、`src/main/orchestrator/lsp-tool.ts`：复用并验证现有 `modes: ["code"]` 声明，不重复增加硬编码模式过滤。

---

### Task 1: Freeze the Four-Mode Prompt Contract

**Files:**
- Create: `src/main/orchestrator/mode-prompt-profile.test.ts`
- Create: `prompts/work_identity.md`
- Create: `prompts/code_identity.md`
- Test: `src/main/orchestrator/mode-prompt-profile.test.ts`

**Interfaces:**
- Consumes: `ConversationMode`, `loadPromptFile(filename)`。
- Produces: 后续实现必须满足的四模式包含/排除矩阵。

- [ ] **Step 1: Write the failing contract test**

```ts
import { describe, expect, it } from "vitest";
import { buildModePrompt } from "./mode-prompt-profile";

const marker = (name: string) => `[${name}]`;
const load = (name: string) => marker(name);

describe("buildModePrompt", () => {
  it.each([
    ["chat", ["chat_system.md", "chat_identity.md", "soul.md", "canon_quotes.md"], ["cyrene_harness.md", "work_system.md", "learn_system.md", "code_system.md"]],
    ["work", ["work_system.md", "work_identity.md", "work_remark.md", "canon_quotes.md"], ["soul.md", "chat_system.md", "learn_system.md", "code_system.md"]],
    ["learn", ["learn_system.md", "learn_identity.md", "canon_quotes.md"], ["soul.md", "chat_system.md", "work_system.md", "code_system.md"]],
    ["code", ["code_system.md", "code_identity.md", "code_remark.md", "canon_quotes.md"], ["soul.md", "chat_system.md", "work_system.md", "learn_system.md"]],
  ] as const)("isolates %s prompt files", (mode, included, excluded) => {
    const prompt = buildModePrompt(mode, load);
    for (const file of included) expect(prompt).toContain(marker(file));
    for (const file of excluded) expect(prompt).not.toContain(marker(file));
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npx vitest run src/main/orchestrator/mode-prompt-profile.test.ts`

Expected: FAIL because `mode-prompt-profile.ts` does not exist.

- [ ] **Step 3: Add the two identity files**

`work_identity.md` must define Work collaboration identity and explicitly defer execution mechanics to `work_system.md`. `code_identity.md` must define engineering collaboration identity and explicitly defer tool truth and safety rules to `code_system.md`. Neither file may copy `soul.md` or `canon_quotes.md`.

- [ ] **Step 4: Commit the frozen contract**

```powershell
git add src/main/orchestrator/mode-prompt-profile.test.ts prompts/work_identity.md prompts/code_identity.md
git commit -m "test: freeze four mode prompt boundaries"
```

---

### Task 2: Replace Filename Guessing with Explicit Mode Profiles

**Files:**
- Create: `src/main/orchestrator/mode-prompt-profile.ts`
- Modify: `src/main/orchestrator/system-prompt-builder.ts`
- Modify: `src/main/orchestrator/mode-prompt-profile.test.ts`

**Interfaces:**
- Produces: `buildModePrompt(mode: ConversationMode, load?: PromptLoader): string`。
- Produces: `buildToolSystemPrompt(mode: ConversationMode, enabledTools: readonly ToolDefinition[]): string`。
- Removes production use of: `buildSystemPrompt(styleFile)` and `buildSoulSystemBasePrompt(styleFile)`。

- [ ] **Step 1: Implement the explicit profile table**

```ts
import type { ConversationMode } from "../../shared/chat-types";
import { loadPromptFile } from "../prompts/prompt-loader";

type PromptLoader = (filename: string) => string;

const MODE_FILES: Record<ConversationMode, readonly string[]> = {
  chat: ["chat_system.md", "chat_identity.md", "soul.md", "canon_quotes.md"],
  work: ["work_system.md", "work_identity.md", "work_remark.md", "canon_quotes.md"],
  learn: ["learn_system.md", "learn_identity.md", "canon_quotes.md"],
  code: ["code_system.md", "code_identity.md", "code_remark.md", "canon_quotes.md"],
};

export function buildModePrompt(mode: ConversationMode, load: PromptLoader = loadPromptFile): string {
  return MODE_FILES[mode].map(load).filter(Boolean).join("\n\n---\n\n");
}
```

- [ ] **Step 2: Make tool Prompt mode-aware without injecting mode persona**

Change the tool builder so its output is exactly:

```ts
return [
  loadPromptFile(isOptimizedFirstRound ? "tools_system_optimized_first.md" : "tools_system.md"),
  "## 当前可用工具",
  buildToolCatalog(enabledTools),
].filter(Boolean).join("\n\n");
```

The `mode` argument is required for API clarity and future mode-specific tool policy, but must not append `code_system.md`, `code_identity.md`, or `code_remark.md`.

- [ ] **Step 3: Run the profile tests**

Run: `npx vitest run src/main/orchestrator/mode-prompt-profile.test.ts src/main/orchestrator/tools-system-prompt.test.ts`

Expected: PASS.

- [ ] **Step 4: Commit**

```powershell
git add src/main/orchestrator/mode-prompt-profile.ts src/main/orchestrator/mode-prompt-profile.test.ts src/main/orchestrator/system-prompt-builder.ts
git commit -m "refactor: isolate mode prompt profiles"
```

---

### Task 3: Resolve One Immutable Capability Snapshot per Run

**Files:**
- Create: `src/main/orchestrator/run-capabilities.ts`
- Create: `src/main/orchestrator/run-capabilities.test.ts`
- Review: `src/main/orchestrator/git-tools.ts`
- Review: `src/main/orchestrator/lsp-tool.ts`

**Interfaces:**
- Produces: `RunCapabilities` and `resolveRunCapabilities(input)`.
- Consumes: `ToolRegistry.getEnabledToolsForMode`, `SkillRegistry.getEnabledForMode`, `filterToolsBySearchBackend`.

- [ ] **Step 1: Write failing resolver tests**

Cover all of these assertions in one table-driven suite:

```ts
const ids = <T extends { id: string }>(items: readonly T[]) => items.map((item) => item.id);
const fakeToolRegistry = {
  getEnabledToolsForMode: vi.fn((mode: ConversationMode) => allTools.filter((tool) => tool.modes?.includes(mode))),
};
const fakeSkillRegistry = {
  getEnabledForMode: vi.fn((mode: "work" | "code" | "learn") => allSkills.filter((skill) => skill.modes?.includes(mode))),
};
const resolve = (mode: ConversationMode, patch: Partial<ResolveRunCapabilitiesInput> = {}) =>
  resolveRunCapabilities({
    mode,
    toolRegistry: fakeToolRegistry,
    skillRegistry: fakeSkillRegistry,
    activeSearchBackend: "off",
    ...patch,
  });

expect(resolve("chat").tools).toEqual([]);
expect(resolve("chat").skills).toEqual([]);
expect(ids(resolve("work").tools)).not.toContain("git_commit");
expect(ids(resolve("code").tools)).toContain("git_commit");
expect(ids(resolve("learn").skills)).toContain("learn-only");
expect(ids(resolve("work", { toolModeOverrides: { custom: { work: false } } }).tools)).not.toContain("custom");
expect(ids(resolve("code", { skillModeOverrides: { workOnly: { code: true } } }).skills)).toContain("workOnly");
expect(ids(resolve("work", { activeSearchBackend: "off" }).tools)).not.toContain("web_search");
```

- [ ] **Step 2: Run and verify RED**

Run: `npx vitest run src/main/orchestrator/run-capabilities.test.ts`

Expected: FAIL because the resolver does not exist.

- [ ] **Step 3: Implement the snapshot**

```ts
export interface RunCapabilities {
  mode: ConversationMode;
  tools: readonly ToolDefinition[];
  toolIds: ReadonlySet<string>;
  skills: readonly SkillEntry[];
  skillIds: ReadonlySet<string>;
}

export function resolveRunCapabilities(input: ResolveRunCapabilitiesInput): RunCapabilities {
  if (input.mode === "chat") {
    return { mode: "chat", tools: [], toolIds: new Set(), skills: [], skillIds: new Set() };
  }
  const tools = filterToolsBySearchBackend(
    input.toolRegistry.getEnabledToolsForMode(input.mode, input.toolModeOverrides),
    input.activeSearchBackend,
  );
  const skills = input.skillRegistry.getEnabledForMode(input.mode, input.skillModeOverrides);
  return {
    mode: input.mode,
    tools,
    toolIds: new Set(tools.map((tool) => tool.id)),
    skills,
    skillIds: new Set(skills.map((skill) => skill.id)),
  };
}
```

- [ ] **Step 4: Verify Code-only declarations are reused**

Git and LSP registrations already carry `modes: ["code"]`. Add resolver assertions for `git_commit` and `lsp`; do not add a second mode table or duplicate hard-coded ID set.

- [ ] **Step 5: Run tests and commit**

Run: `npx vitest run src/main/orchestrator/run-capabilities.test.ts src/main/orchestrator/tool-registry.test.ts src/main/skills/skill-registry.test.ts`

```powershell
git add src/main/orchestrator/run-capabilities.ts src/main/orchestrator/run-capabilities.test.ts
git commit -m "feat: resolve per run capability snapshots"
```

---

### Task 4: Make Build Options the Single Capability and Prompt Assembly Entry

**Files:**
- Modify: `src/main/orchestrator/build-options.ts`
- Modify: `src/main/orchestrator/build-options.test.ts`
- Modify: `src/main/orchestrator/agent-runtime.ts`
- Modify: `src/main/orchestrator/cyrene-agent.ts`

**Interfaces:**
- `CyreneRunOptions.capabilities: RunCapabilities` becomes required for bridge-created runs.
- `options.tools` must always equal `capabilities.tools`, including Work / Learn / Code.
- `availableSkills` must be derived only from `capabilities.skills`.

- [ ] **Step 1: Add failing build-options tests**

```ts
it.each(["work", "learn", "code"] as const)("passes filtered tools for %s", async (mode) => {
  const deps = createBuildDeps();
  const expected = [`${mode}-tool`];
  deps.toolRegistry.getEnabledToolsForMode = () => [{ id: expected[0], enabled: true }];
  const result = await buildAgentRunOptions({
    sessionId: `${mode}-session`,
    mode,
    executionMode: mode === "chat" ? "chat" : "work",
    messages: [{ role: "user", content: "执行任务" }],
  }, deps);
  expect(result.options.tools?.map((tool) => tool.id)).toEqual(expected);
  expect(result.options.capabilities.toolIds).toEqual(new Set(expected));
});

it("does not construct tool content for chat", async () => {
  const deps = createBuildDeps();
  deps.buildToolSystemPrompt = vi.fn(() => "unexpected");
  const result = await buildAgentRunOptions(input("chat"), deps);
  expect(deps.buildToolSystemPrompt).not.toHaveBeenCalled();
  expect(result.options.toolSystemContent).toBe("");
});
```

- [ ] **Step 2: Run and verify RED**

Run: `npx vitest run src/main/orchestrator/build-options.test.ts`

Expected: the Work / Learn / Code tool propagation assertion fails because current code only assigns `options.tools` for Chat.

- [ ] **Step 3: Assemble from `RunCapabilities`**

Replace independent tool/Skill filtering with:

```ts
const capabilities = deps.resolveRunCapabilities({
  mode: resolvedMode,
  toolModeOverrides: styleSettings.toolModeOverrides,
  skillModeOverrides: styleSettings.skillModeOverrides,
  activeSearchBackend,
});

const baseModePrompt = deps.buildModePrompt(resolvedMode);
const toolSystemContent = resolvedMode === "chat"
  ? ""
  : [
      deps.buildToolSystemPrompt(resolvedMode, capabilities.tools),
      deps.buildSkillCatalog(capabilities.skills),
      deps.buildAutoInjectedSkillContext(capabilities.skills),
      citaContextBlock,
      resolvedWorkspaceRoot
        ? `[当前项目工作区]\n可信根目录：${resolvedWorkspaceRoot}`
        : "",
    ].filter(Boolean).join("\n\n---\n\n");
```

Always return:

```ts
tools: [...capabilities.tools],
capabilities,
```

- [ ] **Step 4: Remove dead `systemContent`**

Delete the legacy local `systemContent` string and update comments so `soulSystemBaseContent` means “mode response context”, not necessarily `soul.md`.

- [ ] **Step 5: Make scheduled tasks explicit Work runs**

Replace `buildSystemPrompt("01_default.md")` in scheduler setup with `buildModePrompt("work")`, and resolve Work tools/Skills through the same capability resolver.

- [ ] **Step 6: Run and commit**

Run: `npx vitest run src/main/orchestrator/build-options.test.ts src/main/orchestrator/cyrene-agent.test.ts src/main/orchestrator/cyrene-agent-runtime.test.ts`

```powershell
git add src/main/orchestrator/build-options.ts src/main/orchestrator/build-options.test.ts src/main/orchestrator/agent-runtime.ts src/main/orchestrator/cyrene-agent.ts
git commit -m "refactor: assemble runs from explicit capabilities"
```

---

### Task 5: Enforce the Tool Snapshot in Harness and Dispatcher

**Files:**
- Modify: `src/main/orchestrator/harness-adapter.ts`
- Modify: `src/main/orchestrator/harness-adapter.test.ts`
- Modify: `src/main/orchestrator/harness-adapter-git-tools.test.ts`
- Modify: `src/main/orchestrator/harness/tool-dispatcher.test.ts`

**Interfaces:**
- Harness consumes only `options.capabilities.tools`.
- No production path may fall back to `toolRegistry.getEnabledTools()` after a Run starts.
- Produces: `resolveHarnessTools(options: CyreneRunOptions): ToolDefinition[]` as a small pure boundary used by the adapter.

- [ ] **Step 1: Write failing execution-boundary tests**

```ts
it("does not expose a globally enabled tool absent from the run snapshot", () => {
  const allowedTool = tool("allowed");
  const options = {
    conversationMode: "work",
    mode: "work",
    capabilities: {
      mode: "work",
      tools: [allowedTool],
      toolIds: new Set([allowedTool.id]),
      skills: [],
      skillIds: new Set(),
    },
  } as unknown as CyreneRunOptions;
  expect(resolveHarnessTools(options).map((item) => item.id)).toEqual(["allowed"]);
});
```

Add a dispatcher test proving a fabricated call outside `toolIds` returns `E_TOOL_UNAVAILABLE`.

- [ ] **Step 2: Run and verify RED**

Run: `npx vitest run src/main/orchestrator/harness-adapter.test.ts src/main/orchestrator/harness/tool-dispatcher.test.ts`

- [ ] **Step 3: Remove global fallbacks and Git ID filtering**

Use:

```ts
export function resolveHarnessTools(options: CyreneRunOptions): ToolDefinition[] {
  return [...options.capabilities.tools];
}

const tools = resolveHarnessTools(options);
```

Delete `CODE_ONLY_GIT_TOOL_IDS` and `filterToolsForConversationMode`. Mode visibility is now declarative and already frozen in the snapshot.

- [ ] **Step 4: Pass `toolIds` into the dispatch boundary**

The dispatch path must reject any tool name not present in the current Run set before registry lookup or execution.

- [ ] **Step 5: Run and commit**

Run: `npx vitest run src/main/orchestrator/harness-adapter.test.ts src/main/orchestrator/harness/tool-dispatcher.test.ts src/main/orchestrator/harness/builtin-tools.test.ts`

```powershell
git add src/main/orchestrator/harness-adapter.ts src/main/orchestrator/harness-adapter.test.ts src/main/orchestrator/harness-adapter-git-tools.test.ts src/main/orchestrator/harness/tool-dispatcher.test.ts
git commit -m "fix: enforce run tool capability boundary"
```

---

### Task 6: Enforce Skill Mode Overrides at Execution Time

**Files:**
- Modify: `src/main/orchestrator/tool-context.ts`
- Modify: `src/main/skills/skill-tools.ts`
- Create or Modify: `src/main/skills/skill-tools.test.ts`
- Modify: all Harness `ToolContext` construction sites found by `rg -n 'const toolContext|ToolContext =|mode: options.conversationMode' src/main/orchestrator`

**Interfaces:**
- `ToolContext.allowedSkillIds?: ReadonlySet<string>`.
- `invoke_skill` and `read_skill_reference` require the requested Skill ID to exist in that set.
- `registerSkillTools(registry = toolRegistry)` accepts an injectable registry so tests can capture the two definitions without mutating the singleton.

- [ ] **Step 1: Write failing Skill authorization tests**

```ts
it("rejects an enabled skill excluded from the current run", async () => {
  const registered: ToolDefinition[] = [];
  registerSkillTools({ register: (tool) => registered.push(tool) } as ToolRegistry);
  const invokeSkill = registered.find((tool) => tool.id === "invoke_skill")!;
  const output = await invokeSkill.execute(
    { skill_id: "code-only" },
    { allowedSkillIds: new Set(["work-only"]) } as ToolContext,
  );
  expect(output).toContain("E_SKILL_UNAVAILABLE_IN_MODE");
});

it("allows a skill included in the current run", async () => {
  const registered: ToolDefinition[] = [];
  registerSkillTools({ register: (tool) => registered.push(tool) } as ToolRegistry);
  const invokeSkill = registered.find((tool) => tool.id === "invoke_skill")!;
  const output = await invokeSkill.execute(
    { skill_id: "work-only" },
    { allowedSkillIds: new Set(["work-only"]) } as ToolContext,
  );
  expect(output).toContain("[已加载 skill: work-only]");
});
```

- [ ] **Step 2: Run and verify RED**

Run: `npx vitest run src/main/skills/skill-tools.test.ts`

- [ ] **Step 3: Mark both Skill tools `needsContext: true` and enforce the allowlist**

```ts
if (!ctx?.allowedSkillIds?.has(id)) {
  return `[invoke_skill] E_SKILL_UNAVAILABLE_IN_MODE: ${id}`;
}
```

Apply the same check before reading a reference. Error text must not reveal globally installed but unavailable Skill IDs.

- [ ] **Step 4: Populate the context from `options.capabilities.skillIds`**

All parent Harness calls must use the frozen set. Do not recompute from `skillRegistry` during execution.

- [ ] **Step 5: Run and commit**

Run: `npx vitest run src/main/skills/skill-tools.test.ts src/main/skills/skill-registry.test.ts src/main/orchestrator/harness/tool-dispatcher.test.ts`

```powershell
git add src/main/orchestrator/tool-context.ts src/main/skills/skill-tools.ts src/main/skills/skill-tools.test.ts src/main/orchestrator/cyrene-agent.ts src/main/orchestrator/harness-adapter.ts
git commit -m "fix: enforce per run skill allowlists"
```

---

### Task 7: Make Task Children Inherit and Narrow Parent Capabilities

**Files:**
- Modify: `src/main/orchestrator/task-runtime.ts`
- Modify: `src/main/orchestrator/task-runtime.test.ts`
- Modify: `src/main/orchestrator/harness-adapter.ts`
- Modify: `src/main/orchestrator/tool-context.ts`

**Interfaces:**
- `TaskParentContext.capabilities: RunCapabilities`.
- Child Harness tools and Skill IDs must be intersections with the parent snapshot.

- [ ] **Step 1: Write failing inheritance tests**

```ts
it("never grants a child a tool absent from its parent", async () => {
  const store = createStore();
  const readFile = tool("read_file");
  const runHarness = vi.fn(async () => ({
    finalAnswer: "完成",
    finalState: { todoItems: [], uncertainEffects: [] },
    terminated: false,
    rounds: 1,
    terminal: { status: "success" as const, externalEffectsMayContinue: false },
  }));
  const executor = createTaskExecutor({
    parent: {
      ...parent,
      tools: [readFile],
      capabilities: {
        mode: "code",
        tools: [readFile],
        toolIds: new Set(["read_file"]),
        skills: [],
        skillIds: new Set(["docx"]),
      },
    },
    store,
    runHarness,
  });
  await executor({ description: "检查", prompt: "检查文件", subagentType: "general" });
  const childInput = runHarness.mock.calls[0][0];
  expect(childInput.tools.map((item: ToolDefinition) => item.id)).toEqual(["read_file"]);
  expect(childInput.toolContext.allowedSkillIds).toEqual(new Set(["docx"]));
});
```

- [ ] **Step 2: Run and verify RED**

Run: `npx vitest run src/main/orchestrator/task-runtime.test.ts`

- [ ] **Step 3: Inherit the parent snapshot**

Task profiles continue to narrow tools through the existing `resolveTaskTools`; Skills inherit the already-filtered parent set exactly:

```ts
const childTools = resolveTaskTools(profile, [...parent.capabilities.tools]);
const childSkillIds = new Set(parent.capabilities.skillIds);
```

The existing `allowedToolIds` profile field may narrow tools. This change does not introduce a second Skill profile system; child Skills inherit the parent set and must never call global registries to expand it.

- [ ] **Step 4: Run and commit**

Run: `npx vitest run src/main/orchestrator/task-runtime.test.ts src/main/orchestrator/harness-adapter.test.ts`

```powershell
git add src/main/orchestrator/task-runtime.ts src/main/orchestrator/task-runtime.test.ts src/main/orchestrator/harness-adapter.ts src/main/orchestrator/tool-context.ts
git commit -m "fix: inherit task capabilities from parent runs"
```

---

### Task 8: Remove Duplicate Dynamic Context and Verify First-Round Prompt

**Files:**
- Modify: `src/main/orchestrator/harness-adapter.ts`
- Modify: `src/main/orchestrator/harness-adapter.test.ts`
- Modify: `src/main/orchestrator/build-options.test.ts`
- Modify: `src/main/orchestrator/harness/cyrene-harness.test.ts`

**Interfaces:**
- `soulSystemBaseContent` carries mode response context once.
- `toolSystemContent` carries tool/Skill/workspace/CITA context once.
- Adapter only joins the two, adds `cyrene_harness.md`, Todo policy, recovery and response context where applicable.

- [ ] **Step 1: Add exact occurrence-count tests**

```ts
const occurrences = (text: string, marker: string) => text.split(marker).length - 1;

expect(occurrences(prompt, "[ENV_MARKER]")).toBe(1);
expect(occurrences(prompt, "[CITA_CONTEXT]")).toBe(1);
expect(occurrences(prompt, "[当前项目工作区]")).toBe(1);
expect(occurrences(prompt, "# Cyrene Harness 身份核心")).toBe(1);
expect(occurrences(prompt, "# 昔涟 · Soul")).toBe(0);
```

Run the matrix for Work, Learn and Code. Add a Harness first-round capture test that inspects `chatRequest.messages[0].content`, not only intermediate options.

- [ ] **Step 2: Run and verify RED**

Run: `npx vitest run src/main/orchestrator/harness-adapter.test.ts src/main/orchestrator/harness/cyrene-harness.test.ts`

Expected: environment and CITA currently appear more than once; working modes currently include `soul.md`.

- [ ] **Step 3: Remove adapter duplication**

Delete the second `[RUNTIME_ENV]` append and the second CITA append. Preserve `recoveryContext` and `responseContext`, which are not already present in the base strings.

- [ ] **Step 4: Ensure `cyrene_harness.md` is added only for Harness modes**

Chat must never call `buildHarnessSystemPrompt`. Work / Learn / Code must add the compact persona exactly once.

- [ ] **Step 5: Run and commit**

Run: `npx vitest run src/main/orchestrator/build-options.test.ts src/main/orchestrator/harness-adapter.test.ts src/main/orchestrator/harness/cyrene-harness.test.ts`

```powershell
git add src/main/orchestrator/harness-adapter.ts src/main/orchestrator/harness-adapter.test.ts src/main/orchestrator/build-options.test.ts src/main/orchestrator/harness/cyrene-harness.test.ts
git commit -m "fix: deduplicate harness prompt context"
```

---

### Task 9: End-to-End Regression and Cleanup

**Files:**
- Modify: tests only if an assertion describes the retired mixed-mode behavior.
- Review: `src/main/orchestrator/system-prompt-builder.ts`
- Review: `src/main/orchestrator/build-options.ts`
- Review: `src/main/orchestrator/cyrene-agent.ts`
- Review: `src/main/orchestrator/harness-adapter.ts`

**Interfaces:**
- No new production interface; this task verifies the frozen boundaries.

- [ ] **Step 1: Search for retired production paths**

Run:

```powershell
rg -n 'buildSystemPrompt\(|buildSoulSystemBasePrompt\(|CODE_ONLY_GIT_TOOL_IDS|filterToolsForConversationMode|getEnabledTools\(\)' src/main/orchestrator src/main/skills
```

Expected:

- No bridge-created Run calls the filename-guessing builders.
- No active Run falls back to global tools.
- No adapter hard-codes Git IDs.
- Registry-level `getEnabledTools()` may remain for setup/diagnostics, but not after capability resolution.

- [ ] **Step 2: Run the focused regression suite**

```powershell
npx vitest run src/main/orchestrator/mode-prompt-profile.test.ts src/main/orchestrator/run-capabilities.test.ts src/main/orchestrator/build-options.test.ts src/main/orchestrator/harness-adapter.test.ts src/main/orchestrator/harness/cyrene-harness.test.ts src/main/orchestrator/harness/tool-dispatcher.test.ts src/main/skills/skill-registry.test.ts src/main/skills/skill-tools.test.ts src/main/orchestrator/task-runtime.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 3: Run all builds**

```powershell
npm run build:main
npm run build:preload
npm run build:renderer
```

Expected: all exit 0.

- [ ] **Step 4: Run the full test suite**

Run: `npx vitest run`

Expected: no new failure relative to the recorded baseline. Any pre-existing failure must be listed by exact test name and reproduced unchanged before the refactor is considered complete.

- [ ] **Step 5: Inspect the final diff**

```powershell
git diff --check
git status --short
git log --oneline -12
```

Confirm that `src/main/orchestrator/harness/cyrene-harness.ts` or other user-owned dirty files were not staged unless a task explicitly required their tested change.

- [ ] **Step 6: Commit test-only cleanup if needed**

If Task 9 only confirms existing assertions, make no commit. If it changes one of the focused test files listed in Step 2, stage each changed test by its exact path as printed by `git status --short`, verify with `git diff --cached --name-only`, then commit with `git commit -m "test: verify four mode capability isolation"`.

---

## Final Acceptance Matrix

| Check | Chat | Work | Learn | Code |
|---|---:|---:|---:|---:|
| `soul.md` present | Yes | No | No | No |
| `canon_quotes.md` present | Yes | Yes | Yes | Yes |
| `cyrene_harness.md` present | No | Yes | Yes | Yes |
| Own system/identity only | Yes | Yes | Yes | Yes |
| Tool Schema uses mode overrides | Empty | Yes | Yes | Yes |
| Skill execution uses mode overrides | Empty | Yes | Yes | Yes |
| Task may expand parent capabilities | N/A | No | No | No |
| Environment/CITA duplicated | No | No | No | No |

The implementation is complete only when this matrix is covered by automated tests against the final request sent to the model or the final Harness input, not merely against helper return values.
