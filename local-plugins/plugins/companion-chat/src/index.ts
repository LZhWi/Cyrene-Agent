import type { CyrenePlugin, PluginAssistantMessageFeedbackEvent, PluginPromptAcceptedEvent, PluginTool, PluginTurnFinishedEvent, PluginTurnStartedEvent } from "@playa0v0/cyrene-plugin-sdk";
import { CHAT_ID, MEMORY_ID, createPeer } from "../../shared/protocol";
import { createWindow, registerUi, strictStorage } from "../../shared/runtime";
import { createModelService } from "./model";
import { createChat } from "./chat";
import { createProactiveController } from "./proactive";
import { createLifeContext } from "./life-context";
import { createPersonaService } from "./persona";
import { createWorldbook } from "./worldbook";
import { createScreenMonitor } from "./screen-monitor";
import type { UserPresenceSnapshot } from "./proactive";

type PhasedStablePromptProvider = Parameters<NonNullable<Parameters<CyrenePlugin["register"]>[0]["registerStablePromptProvider"]>>[0]
  & { target: "tool" | "tone" | "soul-tail" };
type ChatScopedPluginTool = Omit<PluginTool, "modes"> & { modes: ["chat"] };

let openWindow: (() => Promise<void>) | undefined;
let stop: (() => void) | undefined;
const plugin: CyrenePlugin = {
  register(ctx) {
    if (ctx.id !== CHAT_ID) throw new Error("插件 ID 不匹配");
    const storage = strictStorage(ctx);
    const models = createModelService({ ...ctx, storage });
    const life = createLifeContext(storage);
    ctx.registerIpc("life-status", () => life.status());
    const persona = createPersonaService();
    const worldbook = createWorldbook(storage);
    const screenMonitor = createScreenMonitor({
      storage,
      observe: (input) => ctx.deps.screenObservation!.observe(input),
      stopSignal: ctx.signal,
    });
    const userPresence = (ctx.deps as typeof ctx.deps & {
      userPresence?: { snapshot(): Promise<UserPresenceSnapshot> };
    }).userPresence;
    const stablePersona = () => persona.build(models.config.personaStyle, models.config.systemPrompt);
    // 只有宿主明确选择陪伴后端时才读取；普通原生 Chat 与其他模式不会调用。
    ctx.registerStablePromptProvider?.({
      id: "chat-persona",
      modes: ["chat"],
      provide: stablePersona,
    });
    ctx.registerStablePromptProvider?.({
      id: "chat-tool-rules",
      modes: ["chat"],
      target: "tool",
      provide: () => persona.buildTool(),
    } as PhasedStablePromptProvider);
    ctx.registerStablePromptProvider?.({
      id: "chat-tone-rules",
      modes: ["chat"],
      target: "tone",
      provide: () => persona.buildTone(),
    } as PhasedStablePromptProvider);
    ctx.registerStablePromptProvider?.({
      id: "chat-soul-tail",
      modes: ["chat"],
      target: "soul-tail",
      provide: () => persona.buildTail(),
    } as PhasedStablePromptProvider);
    ctx.registerPromptProvider({
      id: "worldbook",
      priority: 300,
      modes: ["chat"],
      sources: ["conversation"],
      consumptionReceipt: true,
      provide: async (input) => {
        const turn = input as typeof input & { chatBackend?: "native" | "companion"; runId?: string };
        const companion = turn.chatBackend === "companion";
        if (!companion || input.channel || !turn.runId) return "";
        let previousAssistant = "";
        if (ctx.deps.conversations && input.conversationId) {
          let cursor: string | undefined;
          for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
            const page = await ctx.deps.conversations.getMessages({ conversationId: input.conversationId, cursor, limit: 100 });
            for (const message of page.items) if (message.role === "assistant") previousAssistant = message.text;
            cursor = page.nextCursor;
            if (!cursor) break;
          }
        }
        return worldbook.preview(turn.runId, input.userText, previousAssistant);
      },
    });
    ctx.registerPromptProvider({
      id: "life-context",
      priority: 100,
      modes: ["chat"],
      sources: ["conversation"],
      provide: (input) => input.source === "conversation"
        && (input as typeof input & { chatBackend?: "native" | "companion" }).chatBackend === "companion"
        && !input.channel
        ? life.build()
        : "",
    });
    const savedLink = storage.get<{ enabled: boolean }>("memory-link");
    if (savedLink !== undefined && (typeof savedLink !== "object" || typeof savedLink.enabled !== "boolean")) {
      throw new Error("记忆联动配置损坏，拒绝覆盖");
    }
    let memoryEnabled = savedLink?.enabled ?? false;
    let maintenance: AbortController | undefined;
    const peer = createPeer(ctx, MEMORY_ID, async () => { throw new Error("不支持的请求"); });
    const memorySearchTool: ChatScopedPluginTool = {
      id: "companion-chat_memory_search",
      name: "查询陪伴记忆",
      description: "当当前话题需要用户过去的经历、偏好、约定、目标或相关历史原文时，按自然语言查询独立记忆插件。",
      catalogHint: "只读检索陪伴记忆；不会修改记忆、激活值或访问统计。",
      category: "memory",
      enabled: true,
      risk: "safe",
      effectKind: "read",
      verificationPolicy: "none",
      modes: ["chat"],
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "需要回忆的主题或问题，使用简短自然语言。" },
        },
        required: ["query"],
      },
      async execute(args, toolContext) {
        if (!memoryEnabled) return "独立记忆联动当前未启用。";
        const query = typeof args.query === "string" ? args.query.trim() : "";
        if (!query || query.length > 2_000) throw new Error("记忆查询必须为 1 至 2000 个字符");
        const signal = toolContext?.signal
          ? AbortSignal.any([ctx.signal, toolContext.signal])
          : ctx.signal;
        const result = await peer.request<string>("search-for-tool", query, signal, 140000);
        return result.trim() || "没有找到与本次查询相关的陪伴记忆。";
      },
    };
    // 本地 node_modules 仍是 0.2.0 SDK；宿主源码已把 chat 加入 modes。
    ctx.registerTool(memorySearchTool as unknown as PluginTool);
    const screenObservationTool: ChatScopedPluginTool = {
      id: "companion-chat_screen_observation",
      name: "观察当前屏幕",
      description: "当用户明确询问屏幕内容，或回答确实依赖用户当前正在电脑上做什么时，截取当前主屏并用宿主视觉模型分析。",
      catalogHint: "只返回视觉摘要；截图不写盘、不返回给插件，30 秒内的通用观察可复用。",
      category: "vision",
      enabled: true,
      risk: "safe",
      effectKind: "read",
      verificationPolicy: "none",
      modes: ["chat"],
      inputSchema: {
        type: "object",
        properties: {
          focus: { type: "string", description: "可选。需要从当前屏幕确认的具体问题；留空则概括当前活动。" },
        },
      },
      async execute(args, toolContext) {
        const focus = typeof args.focus === "string" ? args.focus.trim() : "";
        if (focus.length > 2_000) throw new Error("屏幕观察问题不能超过 2000 个字符");
        const signal = toolContext?.signal
          ? AbortSignal.any([ctx.signal, toolContext.signal])
          : ctx.signal;
        return ctx.deps.screenObservation!.observe({ focus, signal });
      },
    };
    ctx.registerTool(screenObservationTool as unknown as PluginTool);
    const proactive = createProactiveController({
      storage,
      retrieve: (signal) => memoryEnabled
        ? peer.request<string>("search-for-chat", "用户近期值得关心的事情、目标与偏好", signal, 140000)
        : Promise.resolve(""),
      generate: (messages, signal) => models.generate(messages, signal),
      systemPrompt: () => [stablePersona(), life.build()].filter(Boolean).join("\n\n---\n\n"),
      screenContext: () => screenMonitor.latestContext(),
      presence: () => {
        if (!userPresence) throw new Error("当前宿主不支持用户在场状态");
        return userPresence.snapshot();
      },
      weather: () => ctx.deps.weatherContext?.snapshot() ?? Promise.resolve(null),
      deliver: (text, options) => {
        if (!ctx.deps.assistantDelivery) throw new Error("当前宿主不支持助手消息投递");
        return ctx.deps.assistantDelivery.postProactiveMessage(text, options);
      },
      stopSignal: ctx.signal,
    });
    const offTurnStarted = ctx.events.on<PluginTurnStartedEvent>("host:turn:started", (event) => {
      if (event.source === "desktop" && event.mode === "chat") return proactive.noteUserActivity();
    });
    const offPromptAccepted = ctx.events.on<PluginPromptAcceptedEvent>("host:prompt:accepted", (event) => {
      if (event.providerId === `plugin:${ctx.id}:worldbook`
        && event.complete) worldbook.accept(event.runId);
    });
    const offTurnFinished = ctx.events.on<PluginTurnFinishedEvent>("host:turn:finished", (event) => {
      if (event.source !== "desktop" || event.mode !== "chat") return;
      if (event.status === "success" && event.finalMessageId) worldbook.commit(event.runId);
      else worldbook.discard(event.runId);
    });
    const offAssistantFeedback = ctx.events.on<PluginAssistantMessageFeedbackEvent>("host:assistant-message:feedback", (event) => {
      if (event.pluginId === ctx.id && event.action === "ignore") proactive.ignoreMessage(event.messageId);
    });
    const chat = createChat({ storage,
      retrieve: (query, signal) => memoryEnabled ? peer.request<string>("search-for-chat", query, signal, 140000) : Promise.resolve(""),
      ingest: (turn) => memoryEnabled ? peer.request("ingest", turn) : Promise.resolve(),
      generate: (messages, signal) => models.generate(messages, signal),
      systemPrompt: () => [stablePersona(), life.build()].filter(Boolean).join("\n\n---\n\n"),
    });
    const window = createWindow(ctx, __dirname, "独立陪伴聊天");
    openWindow = window.open;
    stop = () => { maintenance?.abort(); screenMonitor.stop(); proactive.stop(); offTurnStarted(); offPromptAccepted(); offTurnFinished(); offAssistantFeedback(); chat.cancel(); peer.stop(); window.close(); openWindow = undefined; };
    ctx.onDispose(stop);
    registerUi(ctx, async (action, data) => {
      switch (action) {
        case "state": return { chat: chat.view(), model: await models.view(), memoryEnabled, proactive: proactive.view(), screenMonitor: screenMonitor.view(), life: life.view(), worldbook: worldbook.view() };
        case "save-model": if (chat.view().busy || maintenance || proactive.view().busy) throw new Error("请等待当前模型请求结束"); return models.save(data);
        case "save-memory-link": {
          if (chat.view().busy || maintenance || proactive.view().busy || typeof data?.enabled !== "boolean") throw new Error("记忆联动设置无效或当前正忙");
          storage.set("memory-link", { enabled: data.enabled }); memoryEnabled = data.enabled; return { enabled: memoryEnabled };
        }
        case "save-proactive-settings": return proactive.configure(data?.enabled, data?.feedbackLearningEnabled);
        case "save-screen-monitor-settings": return screenMonitor.configure(data?.enabled);
        case "save-life-settings": {
          if (chat.view().busy || maintenance || proactive.view().busy) throw new Error("请等待当前模型请求结束");
          return life.configure(data?.enabled, data?.importantDatesText);
        }
        case "new": return chat.createSession();
        case "send": {
          if (maintenance) throw new Error("请先等待或取消记忆提取");
          await proactive.noteUserActivity();
          return chat.send(data?.sessionId, data?.text, ctx.signal);
        }
        case "cancel": maintenance?.abort(); proactive.cancel(); chat.cancel(); return true;
        case "sync": if (!memoryEnabled) throw new Error("请先启用记忆插件联动"); return chat.sync();
        case "memory": if (!memoryEnabled) throw new Error("请先启用记忆插件联动"); return peer.request("view", null);
        // 手动验证入口绕过时间门槛，但仍记录真实投递并进入自动模式的冷却/未回复计数。
        case "send-proactive-test": {
          if (chat.view().busy || maintenance || proactive.view().busy) throw new Error("请等待当前模型请求结束");
          return proactive.manualTest();
        }
        // 用户点击才触发额外模型请求，不因加载/打开插件自动发送历史。
        case "extract": {
          if (!memoryEnabled) throw new Error("请先启用记忆插件联动");
          if (chat.view().busy || maintenance || proactive.view().busy) throw new Error("请等待当前模型请求结束");
          const controller = new AbortController(); maintenance = controller;
          try { return await peer.request("maintain", null, AbortSignal.any([ctx.signal, controller.signal]), 250000); }
          finally { maintenance = undefined; }
        }
        default: throw new Error("未知操作");
      }
    });
  },
  async open() { await openWindow?.(); },
  unregister() { stop?.(); stop = undefined; },
};
export = plugin;
