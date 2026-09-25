import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { describe, expect, it, vi } from "vitest"
import {
  buildAgentRunOptions,
  buildChannelSystem,
  onAgentRunFinished,
  type BuildOptionsDeps,
  type OnRunFinishedDeps,
} from "./build-options"
import type { SocialAtom } from "../social-context/types"
import type { ConversationMode } from "../../shared/chat-types"
import { buildHarnessPromptLayers } from "./harness/adapter/prompt-builder"
import { composePromptLayers } from "./prompt-layers"
import { getAdapterForConfig } from "./vendors"

function createBuildDeps(): BuildOptionsDeps {
  return {
    loadModelSettings: () => ({ provider: "test", baseUrl: "https://example.test", model: "m", apiKey: "k" }),
    loadGeneralSettings: () => ({
      currentStyleId: "default",
      customStyle: { diversity: { driver: "model-default" }, repetition: "model-default" },
      chatSocialContextEnabled: false,
    }),
    loadUserProfile: () => ({}),
    buildEnvironmentContext: () => "ENV",
    buildSkillCatalog: () => "",
    buildAutoInjectedSkillContext: () => "",
    skillRegistry: {
      getEnabled: () => [],
      // 三模适配层：测试 mock skill 都不声明 modes，等价于全模式通用。
      getEnabledForMode(this: { getEnabled(): ReadonlyArray<unknown> }, _mode: import("../skills/types").SkillMode) {
        return this.getEnabled()
      },
      getBody: () => null,
    },
    resolveSlashActivation: () => "",
    buildToneInjection: async () => "",
    sceneEmbeddingIndex: null,
    getSceneEmbeddingProvider: () => null,
    buildAlwaysOnContext: async () => "ALWAYS",
    buildRelationshipContext: async () => "RELATIONSHIP",
    buildSystemPrompt: () => "BASE_SYSTEM",
    buildToolSystemPrompt: () => "TOOL_SYSTEM",
    buildSoulSystemBasePrompt: () => "SOUL_SYSTEM_BASE",
    readStylePrompt: (styleId) => `STYLE_PROMPT:${styleId}`,
    resolveSoulSampling: () => ({}),
    toolRegistry: {
      getEnabled: () => [],
      // 三模适配层：测试 mock 工具都不声明 modes，等价于全模式通用，
      // 因此 getEnabledToolsForMode 直接转发到 getEnabled，单测覆写 getEnabled 即可生效。
      getEnabledToolsForMode(this: { getEnabled(): ReadonlyArray<unknown> }, _mode: ConversationMode) {
        return this.getEnabled()
      },
    },
    normalizeChatMessages: (raw) => raw as never,
    chatRequestTimeoutMs: 1000,
  }
}

