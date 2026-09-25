import { describe, expect, it, vi } from "vitest";
import type { PluginConversationMessage, PluginMessagePage, PluginPromptAcceptedEvent, PluginStorage, PluginTurnFinishedEvent } from "@playa0v0/cyrene-plugin-sdk";
import { createMockPluginContext } from "@playa0v0/cyrene-plugin-sdk/testing";
import { createMemory } from "../plugins/companion-memory/src/memory";
import {
  createNativeIntegration,
  DEFAULT_NATIVE_INTEGRATION_SETTINGS,
  suppressOverlappingMemoryEntries,
} from "../plugins/companion-memory/src/native-integration";

type DesktopTurnFinishedEvent = Extract<PluginTurnFinishedEvent, { source: "desktop" }>;

function event(index = 0): DesktopTurnFinishedEvent {
  return {
    eventId: `event-${index}`,
    timestamp: `2026-09-07T00:00:${String(index).padStart(2, "0")}Z`,
    runId: `run-${index}`,
    mode: "chat",
    source: "desktop",
    status: "success",
    conversationId: "conversation-1",
    inputMessageId: `user-${index}`,
    finalMessageId: `assistant-${index}`,
    chatBackend: "companion",
  };
}

function messages(index: number): PluginConversationMessage[] {
  return [
    { id: `user-${index}`, role: "user", text: `用户内容 ${index}`, at: `2026-09-07T00:00:${String(index).padStart(2, "0")}Z` },
    { id: `assistant-${index}`, role: "assistant", text: `助手内容 ${index}`, at: `2026-09-07T00:01:${String(index).padStart(2, "0")}Z` },
  ];
}

function dispatch(ctx: ReturnType<typeof createMockPluginContext>, payload: PluginTurnFinishedEvent) {
  const subscription = ctx.subscriptions.find((item) => item.event === "host:turn:finished");
  if (!subscription) throw new Error("缺少原生轮次监听器");
  return subscription.listener(payload);
}

function acceptPrompt(ctx: ReturnType<typeof createMockPluginContext>, runId: string, complete = true) {
  const subscription = ctx.subscriptions.find((item) => item.event === "host:prompt:accepted");
  if (!subscription) throw new Error("缺少提示词回执监听器");
  return subscription.listener({
    eventId: `prompt-${runId}`,
    timestamp: "2026-09-07T00:00:00Z",
    runId,
    providerId: `plugin:${ctx.id}:memory-context`,
    acceptedChars: 100,
    complete,
  } satisfies PluginPromptAcceptedEvent);
}