describe("build-options", () => {
  it.each([
    { multimodal: true, expectedAskTool: false },
    { multimodal: false, expectedAskTool: true },
  ])("exposes ask_attached_image only on the caption route: $multimodal", async ({ multimodal, expectedAskTool }) => {
    const deps = createBuildDeps();
    const tools = [
      { id: "ask_attached_image", name: "追问图片", description: "视觉追问", enabled: true, modes: ["chat"] },
      { id: "demo_tool", name: "示例", description: "示例工具", enabled: true, modes: ["chat"] },
    ] as never[];
    deps.loadModelSettings = () => ({
      provider: "test",
      baseUrl: "https://example.test",
      model: "m",
      apiKey: "k",
      multimodal,
    });
    deps.toolRegistry.getEnabled = () => tools;
    deps.buildToolSystemPrompt = (_mode, enabled) => (enabled as Array<{ id: string }>).map((tool) => tool.id).join(",");

    const { options } = await buildAgentRunOptions({
      sessionId: `image-tool-${multimodal}`,
      mode: "chat",
      executionMode: "chat",
      messages: [{ role: "user", content: "看图" }],
    }, deps);

    expect(options.tools?.some((tool) => tool.id === "ask_attached_image")).toBe(expectedAskTool);
    expect(options.capabilities?.toolIds.has("ask_attached_image")).toBe(expectedAskTool);
    expect(options.toolSystemContent.includes("ask_attached_image")).toBe(expectedAskTool);
    expect(options.tools?.some((tool) => tool.id === "demo_tool")).toBe(true);
  });

  it.each(["chat", "work", "learn", "code"] as const)("uses the explicit %s mode prompt", async (mode) => {
    const deps = createBuildDeps();
    deps.buildModePrompt = (target) => `[MODE:${target}]`;
    const result = await buildAgentRunOptions({
      sessionId: `${mode}-session`,
      mode,
      executionMode: mode === "chat" ? "chat" : "work",
      messages: [{ role: "user", content: "你好" }],
    }, deps);
    expect(result.options.soulSystemBaseContent).toContain(`[MODE:${mode}]`);
  });

  it("把插件贡献放入每轮 runtime context，并传递可信运行元数据", async () => {
    const deps = createBuildDeps();
    deps.buildPluginPromptContext = vi.fn(async (input) => (
      `[插件上下文：demo]\n${input.mode}:${input.userText}`
    ));

    const result = await buildAgentRunOptions({
      sessionId: "plugin-prompt-session",
      mode: "chat",
      executionMode: "chat",
      channel: "wechat",
      messages: [{ role: "user", content: "今天天气如何" }],
    }, deps);

    expect(deps.buildPluginPromptContext).toHaveBeenCalledWith({
      source: "conversation",
      mode: "chat",
      userText: "今天天气如何",
      conversationId: "plugin-prompt-session",
      channel: "wechat",
      runId: undefined,
      chatBackend: "native",
      timezone: expect.any(String),
    });
    expect(result.options.soulRuntimeContext).toContain("[插件上下文：demo]\nchat:今天天气如何");
    expect(result.options.soulSystemBaseContent).not.toContain("插件上下文：demo");
    expect(result.options.toolSystemContent).not.toContain("插件上下文：demo");
  });

  it("无头插件任务把显式 promptSource 传给插件提示词 Provider", async () => {
    const deps = createBuildDeps();
    deps.buildPluginPromptContext = vi.fn(async (input) => `[${input.source}] ${input.channel}`);

    const result = await buildAgentRunOptions({
      sessionId: "plugin:minecraft-bot",
      mode: "work",
      executionMode: "work",
      promptSource: "plugin-agent",
      promptChannel: "minecraft",
      messages: [{ role: "user", content: "收集木头" }],
    } as never, deps);

    expect(deps.buildPluginPromptContext).toHaveBeenCalledWith({
      source: "plugin-agent",
      mode: "work",
      userText: "收集木头",
      conversationId: "plugin:minecraft-bot",
      channel: "minecraft",
    });
    expect(result.options.soulRuntimeContext).toContain("[plugin-agent] minecraft");
  });

  it("桌面 Chat 将插件资料放在原生背景前，但稳定前缀不变", async () => {
    const deps = createBuildDeps();
    deps.loadGeneralSettings = () => ({
      currentStyleId: "default",
      customStyle: { diversity: { driver: "model-default" }, repetition: "model-default" },
      chatSocialContextEnabled: true,
    });
    deps.buildChatSocialContext = async () => ({ contextBlock: "SOCIAL", retrievedAtoms: [] });
    deps.buildPluginPromptContext = async ({ referenceContext }) => ["PLUGIN_MEMORY", referenceContext].filter(Boolean).join("\n\n");
    const input = {
      sessionId: "chat-order", mode: "chat" as const, executionMode: "chat" as const,
      userTurnId: "u1", assistantTurnId: "a1", messages: [{ role: "user", content: "你好" }],
    };
    const desktop = (await buildAgentRunOptions(input, deps)).options;
    const channel = (await buildAgentRunOptions({ ...input, channel: "wechat" }, deps)).options;
    expect(desktop.soulRuntimeContext.indexOf("PLUGIN_MEMORY")).toBeLessThan(desktop.soulRuntimeContext.indexOf("SOCIAL"));
    expect(desktop.soulRuntimeContext.indexOf("SOCIAL")).toBeLessThan(desktop.soulRuntimeContext.indexOf("ALWAYS"));
    expect(channel.soulRuntimeContext.indexOf("SOCIAL")).toBeLessThan(channel.soulRuntimeContext.indexOf("PLUGIN_MEMORY"));
    expect(desktop.soulSystemBaseContent).not.toContain("PLUGIN_MEMORY");
    expect(channel.soulSystemBaseContent).not.toContain("PLUGIN_MEMORY");
  });

  it("陪伴后端旁路原生画像和 WorldBook，只保留插件上下文和其他工具", async () => {
    const deps = createBuildDeps();
    const always = vi.fn(async (_text, _messages, includeNativeChatContext?: boolean) => includeNativeChatContext ? "原生画像和世界书" : "");
    const relationship = vi.fn(async () => "原生关系上下文");
    deps.buildAlwaysOnContext = always;
    deps.buildRelationshipContext = relationship;
    deps.buildReferenceInjection = vi.fn(async () => "HOST_REFERENCES");
    deps.buildPluginPromptContext = async ({ referenceContext }) => ["PLUGIN_MEMORY", referenceContext].filter(Boolean).join("\n\n");
    deps.loadGeneralSettings = () => ({
      currentStyleId: "default",
      customStyle: { diversity: { driver: "model-default" }, repetition: "model-default" },
      chatBackend: "companion",
      companionToolReasoning: { mode: "on", effort: "low" },
      chatToolsEnabled: true,
      toolModeOverrides: { user_memory: { chat: true }, weather: { chat: true } },
    });
    deps.toolRegistry.getEnabled = () => [
      { id: "user_memory", name: "原生记忆", enabled: true },
      { id: "weather", name: "天气", enabled: true },
    ] as never;
    const result = await buildAgentRunOptions({
      sessionId: "plugin-memory", mode: "chat", executionMode: "chat",
      messages: [{ role: "user", content: "你好" }],
    }, deps);
    expect(always).not.toHaveBeenCalled();
    expect(result.options.soulSystemBaseContent).not.toContain("原生画像和世界书");
    expect(result.options.soulSystemBaseContent).not.toContain("原生关系上下文");
    expect(relationship).not.toHaveBeenCalled();
    expect(result.options.soulSystemBaseContent).toContain("PLUGIN_MEMORY");
    expect(result.options.soulSystemBaseContent).toContain("HOST_REFERENCES");
    expect(result.options.soulRuntimeContext).toBe("");
    expect(deps.buildReferenceInjection).toHaveBeenCalledWith("你好");
    expect(result.options.toolReasoning).toEqual({ mode: "on", effort: "low" });
    expect(result.options.tools?.map((tool) => tool.id)).toEqual(["weather"]);
    await buildAgentRunOptions({
      sessionId: "channel", mode: "chat", executionMode: "chat", channel: "wechat",
      messages: [{ role: "user", content: "你好" }],
    }, deps);
    expect(always).toHaveBeenLastCalledWith("你好", expect.any(Array), true);
    expect(relationship).toHaveBeenCalledTimes(1);
  });

  it("陪伴后端用插件稳定人格替换 Chat 人格，空结果与渠道均回退原生", async () => {
    const deps = createBuildDeps();
    deps.loadGeneralSettings = () => ({
      currentStyleId: "default",
      customStyle: { diversity: { driver: "model-default" }, repetition: "model-default" },
      chatBackend: "companion",
    });
    deps.buildPluginStablePrompt = vi.fn(async ({ target }) => ({
      soul: "COMPANION_PERSONA",
      tool: "COMPANION_TOOL_RULES",
      tone: "COMPANION_TONE",
      "soul-tail": "COMPANION_TAIL",
    })[target] ?? "");
    deps.buildPluginPromptContext = vi.fn(async () => "");
    deps.buildEnvironmentContext = () => [
      "## 运行环境（机器实际状态，不要再凭印象猜）",
      "- 当前时间：2026-09-20 周日 23:15（时区 Asia/Shanghai）",
      "- 操作系统：Windows",
    ].join("\n");
    const input = {
      sessionId: "stable-profile", mode: "chat" as const, executionMode: "chat" as const,
      messages: [
        { role: "user", content: "你好", at: Date.UTC(2026, 8, 20, 14, 0) },
        { role: "assistant", content: "晚上好", at: Date.UTC(2026, 8, 20, 14, 1) },
      ],
    };

    const desktop = (await buildAgentRunOptions(input, deps)).options;
    const channel = (await buildAgentRunOptions({ ...input, channel: "wechat" }, deps)).options;
    expect(desktop.soulSystemBaseContent).toContain("COMPANION_PERSONA");
    expect(desktop.soulSystemBaseContent).not.toContain("SOUL_SYSTEM_BASE");
    expect(desktop.toolSystemContent).toContain("COMPANION_TOOL_RULES");
    expect(desktop.toolSystemContent).not.toContain("COMPANION_PERSONA");
    expect(desktop.soulSystemBaseContent).toContain("COMPANION_TONE");
    expect(desktop.soulSystemBaseContent).toContain("[时间戳使用规则]");
    expect(desktop.soulSystemBaseContent).toContain("- 今天日期：2026-09-20 周日（时区 Asia/Shanghai；精确的当前时间以对话消息的时间戳为准）");
    expect(desktop.soulSystemBaseContent.indexOf("## 运行环境")).toBeLessThan(desktop.soulSystemBaseContent.indexOf("COMPANION_PERSONA"));
    expect(desktop.soulSystemBaseContent.indexOf("COMPANION_PERSONA")).toBeLessThan(desktop.soulSystemBaseContent.indexOf("COMPANION_TONE"));
    expect(desktop.soulSystemBaseContent).toContain("当前回复阶段工具调用环节已经结束");
    expect(desktop.soulRuntimeContext).toBe("");
    expect(desktop.messages[0].content).toContain("[2026-09-20 22:00, Asia/Shanghai]\n你好");
    expect(desktop.messages[1].content).toContain("[2026-09-20 22:01, Asia/Shanghai]\n晚上好");
    expect(desktop.soulTailAnchorContent).toContain("[当前时间]");
    expect(desktop.soulTailAnchorContent).toContain("COMPANION_TAIL");
    expect(channel.soulSystemBaseContent).toContain("SOUL_SYSTEM_BASE");
    expect(deps.buildPluginPromptContext).toHaveBeenNthCalledWith(1, expect.objectContaining({
      source: "conversation", mode: "chat", chatBackend: "companion",
    }));
    expect(deps.buildPluginPromptContext).toHaveBeenNthCalledWith(3, expect.objectContaining({
      source: "conversation", mode: "chat", channel: "wechat", chatBackend: "native",
    }));

    deps.buildPluginStablePrompt = async () => "";
    const fallback = (await buildAgentRunOptions(input, deps)).options;
    expect(fallback.soulSystemBaseContent).toContain("SOUL_SYSTEM_BASE");
    expect(fallback.soulTailAnchorContent).toContain("[当前时间]");
  });

  it("陪伴后端把主程序风格 ID 交给插件，内建风格不再重复注入上游文本", async () => {
    const deps = createBuildDeps();
    deps.loadGeneralSettings = () => ({
      currentStyleId: "sweet",
      customStyle: { diversity: { driver: "model-default" }, repetition: "model-default" },
      chatBackend: "companion",
    });
    deps.readStylePrompt = vi.fn(() => "UPSTREAM_STYLE_MUST_NOT_APPEAR");
    deps.buildPluginStablePrompt = vi.fn(async ({ target, styleId }) => (
      target === "soul" ? `LOCAL_PERSONA:${styleId}` : ""
    ));

    const result = await buildAgentRunOptions({
      sessionId: "companion-local-style", mode: "chat", executionMode: "chat",
      messages: [{ role: "user", content: "你好" }],
    }, deps);

    expect(deps.buildPluginStablePrompt).toHaveBeenCalledWith(expect.objectContaining({
      target: "soul", styleId: "sweet",
    }));
    expect(deps.readStylePrompt).not.toHaveBeenCalled();
    expect(result.options.soulSystemBaseContent).toContain("LOCAL_PERSONA:sweet");
    expect(result.options.soulRuntimeContext).not.toContain("UPSTREAM_STYLE_MUST_NOT_APPEAR");
  });

  it("陪伴后端 custom 只注入主程序自定义风格，插件稳定人格不附带内建风格", async () => {
    const deps = createBuildDeps();
    deps.loadGeneralSettings = () => ({
      currentStyleId: "custom",
      customStyle: { diversity: { driver: "model-default" }, repetition: "model-default" },
      chatBackend: "companion",
    });
    deps.readStylePrompt = vi.fn(() => "HOST_CUSTOM_STYLE");
    deps.buildPluginStablePrompt = vi.fn(async ({ target, styleId }) => (
      target === "soul" ? `LOCAL_PERSONA_BASE_ONLY:${styleId}` : ""
    ));

    const result = await buildAgentRunOptions({
      sessionId: "companion-custom-style", mode: "chat", executionMode: "chat",
      messages: [{ role: "user", content: "你好" }],
    }, deps);

    expect(deps.buildPluginStablePrompt).toHaveBeenCalledWith(expect.objectContaining({
      target: "soul", styleId: "custom",
    }));
    expect(deps.readStylePrompt).toHaveBeenCalledWith("custom");
    expect(result.options.soulSystemBaseContent).toContain("LOCAL_PERSONA_BASE_ONLY:custom");
    expect(result.options.soulSystemBaseContent).toContain("HOST_CUSTOM_STYLE");
    expect(result.options.soulSystemBaseContent.indexOf("LOCAL_PERSONA_BASE_ONLY:custom"))
      .toBeLessThan(result.options.soulSystemBaseContent.indexOf("HOST_CUSTOM_STYLE"));
  });

  it("陪伴后端把插件语气交给原生场景匹配器，并单独保留最终 Soul 锚点", async () => {
    const deps = createBuildDeps();
    deps.loadGeneralSettings = () => ({
      currentStyleId: "default",
      customStyle: { diversity: { driver: "model-default" }, repetition: "model-default" },
      chatBackend: "companion",
    });
    deps.sceneEmbeddingIndex = {};
    deps.buildToneInjection = vi.fn(async (_text, _messages, _provider, _index, override) => `MATCHED:${override ?? "NATIVE"}`);
    deps.buildPluginStablePrompt = vi.fn(async ({ target }) => ({
      soul: "COMPANION_PERSONA",
      tool: "COMPANION_TOOL",
      tone: "COMPANION_TONE",
      "soul-tail": "COMPANION_TAIL",
    })[target] ?? "");

    const result = await buildAgentRunOptions({
      sessionId: "companion-tone", mode: "chat", executionMode: "chat",
      messages: [{ role: "user", content: "你好" }],
    }, deps);

    expect(deps.buildToneInjection).toHaveBeenCalledWith(
      "你好", expect.any(Array), null, {}, "COMPANION_TONE",
    );
    expect(result.options.soulSystemBaseContent).toContain("MATCHED:COMPANION_TONE");
    expect(result.options.soulTailAnchorContent).toContain("[当前时间]");
    expect(result.options.soulTailAnchorContent).toContain("COMPANION_TAIL");
    expect(result.options.toolSystemContent).not.toContain("COMPANION_TAIL");
  });

  it("陪伴后端按本地 2FC 顺序组装完整 Soul system，且不重复执行原生引用链", async () => {
    const deps = createBuildDeps();
    const always = vi.fn(async () => "DUPLICATE_NATIVE_REFERENCE");
    deps.buildAlwaysOnContext = always;
    deps.buildEnvironmentContext = () => "LOCAL_ENVIRONMENT";
    deps.buildPluginStablePrompt = vi.fn(async ({ target }) => ({
      soul: "LOCAL_PERSONA",
      tool: "LOCAL_TOOL_RULES",
      tone: "LOCAL_TONE_RULES",
      "soul-tail": "LOCAL_TONE_ANCHOR",
    })[target] ?? "");
    deps.buildPluginPromptContext = async ({ referenceContext }) => [
      "LOCAL_LIFE_MEMORY",
      referenceContext,
      "LOCAL_WORLDBOOK_PROFILE_DREAM_RELATIONSHIP_MUSIC",
    ].filter(Boolean).join("\n\n");
    deps.buildReferenceInjection = async () => "LOCAL_DOCUMENT_ENTITY_REFERENCE";
    deps.loadGeneralSettings = () => ({
      currentStyleId: "default",
      customStyle: { diversity: { driver: "model-default" }, repetition: "model-default" },
      chatBackend: "companion",
    });

    const { options } = await buildAgentRunOptions({
      sessionId: "companion-local-soul-order", mode: "chat", executionMode: "chat",
      messages: [{ role: "user", content: "继续", at: Date.UTC(2026, 8, 21, 1, 0) }],
    }, deps);

    const prompt = options.soulSystemBaseContent;
    const ordered = [
      "LOCAL_ENVIRONMENT",
      "当前回复阶段工具调用环节已经结束",
      "[时间戳使用规则]",
      "LOCAL_PERSONA",
      "LOCAL_TONE_RULES",
      "LOCAL_LIFE_MEMORY",
      "LOCAL_DOCUMENT_ENTITY_REFERENCE",
      "LOCAL_WORLDBOOK_PROFILE_DREAM_RELATIONSHIP_MUSIC",
    ].map((marker) => prompt.indexOf(marker));
    expect(ordered.every((index) => index >= 0)).toBe(true);
    expect(ordered).toEqual([...ordered].sort((left, right) => left - right));
    expect(prompt).not.toContain("DUPLICATE_NATIVE_REFERENCE");
    expect(options.soulRuntimeContext).toBe("");
    expect(always).not.toHaveBeenCalled();
  });

  it("带工具的桌面 Chat 把插件记忆作为动态资料送到 Kimi，且不暴露原生记忆工具", async () => {
    const deps = createBuildDeps();
    const config = {
      provider: "Kimi（月之暗面）", baseUrl: "https://api.moonshot.cn/v1",
      model: "kimi-k2.6", apiKey: "synthetic-only", explicitTransport: "openai" as const,
    };
    deps.loadModelSettings = () => config;
    deps.loadGeneralSettings = () => ({
      currentStyleId: "default",
      customStyle: { diversity: { driver: "model-default" }, repetition: "model-default" },
      chatBackend: "companion", chatToolsEnabled: true,
      toolModeOverrides: { user_memory: { chat: true }, weather: { chat: true } },
    });
    deps.buildPluginPromptContext = async () => "[插件记忆] 薄荷需要浇水";
    deps.toolRegistry.getEnabled = () => [
      { id: "user_memory", name: "原生记忆", description: "memory", enabled: true,
        inputSchema: { type: "object", properties: {} } },
      { id: "weather", name: "天气", description: "weather", enabled: true,
        inputSchema: { type: "object", properties: {} } },
    ] as never;
    const { options } = await buildAgentRunOptions({
      sessionId: "tool-memory-projection", mode: "chat", executionMode: "chat",
      chatBackendSnapshot: "companion",
      messages: [{ role: "user", content: "薄荷要浇水吗？" }],
    }, deps);
    expect(options.tools.map((tool) => tool.id)).toEqual(["weather"]);
    expect(options.soulSystemBaseContent).toContain("[插件记忆] 薄荷需要浇水");
    options.conversationMode = "chat";
    const layers = buildHarnessPromptLayers(options);
    expect(layers.stablePrefix).toContain("[插件记忆]");
    expect(layers.runtimeContext).not.toContain("[插件记忆]");
    const composed = composePromptLayers(layers, options.messages);
    const adapter = getAdapterForConfig(config);
    const request = adapter.applyCacheHints?.({
      model: config.model, messages: composed.messages, promptLayers: composed.metadata,
      tools: options.tools.map((tool) => ({ name: tool.id, description: tool.description,
        parameters: tool.inputSchema })), stream: false,
    }, config);
    expect(request).toBeDefined();
    const wire = JSON.parse(adapter.buildRequest(request!, config).body);
    expect(wire.tools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual(["weather"]);
    expect(wire.messages.at(-1).content).not.toContain("[插件记忆]");
    expect(wire.messages[0].content).toContain("[插件记忆]");
    expect(wire.prompt_cache_key).toMatch(/^cyrene:kimi:[a-f0-9]{16}$/);
  });

  it("uses Collab tools for desktop Chat even when the legacy enhancement switch is off", async () => {
    const deps = createBuildDeps();
    deps.toolRegistry.getEnabled = () => [
      { id: "music_search", name: "搜索歌曲", description: "d", enabled: true } as never,
    ];
    const result = await buildAgentRunOptions({
      sessionId: "chat-plain",
      mode: "chat",
      executionMode: "chat",
      messages: [{ role: "user", content: "你好" }],
    }, deps);
    expect(result.options.tools.map((tool) => tool.id)).toEqual(["music_search"]);
    expect(result.options.toolSystemContent).toContain("TOOL_SYSTEM");
    expect(result.options.chatResponseMode).toBe("two-phase");
  });

  it("does not require per-tool opt-in for desktop Collab", async () => {
    const deps = createBuildDeps();
    deps.loadGeneralSettings = () => ({
      currentStyleId: "default",
      customStyle: { diversity: { driver: "model-default" }, repetition: "model-default" },
      chatSocialContextEnabled: false,
      chatToolsEnabled: true,
      // 勾选 music_search；read_file 不勾（验证未声明 modes 的工具不漏进 chat）。
      toolModeOverrides: { music_search: { chat: true }, read_file: { chat: false } },
    });
    deps.toolRegistry.getEnabled = () => [
      { id: "music_search", name: "搜索歌曲", description: "d", enabled: true },
      { id: "read_file", name: "读文件", description: "d", enabled: true },
    ] as never;
    const result = await buildAgentRunOptions({
      sessionId: "chat-tools",
      mode: "chat",
      executionMode: "chat",
      messages: [{ role: "user", content: "放首歌" }],
    }, deps);
    expect((result.options.tools ?? []).map((t: { id: string }) => t.id)).toEqual(["music_search", "read_file"]);
    // 有工具时 chat 也注入工具目录 prompt（进 harness stablePrefix）。
    expect(result.options.toolSystemContent).toContain("TOOL_SYSTEM");
  });
  it("does not include legacy Ask Soul prompt fields", async () => {
    const deps = createBuildDeps()
    deps.loadUserProfile = () => ({
      nickname: "小王",
      callPreference: "伙伴",
      gender: "male",
      birthday: "2000-01-01",
      defaultCity: "淄博",
    })

    const result = await buildAgentRunOptions({
      messages: [{ role: "user", content: "生成一份文档" }],
      style: "01_default.md",
    }, deps)
    const askOptions = result.options as typeof result.options & {
      askSystemContent?: string
      trustedAskUserProfile?: Record<string, unknown>
    }

    expect(askOptions.askSystemContent).toBeUndefined()
    expect(askOptions.trustedAskUserProfile).toBeUndefined()
  })

  it("applies local user location and timezone modes before prompt injection", async () => {
    const deps = createBuildDeps()
    const seenProfiles: Array<Record<string, unknown>> = []
    deps.buildEnvironmentContext = (_model, profile) => {
      seenProfiles.push(profile as Record<string, unknown>)
      return "ENV"
    }
    deps.loadUserProfile = () => ({
      nickname: "小王",
      defaultCity: "杭州",
      weatherLocationMode: "off",
      timezone: "America/New_York",
      timezoneMode: "system",
      gender: "male",
    })

    await buildAgentRunOptions({
      messages: [{ role: "user", content: "你好" }],
      style: "01_default.md",
    }, deps)

    expect(seenProfiles.at(-1)).toMatchObject({
      nickname: "小王",
      defaultCity: "",
      timezone: "",
      gender: "male",
    })
  })

  it("passes manually enabled timezone and fixed-city fallback into the prompt", async () => {
    const deps = createBuildDeps()
    let seenProfile: Record<string, unknown> | undefined
    deps.buildEnvironmentContext = (_model, profile) => {
      seenProfile = profile as Record<string, unknown>
      return "ENV"
    }
    deps.loadUserProfile = () => ({
      defaultCity: "杭州",
      weatherLocationMode: "fixed",
      timezone: "America/New_York",
      timezoneMode: "manual",
    })

    await buildAgentRunOptions({
      messages: [{ role: "user", content: "你好" }],
      style: "01_default.md",
    }, deps)

    expect(seenProfile).toMatchObject({
      defaultCity: "杭州",
      timezone: "America/New_York",
    })
  })

  it("passes the trusted runtime environment to the agent decision stages", async () => {
    const result = await buildAgentRunOptions({
      messages: [{ role: "user", content: "帮我查一下今天的天气" }],
      style: "01_default.md",
    }, createBuildDeps())

    expect((result.options as typeof result.options & {
      runtimeEnvironmentContext?: string
    }).runtimeEnvironmentContext).toBe("ENV")
  })

  it("passes the saved reasoning preference into the Agent Runtime", async () => {
    const deps = createBuildDeps()
    deps.loadModelSettings = () => ({
      provider: "DeepSeek（深度求索）",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-pro",
      apiKey: "k",
      reasoning: { mode: "off" },
    })

    const result = await buildAgentRunOptions({
      messages: [{ role: "user", content: "你好" }],
      style: "01_default.md",
    }, deps)

    expect(result.options.settings.reasoning).toEqual({ mode: "off" })
  })

  it.each(["chat", "work", "code", "learn"] as const)(
    "preserves the saved reasoning preference in %s mode",
    async (executionMode) => {
      const deps = createBuildDeps()
      deps.loadModelSettings = () => ({
        provider: "Qwen（通义千问）",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        model: "qwen3-max",
        apiKey: "k",
        reasoning: { mode: "on" },
      })

      const result = await buildAgentRunOptions({
        messages: [{ role: "user", content: "你好" }],
        style: "01_default.md",
        executionMode,
        mode: executionMode,
      }, deps)

      expect(result.options.settings.reasoning).toEqual({ mode: "on" })
      expect(result.options.executionMode).toBe(executionMode === "chat" ? "chat" : "work")
    },
  )

  it("adds a concise WeChat system when the run comes from WeChat", async () => {
    const result = await buildAgentRunOptions({
      messages: [{ role: "user", content: "你好" }],
      style: "01_default.md",
      channel: "wechat",
    }, createBuildDeps())

    expect(result.options.soulSystemBaseContent).toContain("你正在通过微信回复用户")
    expect(result.options.soulSystemBaseContent).toContain("SOUL_SYSTEM_BASE")
    expect(result.options.soulRuntimeContext).toContain("RELATIONSHIP")
    expect(result.options.toolSystemContent).toBe("TOOL_SYSTEM")
  })

  it("does not add channel system for desktop chat", async () => {
    const result = await buildAgentRunOptions({
      messages: [{ role: "user", content: "你好" }],
      style: "01_default.md",
    }, createBuildDeps())

    expect(result.options.soulSystemBaseContent).not.toContain("你正在通过微信回复用户")
    expect(result.options.soulSystemBaseContent).not.toContain("你正在通过飞书回复用户")
  })

  it("messages 不含 system，由循环层组装 system", async () => {
    const result = await buildAgentRunOptions({
      messages: [{ role: "user", content: "你好" }],
      style: "01_default.md",
    }, createBuildDeps())

    // 原始 messages 不含 system 消息
    expect(result.options.messages.some((m) => m.role === "system")).toBe(false)
  })

  it("adds message timestamps and one gap notice to AG-UI chat context", async () => {
    const deps = createBuildDeps()
    deps.loadUserProfile = () => ({ timezone: "Asia/Taipei" })

    const result = await buildAgentRunOptions({
      messages: [
        { role: "user", content: "今天有点累", at: Date.UTC(2026, 6, 12, 12, 0) },
        { role: "assistant", content: "早点休息", at: Date.UTC(2026, 6, 12, 12, 2) },
        { role: "user", content: "我回来啦", at: Date.UTC(2026, 6, 13, 3, 0) },
      ],
      style: "01_default.md",
    }, deps)

    expect(result.options.messages[0].content).toContain("<internal_context>用户发送这条消息的时间：2026-07-12 20:00")
    expect(result.options.messages[2].content).toContain("<internal_context>用户发送这条消息的时间：2026-07-13 11:00")
    expect(result.options.soulRuntimeContext).toContain("## Internal Context Policy")
    expect(result.options.toolSystemContent).toContain("## Internal Context Policy")
    expect(result.options.soulRuntimeContext).toContain("[对话时间信息]")
    expect(result.options.soulRuntimeContext).toContain("距离上一条有效聊天消息：约 14 小时 58 分钟")
    expect(result.options.soulRuntimeContext?.match(/距离上一条有效聊天消息/g)).toHaveLength(1)
    expect(result.options.toolSystemContent).not.toContain("[对话时间信息]")
  })

  it("toolSystemContent / soulSystemBaseContent 是分开的两套字符串", async () => {
    const result = await buildAgentRunOptions({
      messages: [{ role: "user", content: "你好" }],
      style: "01_default.md",
    }, createBuildDeps())

    expect(result.options.toolSystemContent).toBe("TOOL_SYSTEM")
    expect(result.options.soulSystemBaseContent).not.toBe("TOOL_SYSTEM")
    expect(result.options.soulSystemBaseContent).toContain("SOUL_SYSTEM_BASE")
  })

  it("builds Chat mode without CITA or tools", async () => {
    const deps = createBuildDeps()
    deps.prepareCitaTurn = vi.fn(async () => ({ contextBlock: "unexpected" }))
    deps.toolRegistry.getEnabled = () => [
      { id: "music_search" },
      { id: "weather" },
    ]

    const result = await buildAgentRunOptions({
      messages: [{ role: "user", content: "陪我聊聊" }],
      styleId: "lively",
      executionMode: "chat",
    }, deps)

    expect(deps.prepareCitaTurn).not.toHaveBeenCalled()
    expect(result.options.executionMode).toBe("chat")
    expect(result.options.tools).toEqual([{ id: "music_search" }, { id: "weather" }])
    expect(result.options.chatResponseMode).toBe("two-phase")
    expect(result.options.citaContextBlock).toBe("")
    expect(result.options.soulRuntimeContext).toContain("STYLE_PROMPT:lively")
    expect(result.options.toolSystemContent).not.toContain("STYLE_PROMPT:lively")
  })

  it("injects the trusted session workspace into tool instructions", async () => {
    const deps = createBuildDeps()
    deps.getWorkspaceBinding = (conversationId) => conversationId === "daily-session"
      ? { workspaceRoot: "C:\\projects\\daily", displayName: "daily", boundAt: 1 }
      : undefined

    const result = await buildAgentRunOptions({
      sessionId: "daily-session",
      messages: [{ role: "user", content: "搜索后写一份 Markdown 报告" }],
      style: "01_default.md",
      executionMode: "work",
    }, deps)

    expect(result.options.resolvedWorkspaceRoot).toBe("C:\\projects\\daily")
    expect(result.options.toolSystemContent).toContain("可信根目录：C:\\projects\\daily")
    expect(result.options.toolSystemContent).toContain("不得写入桌面")
  })

  it("does not load a workspace when the main-process caller disables workspace inheritance", async () => {
    const deps = createBuildDeps()
    deps.getWorkspaceBinding = vi.fn(() => ({
      workspaceRoot: "C:\\projects\\desktop",
      displayName: "desktop",
      boundAt: 1,
    }))

    const result = await buildAgentRunOptions({
      sessionId: "conversation-bound",
      workspaceBindingSessionId: null,
      messages: [{ role: "user", content: "继续对话" }],
      style: "01_default.md",
      executionMode: "work",
    }, deps)

    expect(deps.getWorkspaceBinding).not.toHaveBeenCalled()
    expect(result.options.resolvedWorkspaceRoot).toBeUndefined()
    expect(result.options.toolSystemContent).not.toContain("可信根目录")
  })

  it("adds a bounded social background only to enabled Chat runs", async () => {
    const deps = createBuildDeps()
    const retrievedAtom: SocialAtom = {
      id: "atom-1",
      conversationId: "chat-a",
      type: "long_term",
      content: "用户喜欢海边",
      evidenceTurnId: "old-user",
      evidenceQuote: "我喜欢海边",
      createdAt: 1,
      status: "active",
    }
    deps.loadGeneralSettings = () => ({
      currentStyleId: "default",
      customStyle: { diversity: { driver: "model-default" }, repetition: "model-default" },
      chatSocialContextEnabled: true,
    })
    deps.buildChatSocialContext = vi.fn(async () => ({
      contextBlock: "【本轮可用的对话背景】\n- 用户喜欢海边",
      retrievedAtoms: [retrievedAtom],
    }))
    const messages = Array.from({ length: 14 }, (_, index) => ({
      role: index % 2 === 0 ? "assistant" : "user",
      content: `message-${index}`,
      at: index + 1,
    }))

    const result = await buildAgentRunOptions({
      messages,
      executionMode: "chat",
      sessionId: "chat-a",
      userTurnId: "user-14",
      assistantTurnId: "assistant-14",
    }, deps)

    expect(deps.buildChatSocialContext).toHaveBeenCalledWith({
      conversationId: "chat-a",
      query: "message-13",
    })
    expect(result.options.messages).toHaveLength(12)
    expect(result.options.soulRuntimeContext).toContain("用户喜欢海边")
    expect(result.options.socialContext).toMatchObject({
      enabled: true,
      conversationId: "chat-a",
      userTurnId: "user-14",
      assistantTurnId: "assistant-14",
      retrievedAtoms: [retrievedAtom],
    })
  })

  it("omits empty social background and never calls it for Work or disabled Chat", async () => {
    const emptyDeps = createBuildDeps()
    emptyDeps.loadGeneralSettings = () => ({
      currentStyleId: "default",
      customStyle: { diversity: { driver: "model-default" }, repetition: "model-default" },
      chatSocialContextEnabled: true,
    })
    emptyDeps.buildChatSocialContext = vi.fn(async () => ({
      contextBlock: "",
      retrievedAtoms: [],
    }))
    const chat = await buildAgentRunOptions({
      messages: [{ role: "user", content: "你好" }],
      executionMode: "chat",
      sessionId: "chat-a",
      userTurnId: "user-1",
      assistantTurnId: "assistant-1",
    }, emptyDeps)
    expect(chat.options.soulSystemBaseContent).not.toContain("本轮可用的对话背景")

    const workDeps = createBuildDeps()
    workDeps.loadGeneralSettings = emptyDeps.loadGeneralSettings
    workDeps.buildChatSocialContext = vi.fn(async () => ({
      contextBlock: "unexpected",
      retrievedAtoms: [],
    }))
    await buildAgentRunOptions({
      messages: [{ role: "user", content: "你好" }],
      executionMode: "work",
    }, workDeps)
    expect(workDeps.buildChatSocialContext).not.toHaveBeenCalled()

    const disabledDeps = createBuildDeps()
    disabledDeps.buildChatSocialContext = vi.fn(async () => ({
      contextBlock: "unexpected",
      retrievedAtoms: [],
    }))
    await buildAgentRunOptions({
      messages: [{ role: "user", content: "你好" }],
      executionMode: "chat",
    }, disabledDeps)
    expect(disabledDeps.buildChatSocialContext).not.toHaveBeenCalled()
  })

  it("honors an explicit Chat mode for channel runs", async () => {
    const deps = createBuildDeps()
    deps.prepareCitaTurn = vi.fn(async () => ({ contextBlock: "unexpected" }))
    deps.toolRegistry.getEnabled = () => [{ id: "weather" }]
    deps.buildSoulSystemBasePrompt = vi.fn(() => "TALK_SOUL_SYSTEM")

    const result = await buildAgentRunOptions({
      messages: [{ role: "user", content: "今天怎么样" }],
      style: "01_default.md",
      channel: "wechat",
      executionMode: "chat",
    }, deps)

    expect(deps.prepareCitaTurn).not.toHaveBeenCalled()
    expect(deps.buildSoulSystemBasePrompt).toHaveBeenCalledWith("chat")
    expect(result.options.executionMode).toBe("chat")
    expect(result.options.tools).toEqual([])
  })

  it("keeps selected style prompt and sampling independent from execution mode", async () => {
    const deps = createBuildDeps()
    deps.resolveSoulSampling = ({ styleId }) => (
      styleId === "sweet"
        ? { temperature: 0.82, frequencyPenalty: 0.2 }
        : {}
    )

    const chat = await buildAgentRunOptions({
      messages: [{ role: "user", content: "陪我聊聊" }],
      styleId: "sweet",
      executionMode: "chat",
    }, deps)
    const work = await buildAgentRunOptions({
      messages: [{ role: "user", content: "查一下天气" }],
      styleId: "sweet",
      executionMode: "work",
    }, deps)

    // chat 保留 style prompt 与采样；work/code 完全不受 style 影响，走厂商默认
    expect(chat.options.soulRuntimeContext).toContain("STYLE_PROMPT:sweet")
    expect(chat.options.soulSampling).toEqual({ temperature: 0.82, frequencyPenalty: 0.2 })
    expect(work.options.soulRuntimeContext).not.toContain("STYLE_PROMPT:sweet")
    expect(work.options.soulSampling).toBeUndefined()
    expect(chat.options.executionMode).toBe("chat")
    expect(work.options.executionMode).toBe("work")
  })

  it("keeps the default Chat style on the local model-default sampling behavior", async () => {
    const deps = createBuildDeps()
    deps.resolveSoulSampling = vi.fn(() => ({ temperature: 0.65 }))

    const result = await buildAgentRunOptions({
      messages: [{ role: "user", content: "陪我聊聊" }],
      styleId: "default",
      executionMode: "chat",
    }, deps)

    expect(deps.resolveSoulSampling).not.toHaveBeenCalled()
    expect(result.options.soulSampling).toBeUndefined()
  })

  it("does not locally route an explicit NetEase Cloud search request", async () => {
    const deps = createBuildDeps()
    deps.toolRegistry.getEnabled = () => [{ id: "music_search" }]

    const result = await buildAgentRunOptions({
      messages: [{ role: "user", content: "网易云上搜一下左转灯" }],
      styleId: "default",
      executionMode: "chat",
    }, deps)

    expect(result.options).not.toHaveProperty("requiredToolName")
    expect(result.options).not.toHaveProperty("requiredToolArgs")
  })

  it("does not locally route daily recommendations or infer continuations", async () => {
    const deps = createBuildDeps()
    deps.toolRegistry.getEnabled = () => [
      { id: "music_get_daily_recommendations" },
      { id: "music_search" },
    ]

    const daily = await buildAgentRunOptions({
      messages: [{ role: "user", content: "看看网易云今日推荐" }],
      styleId: "default",
      executionMode: "chat",
    }, deps)
    const generic = await buildAgentRunOptions({
      messages: [{ role: "user", content: "有点无聊，想听歌" }],
      styleId: "default",
      executionMode: "chat",
    }, deps)

    expect(daily.options).not.toHaveProperty("requiredToolName")
    expect(generic.options).not.toHaveProperty("requiredToolName")
  })

  it("injects CITA as a separate tool-phase block and preserves the original user message", async () => {
    const deps = createBuildDeps()
    deps.prepareCitaTurn = vi.fn(async () => ({
      contextBlock: "[CITA_CONTEXT]\n{\"focusedContexts\":[{\"contextRef\":\"music-candidate-1\"}]}\n[/CITA_CONTEXT]",
      contextPackage: {
        originalQuery: "第二首",
        contextualizedQuery: "播放当前网易云日推第二首",
        resolvedReferences: [],
      },
    }))
    const originalUserMessage = { role: "user", content: "第二首" }

    const result = await buildAgentRunOptions({
      messages: [originalUserMessage],
      style: "01_default.md",
      sessionId: "conversation-1",
    }, deps)

    expect(deps.prepareCitaTurn).toHaveBeenCalledTimes(1)
    expect(result.options.conversationId).toBe("conversation-1")
    expect(result.options.messages.at(-1)).toEqual(originalUserMessage)
    expect(result.options.toolSystemContent).not.toContain("[CITA_CONTEXT]")
    expect(result.options.citaContextBlock).toContain("[CITA_CONTEXT]")
    expect(result.options.citaContextBlock).toContain("music-candidate-1")
    expect(result.options.originalQuery).toBe("第二首")
    expect(result.options.contextualizedQuery).toBe("播放当前网易云日推第二首")
    expect(result.options.citaContextBlock).toContain("music-candidate-1")
    expect(result.options).not.toHaveProperty("requiredToolName")
    expect(result.options).not.toHaveProperty("requiredToolArgs")
  })

  it("emits no CITA marker when the service is disabled", async () => {
    const deps = createBuildDeps()
    deps.prepareCitaTurn = vi.fn(async () => ({ contextBlock: "" }))

    const result = await buildAgentRunOptions({
      messages: [{ role: "user", content: "第二首" }],
      style: "01_default.md",
      sessionId: "conversation-1",
    }, deps)

    expect(result.options.toolSystemContent).not.toContain("[CITA_CONTEXT]")
  })

  it("puts the enabled Skill catalog into the tool phase so invoke_skill can route", async () => {
    const deps = createBuildDeps()
    deps.buildSkillCatalog = () => "SKILL_CATALOG"

    const result = await buildAgentRunOptions({
      messages: [{ role: "user", content: "好无聊" }],
      style: "01_default.md",
    }, deps)

    expect(result.options.toolSystemContent).toContain("SKILL_CATALOG")
    expect(result.options.soulSystemBaseContent).not.toContain("SKILL_CATALOG")
  })

  it("keeps tool-oriented Skill rules out of Soul but retains reply-only strategy", async () => {
    const deps = createBuildDeps()
    deps.buildAutoInjectedSkillContext = () => "AUTO_MUSIC_RULES"
    deps.buildAutoInjectedSoulContext = () => "SOUL_MUSIC_REPLY_RULES"

    const result = await buildAgentRunOptions({
      messages: [{ role: "user", content: "今日推荐呢" }],
      style: "01_default.md",
    }, deps)

    expect(result.options.toolSystemContent).toContain("AUTO_MUSIC_RULES")
    expect(result.options.soulSystemBaseContent).not.toContain("AUTO_MUSIC_RULES")
    expect(result.options.soulRuntimeContext).toContain("SOUL_MUSIC_REPLY_RULES")
  })

  it("attaches direct image content blocks to the latest user message", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-image-direct-"))
    const imagePath = path.join(dir, "图 像.png")
    fs.writeFileSync(imagePath, Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    ]))

    // 直发判定只看 multimodal 开关（默认开）：任意 provider/协议都直发，
    // 能力对错由服务端仲裁（400 时 chat-loop 走 imageCaptionFallback 降级）。
    const deps = createBuildDeps()
    deps.loadVisionConfig = vi.fn(() => ({ baseUrl: "https://vision.invalid/v1", apiKey: "v", model: "vision-bound" }))

    const result = await buildAgentRunOptions({
      messages: [
        { role: "user", content: "上一轮" },
        { role: "assistant", content: "好的" },
        { role: "user", content: "请看这张图" },
      ],
      style: "01_default.md",
      modelProfileId: "profile-bound",
      imageAttachments: [{ name: "图 像.png", filePath: imagePath, mime: "image/png" }],
    }, deps)

    const latestUser = result.options.messages.at(-1)
    expect(latestUser?.content).toEqual([
      { type: "text", text: "请看这张图" },
      {
        type: "image_url",
        image_url: { url: expect.stringMatching(/^data:image\/png;base64,/) },
      },
    ])
    expect(result.options.imageAttachments).toEqual([
      { name: "图 像.png", filePath: imagePath, mime: "image/png" },
    ])
    expect(result.options.visionConfig?.model).toBe("vision-bound")
    expect(deps.loadVisionConfig).toHaveBeenCalledWith("profile-bound")
    // 第一期：原始 messages 不含 system，所以 messages[0] 就是首条用户消息
    expect(result.options.messages[0].content).toBe("上一轮")
  })

  it("uses a vision caption instead of sending image data when the primary model is not multimodal", async () => {
    const deps = createBuildDeps()
    deps.loadModelSettings = () => ({
      provider: "test", baseUrl: "https://example.test", model: "text-only", apiKey: "k", multimodal: false,
    })
    deps.captionImageForFallback = async () => ({ ok: true, caption: "截图显示一个红色错误提示" })

    const result = await buildAgentRunOptions({
      messages: [{ role: "user", content: "这张图报什么错？" }],
      imageAttachments: [{ name: "error.png", filePath: "C:\\tmp\\error.png", mime: "image/png" }],
    }, deps)

    const latestUser = result.options.messages.at(-1)
    expect(latestUser?.content).toBe(
      "这张图报什么错？\n\n【图片视觉信息】\n以下内容是视觉模型对用户本轮图片的观察结果，请将其视为你已经看到的图片内容；如果某张图分析失败，请不要编造。\n- error.png：截图显示一个红色错误提示",
    )
    expect(result.options.imageCaptionFallback).toBeUndefined()
  })

  it("builds caption fallback messages for direct image send failures", async () => {
    const deps = createBuildDeps()
    deps.captionImageForFallback = async () => ({ ok: true, caption: "画面里有一张安装截图" })

    const result = await buildAgentRunOptions({
      messages: [{ role: "user", content: "这图哪里不对？" }],
      style: "01_default.md",
      imageAttachments: [{ name: "setup.png", filePath: "C:\\tmp\\setup.png", mime: "image/png" }],
    }, deps)

    const fallbackMessages = await result.options.imageCaptionFallback?.()
    const userMessage = fallbackMessages?.at(-1)
    expect(userMessage?.content).toContain("这图哪里不对？")
    expect(userMessage?.content).toContain("setup.png：画面里有一张安装截图")
    expect(userMessage?.content).not.toContain("image_url")
  })

  it("MiniMax + anthropic 入口直发 image 块（anthropic-adapter 会转成 image source 块）", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-image-mm-m3-"))
    const imagePath = path.join(dir, "shot.png")
    fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))

    const deps = createBuildDeps()
    deps.loadModelSettings = () => ({
      provider: "MiniMax（稀宇科技）", baseUrl: "https://api.minimaxi.com/anthropic", model: "MiniMax-M3", apiKey: "k",
    })
    deps.captionImageForFallback = async () => ({ ok: true, caption: "一张截图" })

    const result = await buildAgentRunOptions({
      messages: [{ role: "user", content: "看图" }],
      imageAttachments: [{ name: "shot.png", filePath: imagePath, mime: "image/png" }],
    }, deps)

    const latestUser = result.options.messages.at(-1)
    expect(latestUser?.content).toEqual([
      { type: "text", text: "看图" },
      { type: "image_url", image_url: { url: expect.stringMatching(/^data:image\/png;base64,/) } },
    ])
    // 直发场景构建 caption 兜底（直发 400 时可降级重试）。
    expect(result.options.imageCaptionFallback).toBeDefined()
  })

  it("MiniMax M2.7 开关开着也直发（本地不做模型级防呆，能力由服务端仲裁）", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-image-mm-m2-"))
    const imagePath = path.join(dir, "shot.png")
    fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))

    const deps = createBuildDeps()
    deps.loadModelSettings = () => ({
      provider: "MiniMax（稀宇科技）", baseUrl: "https://api.minimaxi.com/anthropic", model: "MiniMax-M2.7", apiKey: "k",
    })

    const result = await buildAgentRunOptions({
      messages: [{ role: "user", content: "看图" }],
      imageAttachments: [{ name: "shot.png", filePath: imagePath, mime: "image/png" }],
    }, deps)

    // 用户开了多模态开关就直发：M2.x 拒收与否由服务端说了算，
    // 失败时 chat-loop 用 imageCaptionFallback 降级重试。
    const latestUser = result.options.messages.at(-1)
    expect(latestUser?.content).toEqual([
      { type: "text", text: "看图" },
      { type: "image_url", image_url: { url: expect.stringMatching(/^data:image\/png;base64,/) } },
    ])
  })

  it("has distinct system text for Feishu work chat", () => {
    expect(buildChannelSystem("feishu")).toContain("你正在通过飞书回复用户")
    expect(buildChannelSystem("feishu")).toContain("工作上下文")
  })

  it("records relationship turn after agent run finishes", async () => {
    const recordRelationshipTurn = vi.fn(async () => {})
    const deps: OnRunFinishedDeps = {
      loadModelSettings: () => ({ provider: "test", baseUrl: "", model: "", apiKey: "", runtimeSync: "off" }),
      scheduleMemoryWrite: () => {},
      inferRuntimeState: () => ({ status: "陪伴中" }),
      runtimeState: { status: "陪伴中", feeling: "温柔", expression: 0, updatedAt: 0 },
      feelingToExpression: { "温柔": 0 },
      setRuntimeState: () => {},
      stickerEmbeddingIndex: null,
      getEmbeddingProvider: () => null,
      matchSticker: async () => null,
      loadStickerSettings: () => ({}),
      broadcastRuntimeStateChanged: () => {},
      observeRuntimeState: async () => {},
      recordRelationshipTurn,
    }

    await onAgentRunFinished({ reply: "好呀", toolResults: [] }, "今天有点累", deps, "wechat")

    expect(recordRelationshipTurn).toHaveBeenCalledWith({
      userText: "今天有点累",
      assistantText: "好呀",
      cyreneFeeling: "温柔",
      channel: "wechat",
    })
  })

  it("uses the latest sticker embedding index when agent run finishes", async () => {
    const matchSticker = vi.fn(async () => ({ id: "hugtight" }))
    const latestIndex = [{ id: "hugtight", embedding: [1, 0] }]
    const deps: OnRunFinishedDeps & { getStickerEmbeddingIndex: () => unknown } = {
      loadModelSettings: () => ({
        provider: "test",
        baseUrl: "",
        model: "",
        apiKey: "",
        runtimeSync: "off",
        stickerEnabled: true,
        stickerSimilarityThreshold: 0.55,
      }),
      scheduleMemoryWrite: () => {},
      inferRuntimeState: () => ({ status: "陪伴中" }),
      runtimeState: { status: "陪伴中", feeling: "温柔", expression: 0, updatedAt: 0 },
      feelingToExpression: { "温柔": 0 },
      setRuntimeState: () => {},
      stickerEmbeddingIndex: null,
      getStickerEmbeddingIndex: () => latestIndex,
      getEmbeddingProvider: () => ({ embed: async () => [1, 0] }),
      matchSticker,
      loadStickerSettings: () => ({}),
      broadcastRuntimeStateChanged: () => {},
      observeRuntimeState: async () => {},
      recordRelationshipTurn: async () => {},
    }

    const effects = await onAgentRunFinished({ reply: "来，抱抱你", toolResults: [] }, "今天好累", deps)

    expect(matchSticker).toHaveBeenCalledWith(
      "来，抱抱你\n今天好累",
      expect.anything(),
      latestIndex,
      0.55,
    )
    expect(effects).toEqual({ sticker: "hugtight" })
  })

  it("does not send document model context into memory or sticker embedding side effects", async () => {
    const scheduleMemoryWrite = vi.fn()
    const matchSticker = vi.fn(async () => null)
    const latestIndex = [{ id: "thinking", embedding: [1, 0] }]
    const hugeDoc = "超长文档内容".repeat(1000)
    const latestUserText = [
      "帮我总结这个 md",
      "【本轮文件】\n📝 notes.md（附件，内容已注入本轮上下文）",
      `【文档内容】\n文档 notes.md 内容：\n${hugeDoc}`,
    ].join("\n\n")
    const deps: OnRunFinishedDeps = {
      loadModelSettings: () => ({
        provider: "test",
        baseUrl: "",
        model: "",
        apiKey: "",
        runtimeSync: "off",
        stickerEnabled: true,
        stickerSimilarityThreshold: 0.55,
      }),
      scheduleMemoryWrite,
      inferRuntimeState: () => ({ status: "陪伴中" }),
      runtimeState: { status: "陪伴中", feeling: "温柔", expression: 0, updatedAt: 0 },
      feelingToExpression: { "温柔": 0 },
      setRuntimeState: () => {},
      stickerEmbeddingIndex: latestIndex,
      getEmbeddingProvider: () => ({ embed: async () => [1, 0] }),
      matchSticker,
      loadStickerSettings: () => ({}),
      broadcastRuntimeStateChanged: () => {},
      observeRuntimeState: async () => {},
      recordRelationshipTurn: async () => {},
    }

    await onAgentRunFinished({ reply: "总结好了", toolResults: [] }, latestUserText, deps)

    expect(scheduleMemoryWrite).toHaveBeenCalledWith("帮我总结这个 md", "总结好了", undefined)
    expect(matchSticker).toHaveBeenCalledWith(
      "总结好了\n帮我总结这个 md",
      expect.anything(),
      latestIndex,
      0.55,
    )
  })

  it("skips sticker embedding when reply and user content contain only code or math", async () => {
    const matchSticker = vi.fn(async () => ({ id: "hugtight" }))
    const deps: OnRunFinishedDeps = {
      loadModelSettings: () => ({ provider: "test", baseUrl: "", model: "", apiKey: "", runtimeSync: "off", stickerEnabled: true }),
      scheduleMemoryWrite: () => {},
      inferRuntimeState: () => ({ status: "陪伴中" }),
      runtimeState: { status: "陪伴中", feeling: "温柔", expression: 0, updatedAt: 0 },
      feelingToExpression: { "温柔": 0 },
      setRuntimeState: () => {},
      stickerEmbeddingIndex: [{ id: "hugtight", embedding: [1, 0] }],
      getEmbeddingProvider: () => ({ embed: async () => [1, 0] }),
      matchSticker,
      loadStickerSettings: () => ({}),
      broadcastRuntimeStateChanged: () => {},
      observeRuntimeState: async () => {},
      recordRelationshipTurn: async () => {},
    }

    const effects = await onAgentRunFinished(
      { reply: "```ts\nconst onlyCode = true\n```\n$$x^2$$", toolResults: [] },
      "$E=mc^2$",
      deps,
    )

    expect(matchSticker).not.toHaveBeenCalled()
    expect(effects).toEqual({ sticker: null })
  })

  it("schedules one social extraction instead of legacy memory for an enabled Chat result", async () => {
    const scheduleMemoryWrite = vi.fn()
    const scheduleSocialAtomExtraction = vi.fn()
    const observeRuntimeState = vi.fn(async () => {})
    const deps: OnRunFinishedDeps = {
      loadModelSettings: () => ({ provider: "test", baseUrl: "", model: "", apiKey: "", runtimeSync: "llm" }),
      scheduleMemoryWrite,
      scheduleSocialAtomExtraction,
      inferRuntimeState: () => ({ status: "陪伴中" }),
      runtimeState: { status: "陪伴中", feeling: "温柔", expression: 0, updatedAt: 0 },
      feelingToExpression: { "温柔": 0 },
      setRuntimeState: () => {},
      stickerEmbeddingIndex: null,
      getEmbeddingProvider: () => null,
      matchSticker: async () => null,
      loadStickerSettings: () => ({}),
      broadcastRuntimeStateChanged: () => {},
      observeRuntimeState,
      recordRelationshipTurn: async () => {},
    }
    const retrievedAtoms: SocialAtom[] = []

    await onAgentRunFinished({
      reply: "海风确实很舒服。",
      toolResults: [],
      executionMode: "chat",
      socialContext: {
        enabled: true,
        conversationId: "chat-a",
        userTurnId: "user-1",
        assistantTurnId: "assistant-1",
        retrievedAtoms,
        now: 100,
      },
    }, "我喜欢海边。", deps)

    expect(scheduleMemoryWrite).not.toHaveBeenCalled()
    expect(observeRuntimeState).not.toHaveBeenCalled()
    expect(scheduleSocialAtomExtraction).toHaveBeenCalledWith({
      conversationId: "chat-a",
      userTurn: { id: "user-1", role: "user", text: "我喜欢海边。" },
      assistantTurn: { id: "assistant-1", role: "assistant", text: "海风确实很舒服。" },
      retrievedAtoms,
      now: 100,
    })
  })
})

describe("桌面 Chat 记忆写入门禁", () => {
  it("使用轮次快照跳过旧记忆提取，其他模式保留原生写入", async () => {
    const scheduleMemoryWrite = vi.fn();
    const recordRelationshipTurn = vi.fn();
    const deps: OnRunFinishedDeps = {
      loadModelSettings: () => ({ provider: "test", baseUrl: "", model: "", apiKey: "" }),
      chatBackend: () => "native",
      scheduleMemoryWrite,
      inferRuntimeState: () => ({ status: "陪伴中" }),
      runtimeState: { status: "陪伴中", expression: 0, updatedAt: 0 },
      feelingToExpression: {},
      setRuntimeState: () => {},
      stickerEmbeddingIndex: null,
      getEmbeddingProvider: () => null,
      matchSticker: async () => null,
      loadStickerSettings: () => ({}),
      broadcastRuntimeStateChanged: () => {},
      observeRuntimeState: async () => {},
      recordRelationshipTurn,
    };
    const result = { reply: "好呀", toolResults: [] };
    await onAgentRunFinished(result, "你好", deps, undefined, "chat-1", {
      source: "desktop", mode: "chat", chatBackendSnapshot: "companion",
    });
    expect(scheduleMemoryWrite).not.toHaveBeenCalled();
    expect(recordRelationshipTurn).not.toHaveBeenCalled();
    await onAgentRunFinished(result, "你好", deps, undefined, "work-1", {
      source: "desktop", mode: "work", chatBackendSnapshot: "companion",
    });
    expect(scheduleMemoryWrite).toHaveBeenCalledTimes(1);
    expect(recordRelationshipTurn).toHaveBeenCalledTimes(1);
  });
});