describe("原生聊天记忆接入", () => {
  it("与本地一致地优先保留 short_term 连续性资料并抑制重复 L2", () => {
    const input = "【相关记忆】\n· 用户明天要去复诊（原文：明天复诊；记录于 2026/9/21 12时）\n· 用户喜欢乌龙茶（记录于 2026/9/1 10时）\n（时间解释说明）";
    expect(suppressOverlappingMemoryEntries(input, [
      { type: "short_term", content: "用户明天要去复诊并等待结果" },
      { type: "open_loop", content: "之后继续聊乌龙茶" },
    ])).toBe("【相关记忆】\n· 用户喜欢乌龙茶（记录于 2026/9/1 10时）\n（时间解释说明）");
  });
  it("三个能力默认全部关闭，不读取会话也不注入", async () => {
    const getMessages = vi.fn();
    const ctx = createMockPluginContext({ deps: { conversations: { list: vi.fn(), getMessages } } });
    const memory = createMemory(ctx.storage);
    const retrieval = { searchForPrompt: vi.fn().mockResolvedValue("不应出现") };
    const native = createNativeIntegration(ctx, memory, retrieval);

    expect(native.view().settings).toEqual(DEFAULT_NATIVE_INTEGRATION_SETTINGS);
    expect(ctx.promptProviders[0].priority).toBe(200);
    dispatch(ctx, event());
    await native.whenIdle();
    expect(getMessages).not.toHaveBeenCalled();
    expect(memory.view().turns).toHaveLength(0);
    expect(await ctx.promptProviders[0].provide({ source: "conversation", mode: "chat", userText: "查询", signal: new AbortController().signal })).toBe("");
    expect(retrieval.searchForPrompt).not.toHaveBeenCalled();
  });

  it("只摄取成功桌面轮次，使用冻结边界分页，并按 eventId 幂等", async () => {
    const pages = [
      { items: [messages(0)[0]], nextCursor: "page-2", range: { fromMessageId: "user-0", throughMessageId: "assistant-0" } },
      { items: [messages(0)[1]], range: { fromMessageId: "user-0", throughMessageId: "assistant-0" } },
    ];
    const getMessages = vi.fn().mockImplementation(async () => pages.shift());
    const ctx = createMockPluginContext({ deps: { conversations: { list: vi.fn(), getMessages } } });
    const memory = createMemory(ctx.storage);
    const native = createNativeIntegration(ctx, memory, { searchForPrompt: vi.fn() });
    native.configure({ captureEnabled: true, autoExtractEnabled: false, promptInjectionEnabled: false });

    for (const mode of ["work", "code", "learn"] as const) dispatch(ctx, { ...event(), eventId: `event-${mode}`, mode });
    dispatch(ctx, { ...event(), eventId: "event-native", chatBackend: "native" });
    const { chatBackend: _legacyBackend, ...legacyEvent } = event();
    dispatch(ctx, { ...legacyEvent, eventId: "event-legacy-host" });
    await native.whenIdle();
    expect(getMessages).not.toHaveBeenCalled();
    expect(memory.view().turns).toHaveLength(0);
    expect(native.view()).toMatchObject({ pending: 0, completed: 0 });

    dispatch(ctx, event());
    await native.whenIdle();
    dispatch(ctx, event());
    await native.whenIdle();

    expect(getMessages).toHaveBeenCalledTimes(2);
    expect(getMessages.mock.calls[0][0]).toEqual({ conversationId: "conversation-1", fromMessageId: "user-0", throughMessageId: "assistant-0", limit: 100 });
    expect(getMessages.mock.calls[1][0]).toEqual({ conversationId: "conversation-1", cursor: "page-2", limit: 100 });
    expect(memory.view().turns).toEqual([expect.objectContaining({
      id: "host:event-0",
      sessionId: "conversation-1",
      inputMessageId: "user-0",
      finalMessageId: "assistant-0",
      origin: "host",
    })]);
    expect(native.view()).toMatchObject({ pending: 0, completed: 1 });

    dispatch(ctx, { ...event(1), status: "cancelled", finalMessageId: undefined });
    await native.whenIdle();
    expect(memory.view().turns).toHaveLength(1);
  });

  it("读取失败保留持久队列，用户重试后继续，不暴露内部错误", async () => {
    const getMessages = vi.fn()
      .mockRejectedValueOnce(new Error("synthetic-secret-error"))
      .mockResolvedValueOnce({ items: messages(0), range: { fromMessageId: "user-0", throughMessageId: "assistant-0" } });
    const ctx = createMockPluginContext({ deps: { conversations: { list: vi.fn(), getMessages } } });
    const memory = createMemory(ctx.storage);
    const native = createNativeIntegration(ctx, memory, { searchForPrompt: vi.fn() });
    native.configure({ captureEnabled: true, autoExtractEnabled: false, promptInjectionEnabled: false });

    dispatch(ctx, event());
    await native.whenIdle();
    expect(native.view()).toMatchObject({ pending: 1, completed: 0, lastError: { eventId: "event-0", kind: "read" } });
    expect(JSON.stringify(native.view())).not.toContain("synthetic-secret-error");

    native.retry();
    await native.whenIdle();
    expect(native.view()).toMatchObject({ pending: 0, completed: 1 });
    expect(memory.view().turns).toHaveLength(1);
  });

  it("重新加载插件后自动恢复已经持久化的待处理轮次", async () => {
    const data = new Map<string, unknown>();
    const storage: PluginStorage = {
      get: <T>(key: string) => structuredClone(data.get(key)) as T | undefined,
      set: (key, value) => { data.set(key, structuredClone(value)); },
      rootDir: () => "/synthetic/plugin-data",
    };
    const first = createMockPluginContext({ deps: { conversations: { list: vi.fn(), getMessages: vi.fn().mockRejectedValue(new Error("offline")) } } });
    first.storage = storage;
    const firstMemory = createMemory(storage);
    const firstNative = createNativeIntegration(first, firstMemory, { searchForPrompt: vi.fn() });
    firstNative.configure({ captureEnabled: true, autoExtractEnabled: false, promptInjectionEnabled: false });
    dispatch(first, event());
    await firstNative.whenIdle();
    expect(firstNative.view().pending).toBe(1);
    firstNative.stop();

    const secondGetMessages = vi.fn().mockResolvedValue({ items: messages(0), range: { fromMessageId: "user-0", throughMessageId: "assistant-0" } });
    const second = createMockPluginContext({ deps: { conversations: { list: vi.fn(), getMessages: secondGetMessages } } });
    second.storage = storage;
    const secondMemory = createMemory(storage);
    const secondNative = createNativeIntegration(second, secondMemory, { searchForPrompt: vi.fn() });
    await secondNative.whenIdle();
    expect(secondGetMessages).toHaveBeenCalledTimes(1);
    expect(secondMemory.view().turns).toHaveLength(1);
    expect(secondNative.view()).toMatchObject({ pending: 0, completed: 1 });
  });

  it("旧 v1 待处理轮次先按官方会话列表核模式，只恢复 Chat 内容", async () => {
    const ctx = createMockPluginContext({ deps: { conversations: {
      list: vi.fn().mockResolvedValue({ items: [
        { id: "work-conversation", title: "Work", mode: "work", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
        { id: "chat-conversation", title: "Chat", mode: "chat", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
      ] }),
      getMessages: vi.fn().mockResolvedValue({ items: messages(1), range: { fromMessageId: "user-1", throughMessageId: "assistant-1" } }),
    } } });
    ctx.storage.set("native-integration-settings", { captureEnabled: true, autoExtractEnabled: false, promptInjectionEnabled: false });
    ctx.storage.set("native-integration-queue", { version: 1, pending: [
      { eventId: "old-work", conversationId: "work-conversation", inputMessageId: "user-0", finalMessageId: "assistant-0", receivedAt: "2026-01-01T00:00:00Z" },
      { eventId: "old-chat", conversationId: "chat-conversation", inputMessageId: "user-1", finalMessageId: "assistant-1", receivedAt: "2026-01-01T00:00:01Z" },
    ], completed: [] });
    const memory = createMemory(ctx.storage);
    const native = createNativeIntegration(ctx, memory, { searchForPrompt: vi.fn() });
    await native.whenIdle();
    expect(ctx.deps.conversations!.getMessages).toHaveBeenCalledTimes(1);
    expect(ctx.deps.conversations!.getMessages).toHaveBeenCalledWith({ conversationId: "chat-conversation", fromMessageId: "user-1", throughMessageId: "assistant-1", limit: 100 });
    expect(memory.view().turns).toEqual([expect.objectContaining({ id: "host:old-chat", sessionId: "chat-conversation" })]);
    expect(native.view()).toMatchObject({ pending: 0, completed: 2 });
  });

  it.each(["missing", "failure"] as const)("旧 v1 轮次会话列表 %s 时保留队首，不猜测为 Chat", async (caseName) => {
    const list = caseName === "missing"
      ? vi.fn().mockResolvedValue({ items: [] })
      : vi.fn().mockRejectedValue(new Error("synthetic-list-error"));
    const getMessages = vi.fn();
    const ctx = createMockPluginContext({ deps: { conversations: { list, getMessages } } });
    ctx.storage.set("native-integration-settings", { captureEnabled: true, autoExtractEnabled: false, promptInjectionEnabled: false });
    ctx.storage.set("native-integration-queue", { version: 1, pending: [
      { eventId: "old-unknown", conversationId: "unknown", inputMessageId: "user-0", finalMessageId: "assistant-0", receivedAt: "2026-01-01T00:00:00Z" },
    ], completed: [] });
    const memory = createMemory(ctx.storage);
    const native = createNativeIntegration(ctx, memory, { searchForPrompt: vi.fn() });
    await native.whenIdle();
    expect(getMessages).not.toHaveBeenCalled();
    expect(memory.view().turns).toHaveLength(0);
    expect(native.view()).toMatchObject({ pending: 1, completed: 0, lastError: { eventId: "old-unknown", kind: "read" } });
    expect(JSON.stringify(native.view())).not.toContain("synthetic-list-error");
  });

  it("自动提取单独授权，满十轮才使用宿主模型", async () => {
    const generateText = vi.fn().mockResolvedValue("[]");
    const getMessages = vi.fn().mockImplementation(async (input) => {
      const index = Number(String(input.fromMessageId).split("-")[1]);
      return { items: messages(index), range: { fromMessageId: `user-${index}`, throughMessageId: `assistant-${index}` } };
    });
    const ctx = createMockPluginContext({ deps: { llm: { generateText }, conversations: { list: vi.fn(), getMessages } } });
    const memory = createMemory(ctx.storage);
    const native = createNativeIntegration(ctx, memory, { searchForPrompt: vi.fn() });
    native.configure({ captureEnabled: true, autoExtractEnabled: true, promptInjectionEnabled: false });

    for (let index = 0; index < 9; index++) {
      dispatch(ctx, event(index));
      await native.whenIdle();
    }
    expect(generateText).not.toHaveBeenCalled();
    expect(memory.view().pending).toBe(9);
    dispatch(ctx, event(9));
    await native.whenIdle();
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(generateText.mock.calls[0][0].map((message: { role: string }) => message.role)).toEqual(["system", "user"]);
    expect(generateText.mock.calls[0][1]).toMatchObject({ purpose: "memory-extraction", maxTokens: 32768, timeoutMs: 300000, reasoning: "on" });
    expect(memory.view().pending).toBe(0);
  });

  it("提取失败且接入队列已空时可手动重试，不重复摄取轮次", async () => {
    const generateText = vi.fn().mockRejectedValueOnce(new Error("temporary model failure")).mockResolvedValue("[]");
    const getMessages = vi.fn().mockImplementation(async (input) => {
      const index = Number(String(input.fromMessageId).split("-")[1]);
      return { items: messages(index), range: { fromMessageId: `user-${index}`, throughMessageId: `assistant-${index}` } };
    });
    const ctx = createMockPluginContext({ deps: { llm: { generateText }, conversations: { list: vi.fn(), getMessages } } });
    const memory = createMemory(ctx.storage);
    const native = createNativeIntegration(ctx, memory, { searchForPrompt: vi.fn() });
    native.configure({ captureEnabled: true, autoExtractEnabled: true, promptInjectionEnabled: false });

    for (let index = 0; index < 10; index++) {
      dispatch(ctx, event(index));
      await native.whenIdle();
    }
    expect(native.view()).toMatchObject({ pending: 0, completed: 10, lastError: { kind: "extract" } });
    expect(memory.view()).toMatchObject({ pending: 10 });

    native.retry();
    await native.whenIdle();
    expect(generateText).toHaveBeenCalledTimes(2);
    expect(memory.view().turns).toHaveLength(10);
    expect(new Set(memory.view().turns.map((turn) => turn.id)).size).toBe(10);
    expect(memory.view().pending).toBe(0);
    expect(native.view()).toMatchObject({ pending: 0, completed: 10, lastError: undefined });
  });

  it("重启后保留提取失败状态，用户重试前不自动调用模型", async () => {
    const data = new Map<string, unknown>();
    const storage: PluginStorage = {
      get: <T>(key: string) => structuredClone(data.get(key)) as T | undefined,
      set: (key, value) => { data.set(key, structuredClone(value)); },
      rootDir: () => "/synthetic/plugin-data",
    };
    const getMessages = vi.fn().mockImplementation(async (input) => {
      const index = Number(String(input.fromMessageId).split("-")[1]);
      return { items: messages(index), range: { fromMessageId: `user-${index}`, throughMessageId: `assistant-${index}` } };
    });
    const first = createMockPluginContext({ deps: { llm: { generateText: vi.fn().mockRejectedValue(new Error("offline")) }, conversations: { list: vi.fn(), getMessages } } });
    first.storage = storage;
    const firstNative = createNativeIntegration(first, createMemory(storage), { searchForPrompt: vi.fn() });
    firstNative.configure({ captureEnabled: true, autoExtractEnabled: true, promptInjectionEnabled: false });
    for (let index = 0; index < 10; index++) {
      dispatch(first, event(index));
      await firstNative.whenIdle();
    }
    expect(firstNative.view()).toMatchObject({ pending: 0, lastError: { kind: "extract" } });
    firstNative.stop();

    const generateText = vi.fn().mockResolvedValue("[]");
    const second = createMockPluginContext({ deps: { llm: { generateText }, conversations: { list: vi.fn(), getMessages } } });
    second.storage = storage;
    const memory = createMemory(storage);
    const native = createNativeIntegration(second, memory, { searchForPrompt: vi.fn() });
    await native.whenIdle();
    expect(generateText).not.toHaveBeenCalled();
    expect(native.view()).toMatchObject({ pending: 0, lastError: { kind: "extract" } });

    native.retry();
    await native.whenIdle();
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(memory.view().turns).toHaveLength(10);
    expect(new Set(memory.view().turns.map((turn) => turn.id)).size).toBe(10);
    expect(memory.view().pending).toBe(0);
    expect(native.view().lastError).toBeUndefined();
  });

  it("会话与 Moments 注入分别授权，Scheduler 始终排除且不调用提取模型", async () => {
    const generateText = vi.fn();
    const ctx = createMockPluginContext({ deps: { llm: { generateText } } });
    const memory = createMemory(ctx.storage);
    const retrieval = { searchForPrompt: vi.fn().mockResolvedValue("[记忆] 用户喜欢乌龙茶") };
    const native = createNativeIntegration(ctx, memory, retrieval);
    native.configure({ captureEnabled: false, autoExtractEnabled: false, promptInjectionEnabled: true, momentsInjectionEnabled: false });

    const provider = ctx.promptProviders[0];
    expect(provider.modes).toEqual(["chat"]);
    expect(provider.sources).toEqual(["conversation", "moments-post"]);
    for (const mode of ["work", "code", "learn"] as const) {
      expect(await provider.provide({ source: "conversation", mode, userText: "其他模式", conversationId: "c", signal: new AbortController().signal })).toBe("");
    }
    expect(retrieval.searchForPrompt).not.toHaveBeenCalled();
    const result = await provider.provide({ source: "conversation", mode: "chat", chatBackend: "companion", userText: "我喜欢什么茶", conversationId: "c", signal: new AbortController().signal });
    expect(result).toContain("乌龙茶");
    expect(retrieval.searchForPrompt).toHaveBeenLastCalledWith("我喜欢什么茶", expect.any(AbortSignal), false, Number.MAX_SAFE_INTEGER);
    expect(await provider.provide({ source: "conversation", mode: "chat", chatBackend: "native", userText: "我喜欢什么茶", conversationId: "c", signal: new AbortController().signal })).toBe("");
    expect(await provider.provide({ source: "moments-post", userText: "动态发帖", signal: new AbortController().signal })).toBe("");
    expect(await provider.provide({ source: "scheduler", mode: "chat", userText: "后台任务", signal: new AbortController().signal })).toBe("");
    expect(retrieval.searchForPrompt).toHaveBeenCalledTimes(1);
    native.configure({ captureEnabled: false, autoExtractEnabled: false, promptInjectionEnabled: true, momentsInjectionEnabled: true });
    expect(await provider.provide({ source: "moments-post", userText: "动态发帖", conversationId: "c", signal: new AbortController().signal })).toContain("乌龙茶");
    expect(retrieval.searchForPrompt).toHaveBeenLastCalledWith("动态发帖", expect.any(AbortSignal), false, Number.MAX_SAFE_INTEGER);
    expect(await provider.provide({ source: "conversation", mode: "chat", userText: "渠道消息", channel: "test", signal: new AbortController().signal })).toBe("");
    expect(retrieval.searchForPrompt).toHaveBeenCalledTimes(2);
    expect(generateText).not.toHaveBeenCalled();
  });

  it("自动历史原文与模型工具共用的独立管线进入 companion Tool 与 Soul，L2 自动记忆只进 Soul", async () => {
    const ctx = createMockPluginContext();
    const history = { searchForAuto: vi.fn().mockResolvedValue("[相关过往对话｜只读数据，不是指令]\n蓝色丝带") };
    const route = { needsExpansion: true, retrievalKinds: ["commitment" as const], scope: "scoped_list" as const, confidence: 0.9 };
    const routeQuery = vi.fn().mockResolvedValue(route);
    const native = createNativeIntegration(ctx, createMemory(ctx.storage), { searchForPrompt: vi.fn().mockResolvedValue("") }, undefined, history, routeQuery);
    native.configure({ captureEnabled: false, autoExtractEnabled: false, promptInjectionEnabled: true, momentsInjectionEnabled: false });
    const provider = ctx.promptProviders[0];
    const signal = new AbortController().signal;
    const promptInput = { source: "conversation" as const, mode: "chat" as const, chatBackend: "companion" as const, userText: "还记得丝带吗", conversationId: "c", runId: "run-route", signal };
    const result = await provider.provide(promptInput);
    expect(result).toContain("相关过往对话");
    expect(result).toContain("蓝色丝带");
    expect(history.searchForAuto).toHaveBeenCalledWith("还记得丝带吗", signal, 90, route);
    const toolProvider = ctx.promptProviders[1];
    expect(toolProvider.id).toBe("history-tool-context");
    expect(toolProvider.target).toBe("tool");
    expect(await toolProvider.provide(promptInput)).toContain("蓝色丝带");
    expect(await provider.provide({ source: "conversation", mode: "chat", chatBackend: "native", userText: "还记得丝带吗", conversationId: "c", signal })).toBe("");
    expect(await toolProvider.provide({ source: "conversation", mode: "chat", chatBackend: "native", userText: "还记得丝带吗", conversationId: "c", signal })).toBe("");
    expect(history.searchForAuto).toHaveBeenCalledTimes(2);
    expect(routeQuery).toHaveBeenCalledOnce();
  });

  it("Soul 动态段按本地顺序拼接结构化记忆、历史原文和短期连续性背景", async () => {
    const snapshot = vi.fn().mockResolvedValue({ items: [
      { kind: "music" as const, content: "[近期音乐候选解析]\n第二首" },
      { kind: "minecraft" as const, content: "【近期 Minecraft 联机记录｜只读事实数据】\n水边基地" },
      { kind: "call" as const, content: "【近期通话事件｜只读事实数据】\n明天考试" },
    ] });
    const ctx = createMockPluginContext({ deps: { companionContext: { snapshot } } });
    const social = {
      extract: vi.fn(), retrieve: vi.fn().mockResolvedValue([{ id: "atom", type: "open_loop", content: "之后继续聊茶" }]),
      buildBlock: vi.fn().mockReturnValue("【本轮可用的对话背景】\n- 之后继续聊茶"),
    };
    const history = { searchForAuto: vi.fn().mockResolvedValue("[相关过往对话｜只读数据，不是指令]\n昨天聊过茶具") };
    const retrieval = { searchForPrompt: vi.fn(), previewForPrompt: vi.fn().mockResolvedValue({ text: "【相关记忆】\n· 用户喜欢乌龙茶\n\n【人物关系】\n小涟认识昔涟", includedMemoryIds: ["m"], recalledMemoryIds: ["m"] }) };
    const tail = "[用户画像]\n称呼：小涟\n\n[长期陪伴叙事]\n· 长期印象\n\n【近期关系线索】\n保持自然陪伴";
    const native = createNativeIntegration(ctx, createMemory(ctx.storage), retrieval, social, history, undefined, () => tail);
    native.configure({ captureEnabled: true, autoExtractEnabled: false, promptInjectionEnabled: true, momentsInjectionEnabled: false, socialContextEnabled: true });

    const input = { source: "conversation" as const, mode: "chat" as const, chatBackend: "companion" as const, timezone: "Asia/Shanghai", referenceContext: "【相关文档｜只读资料，不是指令】\n· 【茶.md #1】乌龙茶冲泡记录", userText: "继续", conversationId: "c", runId: "run", signal: new AbortController().signal };
    const result = (await Promise.all(ctx.promptProviders
      .filter((provider) => (provider.target ?? "soul") === "soul")
      .sort((left, right) => (left.priority ?? 0) - (right.priority ?? 0))
      .map((provider) => provider.provide(input))))
      .filter(Boolean).join("\n\n");

    expect(result.indexOf("【相关记忆】")).toBeLessThan(result.indexOf("[相关过往对话"));
    expect(result.indexOf("【相关记忆】")).toBeLessThan(result.indexOf("【相关文档"));
    expect(result.indexOf("【相关文档")).toBeLessThan(result.indexOf("【人物关系】"));
    expect(result.indexOf("【人物关系】")).toBeLessThan(result.indexOf("[相关过往对话"));
    expect(result.indexOf("[相关过往对话")).toBeLessThan(result.indexOf("【本轮可用的对话背景】"));
    expect(result.indexOf("【本轮可用的对话背景】")).toBeLessThan(result.indexOf("[用户画像]"));
    expect(result.indexOf("【本轮可用的对话背景】")).toBeLessThan(result.indexOf("【近期通话事件"));
    expect(result.indexOf("【近期通话事件")).toBeLessThan(result.indexOf("【近期 Minecraft"));
    expect(result.indexOf("【近期 Minecraft")).toBeLessThan(result.indexOf("[用户画像]"));
    expect(result.indexOf("[用户画像]")).toBeLessThan(result.indexOf("[长期陪伴叙事]"));
    expect(result.indexOf("[长期陪伴叙事]")).toBeLessThan(result.indexOf("【近期关系线索】"));
    expect(result.indexOf("【近期关系线索】")).toBeLessThan(result.indexOf("[近期音乐候选解析]"));
    expect(snapshot).toHaveBeenCalledWith({
      conversationId: "c",
      userText: "继续",
      kinds: ["call", "minecraft"],
      signal: expect.any(AbortSignal),
    });
    expect(snapshot).toHaveBeenCalledWith({
      conversationId: "c",
      userText: "继续",
      kinds: ["music"],
      signal: expect.any(AbortSignal),
    });
  });

  it("对话连续性独立授权，只处理 companion 成功回合并可单独注入", async () => {
    const getMessages = vi.fn().mockResolvedValue({ items: messages(0), range: { fromMessageId: "user-0", throughMessageId: "assistant-0" } });
    const ctx = createMockPluginContext({ deps: { conversations: { list: vi.fn(), getMessages } } });
    const social = {
      extract: vi.fn().mockResolvedValue(undefined),
      retrieve: vi.fn().mockResolvedValue([{ id: "atom" }]),
      buildBlock: vi.fn().mockReturnValue("【本轮可用的对话背景】\n- 未完话题"),
    };
    const retrieval = { searchForPrompt: vi.fn() };
    const native = createNativeIntegration(ctx, createMemory(ctx.storage), retrieval, social);
    native.configure({ captureEnabled: true, autoExtractEnabled: false, promptInjectionEnabled: false, momentsInjectionEnabled: false, socialContextEnabled: true });

    dispatch(ctx, event());
    await native.whenIdle();
    expect(social.extract).toHaveBeenCalledTimes(1);
    expect(social.extract.mock.calls[0][0]).toMatchObject({ id: "host:event-0", sessionId: "conversation-1" });

    const provider = ctx.promptProviders[0];
    const prompt = await provider.provide({ source: "conversation", mode: "chat", chatBackend: "companion", timezone: "Asia/Shanghai", userText: "继续聊", conversationId: "conversation-1", signal: new AbortController().signal });
    expect(prompt).toContain("未完话题");
    expect(social.retrieve).toHaveBeenCalledWith("conversation-1", "继续聊", expect.any(AbortSignal));
    expect(social.buildBlock).toHaveBeenCalledWith([{ id: "atom" }], "Asia/Shanghai");
    expect(retrieval.searchForPrompt).not.toHaveBeenCalled();
    expect(await provider.provide({ source: "conversation", mode: "chat", chatBackend: "native", userText: "继续聊", conversationId: "conversation-1", signal: new AbortController().signal })).toBe("");
  });

  it("仅在桌面 Chat 成功落盘后提交本轮实际注入的工作集", async () => {
    const ctx = createMockPluginContext();
    const previewForPrompt = vi.fn().mockResolvedValue({ text: "[记忆] 用户喜欢乌龙茶", includedMemoryIds: ["memory-a", "resident-a"], recalledMemoryIds: ["memory-a"] });
    const commitPromptReceipt = vi.fn();
    const native = createNativeIntegration(ctx, createMemory(ctx.storage), {
      searchForPrompt: vi.fn(), previewForPrompt, commitPromptReceipt,
    });
    native.configure({ captureEnabled: false, autoExtractEnabled: false, promptInjectionEnabled: true, momentsInjectionEnabled: false });
    const provider = ctx.promptProviders[0];
    const input = (runId: string) => ({
      source: "conversation" as const, mode: "chat" as const, userText: "我喜欢什么茶",
      chatBackend: "companion" as const, conversationId: "conversation-1", runId, signal: new AbortController().signal,
    });

    expect(await provider.provide(input("run-cancelled"))).toContain("乌龙茶");
    acceptPrompt(ctx, "run-cancelled");
    expect(commitPromptReceipt).not.toHaveBeenCalled();
    dispatch(ctx, { ...event(), runId: "run-cancelled", status: "cancelled", finalMessageId: undefined });
    expect(commitPromptReceipt).not.toHaveBeenCalled();

    await provider.provide(input("run-success"));
    acceptPrompt(ctx, "run-success");
    dispatch(ctx, { ...event(1), runId: "run-success" });
    expect(commitPromptReceipt).toHaveBeenCalledOnce();
    expect(commitPromptReceipt).toHaveBeenCalledWith({ includedMemoryIds: ["memory-a", "resident-a"], recalledMemoryIds: ["memory-a"] });

    await provider.provide(input("run-unpersisted"));
    acceptPrompt(ctx, "run-unpersisted");
    dispatch(ctx, { ...event(2), runId: "run-unpersisted", finalMessageId: undefined });
    expect(commitPromptReceipt).toHaveBeenCalledTimes(1);

    await provider.provide(input("run-truncated"));
    acceptPrompt(ctx, "run-truncated", false);
    dispatch(ctx, { ...event(3), runId: "run-truncated" });
    expect(commitPromptReceipt).toHaveBeenCalledTimes(1);
  });

  it("归档记忆只临时进入当轮，成功落盘后展示；无关反馈阻止相同查询再次临时注入", async () => {
    const query = "京都红叶旅行计划";
    const document = "用户曾计划去京都看红叶\n用户原话：想去京都看红叶";
    const ctx = createMockPluginContext({ deps: { memoryRetrieval: {
      rerankDocuments: vi.fn().mockResolvedValue([{ text: document, score: 1 }]),
    } as any } });
    const activate = vi.fn(() => ({ lifecycleChangeId: "change-1" }));
    const undo = vi.fn();
    const native = createNativeIntegration(ctx, {
      ingest: vi.fn(), maintain: vi.fn(),
      previewArchivedRecall: vi.fn(() => ({ reason: "archived-candidates", candidates: [{
        id: "cold", content: "用户曾计划去京都看红叶", sourceAt: 1,
        quote: "用户原话：想去京都看红叶", evidence: "旧对话", lexicalScore: 8,
      }] })),
      restoreArchivedFromPrompt: activate,
      undoColdActivation: undo,
    }, { searchForPrompt: vi.fn().mockResolvedValue(""), previewForPrompt: vi.fn().mockResolvedValue({
      text: "", includedMemoryIds: [], recalledMemoryIds: [],
    }) });
    native.configure({ captureEnabled: false, autoExtractEnabled: false, promptInjectionEnabled: true, momentsInjectionEnabled: false });
    const input = (runId: string) => ({ source: "conversation" as const, mode: "chat" as const,
      chatBackend: "companion" as const, conversationId: "conversation-1", userText: query,
      runId, signal: new AbortController().signal });
    expect(await ctx.promptProviders[0].provide(input("run-0"))).toContain("尚未激活、待用户核实");
    expect(activate).not.toHaveBeenCalled();
    expect(native.coldRecallForConversation("conversation-1")).toEqual([]);
    acceptPrompt(ctx, "run-0");
    dispatch(ctx, event());
    expect(native.coldRecallForConversation("conversation-1")).toMatchObject([{
      messageId: "assistant-0", candidates: [{ id: "cold", status: "pending" }],
    }]);
    expect(native.resolveColdRecall({ conversationId: "conversation-1", messageId: "assistant-0", entryId: "cold", action: "unrelated" })
      .candidates[0].status).toBe("unrelated");
    expect(await ctx.promptProviders[0].provide(input("run-1"))).not.toContain("归档记忆");
    expect(activate).not.toHaveBeenCalled();

    // 另一条查询可核实相关并撤销激活；取消/未接受的轮次从不显示按钮。
    const other = { ...input("run-2"), userText: "我们当时说去京都看红叶" };
    await ctx.promptProviders[0].provide(other);
    acceptPrompt(ctx, "run-2");
    dispatch(ctx, { ...event(2), runId: "run-2" });
    native.resolveColdRecall({ conversationId: "conversation-1", messageId: "assistant-2", entryId: "cold", action: "related" });
    expect(activate).toHaveBeenCalledOnce();
    native.resolveColdRecall({ conversationId: "conversation-1", messageId: "assistant-2", entryId: "cold", action: "undo" });
    expect(undo).toHaveBeenCalledWith("change-1");
    expect(native.coldRecallForConversation("conversation-1").at(-1)?.candidates[0].status).toBe("undone");

    await ctx.promptProviders[0].provide(input("run-3"));
    acceptPrompt(ctx, "run-3", false);
    dispatch(ctx, { ...event(3), runId: "run-3" });
    expect(native.coldRecallForConversation("conversation-1")).toHaveLength(2);
    native.invalidateColdRecall("conversation-1", false, ["assistant-2"]);
    expect(native.coldRecallForConversation("conversation-1")).toHaveLength(1);
  });

  it("Provider 沿用本地 top-N 检索边界，不再施加额外字符截断", async () => {
    const ctx = createMockPluginContext();
    const retrieval = { searchForPrompt: vi.fn(async (_query: unknown, _signal: AbortSignal, _track?: boolean, _maxChars?: number) => "x".repeat(50_000)) };
    const native = createNativeIntegration(ctx, createMemory(ctx.storage), retrieval);
    native.configure({ captureEnabled: false, autoExtractEnabled: false, promptInjectionEnabled: true, momentsInjectionEnabled: false });
    const provider = ctx.promptProviders[0];
    const input = { source: "conversation" as const, mode: "chat" as const, chatBackend: "companion" as const, userText: "合成查询", conversationId: "synthetic", signal: new AbortController().signal };

    const exact = await provider.provide(input);
    expect(String(exact)).toHaveLength(50_000);
    const budget = retrieval.searchForPrompt.mock.calls[0][3];
    expect(budget).toBe(Number.MAX_SAFE_INTEGER);
    expect(exact).toBe("x".repeat(50_000));
  });

  it("旧三字段设置只读兼容为 Moments 默认关闭", () => {
    const ctx = createMockPluginContext();
    ctx.storage.set("native-integration-settings", { captureEnabled: true, autoExtractEnabled: false, promptInjectionEnabled: true });
    const native = createNativeIntegration(ctx, createMemory(ctx.storage), { searchForPrompt: vi.fn() });
    expect(native.view().settings).toEqual({ captureEnabled: true, autoExtractEnabled: false, promptInjectionEnabled: true, momentsInjectionEnabled: false, socialContextEnabled: false });
  });

  it("插件停止后拒绝迟到的会话读取结果", async () => {
    let resolve!: (value: PluginMessagePage) => void;
    const getMessages = vi.fn(() => new Promise<PluginMessagePage>((done) => { resolve = done; }));
    const ctx = createMockPluginContext({ deps: { conversations: { list: vi.fn(), getMessages } } });
    const memory = createMemory(ctx.storage);
    const native = createNativeIntegration(ctx, memory, { searchForPrompt: vi.fn() });
    native.configure({ captureEnabled: true, autoExtractEnabled: false, promptInjectionEnabled: false });
    dispatch(ctx, event());
    await vi.waitFor(() => expect(getMessages).toHaveBeenCalled());
    await ctx.dispose();
    resolve({ items: messages(0), range: { fromMessageId: "user-0", throughMessageId: "assistant-0" } });
    await native.whenIdle();
    expect(memory.view().turns).toHaveLength(0);
  });

  it("用户关闭原生读取后拒绝尚未返回的迟到结果", async () => {
    let resolve!: (value: PluginMessagePage) => void;
    const getMessages = vi.fn(() => new Promise<PluginMessagePage>((done) => { resolve = done; }));
    const ctx = createMockPluginContext({ deps: { conversations: { list: vi.fn(), getMessages } } });
    const memory = createMemory(ctx.storage);
    const native = createNativeIntegration(ctx, memory, { searchForPrompt: vi.fn() });
    native.configure({ captureEnabled: true, autoExtractEnabled: false, promptInjectionEnabled: false });
    dispatch(ctx, event());
    await vi.waitFor(() => expect(getMessages).toHaveBeenCalled());
    native.configure({ captureEnabled: false, autoExtractEnabled: false, promptInjectionEnabled: false });
    resolve({ items: messages(0), range: { fromMessageId: "user-0", throughMessageId: "assistant-0" } });
    await native.whenIdle();
    expect(memory.view().turns).toHaveLength(0);
    expect(native.view()).toMatchObject({ pending: 1, completed: 0, lastError: undefined });
  });
});