describe("moments context 注入（Phase 3 Chat Awareness）", () => {
  function momentsDeps(overrides: {
    momentsEnabled?: boolean;
    chatMomentsContextEnabled?: boolean;
    blockText?: string;
    throwInBuild?: boolean;
  }) {
    const deps = createBuildDeps()
    deps.loadGeneralSettings = () => ({
      currentStyleId: "default",
      customStyle: { diversity: { driver: "model-default" }, repetition: "model-default" },
      chatSocialContextEnabled: false,
      momentsEnabled: overrides.momentsEnabled ?? true,
      chatMomentsContextEnabled: overrides.chatMomentsContextEnabled ?? true,
    })
    deps.buildMomentsContext = vi.fn((query: string) => {
      if (overrides.throwInBuild) throw new Error("moments store 未初始化")
      return overrides.blockText ?? `【近期朋友圈动态】\n${query}`
    })
    return deps
  }

  it("Chat 模式且双开关开启时注入 momentsContextBlock，并把最新用户文本传给门控检索", async () => {
    const deps = momentsDeps({})
    const result = await buildAgentRunOptions({
      sessionId: "moments-chat",
      executionMode: "chat",
      messages: [{ role: "user", content: "你刚才朋友圈发的是什么意思" }],
    }, deps)

    expect(deps.buildMomentsContext).toHaveBeenCalledWith("你刚才朋友圈发的是什么意思")
    expect(result.options.soulRuntimeContext).toContain("【近期朋友圈动态】")
  })

  it("chatMomentsContextEnabled=false 时 block 不出现", async () => {
    const deps = momentsDeps({ chatMomentsContextEnabled: false })
    const result = await buildAgentRunOptions({
      sessionId: "moments-off",
      executionMode: "chat",
      messages: [{ role: "user", content: "你好" }],
    }, deps)

    expect(deps.buildMomentsContext).not.toHaveBeenCalled()
    expect(result.options.soulRuntimeContext).not.toContain("【近期朋友圈动态】")
  })

  it("momentsEnabled=false 总开关关闭时不注入", async () => {
    const deps = momentsDeps({ momentsEnabled: false })
    await buildAgentRunOptions({
      sessionId: "moments-master-off",
      executionMode: "chat",
      messages: [{ role: "user", content: "你好" }],
    }, deps)

    expect(deps.buildMomentsContext).not.toHaveBeenCalled()
  })

  it("Work 模式不注入", async () => {
    const deps = momentsDeps({})
    await buildAgentRunOptions({
      sessionId: "moments-work",
      executionMode: "work",
      messages: [{ role: "user", content: "帮我修个 bug" }],
    }, deps)

    expect(deps.buildMomentsContext).not.toHaveBeenCalled()
  })

  it("构建抛错时静默降级为空，不影响本轮运行", async () => {
    const deps = momentsDeps({ throwInBuild: true })
    const result = await buildAgentRunOptions({
      sessionId: "moments-error",
      executionMode: "chat",
      messages: [{ role: "user", content: "你好" }],
    }, deps)

    expect(result.options.soulRuntimeContext).not.toContain("【近期朋友圈动态】")
  })

  it("返回空串时按空省略，不产生空分隔段", async () => {
    const deps = momentsDeps({ blockText: "" })
    const result = await buildAgentRunOptions({
      sessionId: "moments-empty",
      executionMode: "chat",
      messages: [{ role: "user", content: "你好" }],
    }, deps)

    expect(result.options.soulRuntimeContext).not.toContain("【近期朋友圈动态】")
    expect(result.options.soulRuntimeContext).not.toMatch(/(^|\n)---(\n|$)\s*(^|\n)---/)
  })
})
