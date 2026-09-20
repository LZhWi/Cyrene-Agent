import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createMockPluginContext } from "@playa0v0/cyrene-plugin-sdk/testing";
import type { PluginStorage } from "@playa0v0/cyrene-plugin-sdk";
import { createModelService, endpoint, readReferencedConfig, DEFAULT_MODEL_CONFIG } from "../plugins/companion-chat/src/model";
import { createChat, type Turn } from "../plugins/companion-chat/src/chat";
import { createMemory } from "../plugins/companion-memory/src/memory";
import { createPeer, CHAT_ID, MEMORY_ID } from "../plugins/shared/protocol";
import { assertPluginStorageFile, resolvePluginStorageRoot } from "../plugins/shared/boundary";
import { strictStorage } from "../plugins/shared/runtime";
import chatPlugin from "../plugins/companion-chat/src/index";
import memoryPlugin from "../plugins/companion-memory/src/index";

function storage(): PluginStorage {
  const data = new Map<string, unknown>();
  return { get: <T>(key: string) => structuredClone(data.get(key)) as T | undefined,
    set: (key, value) => { data.set(key, structuredClone(value)); }, rootDir: () => "unused" };
}
function turn(n: number, sessionId = "s"): Turn {
  return { id: `${sessionId}-${n}`, sessionId, user: `我喜欢第${n}种茶`, assistant: "收到", userAt: 1000 + n, assistantAt: 2000 + n };
}
const stop = () => new AbortController().signal;
const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix: string): string {
  const parent = path.resolve(".test-runtime");
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(path.join(parent, prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("模型来源与凭据边界", () => {
  it("默认复用当前宿主，宿主模式不读取或复制密钥", async () => {
    expect(DEFAULT_MODEL_CONFIG.reuse).toBe("current");
    expect(DEFAULT_MODEL_CONFIG.personaStyle).toBe("01_default");
    const generateText = vi.fn().mockResolvedValue("来自主程序");
    const ctx = createMockPluginContext({ deps: { llm: { generateText } } });
    const fetcher = vi.fn();
    const models = createModelService(ctx, fetcher);
    expect(await models.generate([{ role: "user", content: "测试" }], stop())).toBe("来自主程序");
    expect(fetcher).not.toHaveBeenCalled();
    expect((await models.view()) as any).not.toHaveProperty("apiKey");
  });
  it("旧模型配置缺少风格字段时安全迁移到默认人格", async () => {
    const ctx = createMockPluginContext();
    ctx.storage.set("model-config", { ...DEFAULT_MODEL_CONFIG, personaStyle: undefined });
    const models = createModelService(ctx);
    expect((await models.view()).personaStyle).toBe("01_default");
  });
  it("自定义密钥只存 secrets，不进入普通配置；保留已有密钥", async () => {
    let key = "";
    const ctx = createMockPluginContext({ deps: { secrets: { get: async () => key, set: async (_k, v) => { key = v; }, delete: async () => false } } });
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [{ finish_reason: "stop", message: { content: "测试成功" } }] }) });
    const models = createModelService(ctx, fetcher);
    const config = { ...DEFAULT_MODEL_CONFIG, mode: "custom", baseUrl: "https://example.invalid/v1", model: "test-model", apiKey: "fake-test-secret" };
    await models.save(config);
    await models.save({ ...config, apiKey: "" });
    expect(JSON.stringify(ctx.storage.get("model-config"))).not.toContain("fake-test-secret");
    expect(JSON.stringify(await models.view())).not.toContain("fake-test-secret");
    expect(await models.generate([{ role: "user", content: "模拟" }], stop())).toBe("测试成功");
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBe("Bearer fake-test-secret");
    expect(fetcher.mock.calls[0][1].redirect).toBe("error");
    await expect(models.save({ ...config, baseUrl: "https://other.invalid/v1", apiKey: "" })).rejects.toThrow("旧密钥");
  });
  it("拒绝危险地址，并且错误不回显服务端秘密", async () => {
    for (const url of ["http://example.com/v1", "https://user:pass@example.com", "https://example.com?key=secret", "file:///test"]) expect(() => endpoint(url)).toThrow();
    expect(endpoint("https://example.com/v1/")).toBe("https://example.com/v1/chat/completions");
    const ctx = createMockPluginContext({ deps: { llm: { generateText: async () => { throw new Error("secret-content"); } } } });
    const models = createModelService(ctx);
    await models.save({ ...DEFAULT_MODEL_CONFIG, reuse: "current" });
    await expect(models.generate([], stop())).rejects.not.toThrow("secret-content");
  });
  it("原配置引用不改文件，未知档案拒绝猜测", () => {
    const dir = temporaryDirectory("model-");
    const file = path.join(dir, "model-settings.json");
    writeFileSync(file, JSON.stringify({ provider: "Kimi", model: "kimi-k2.6", baseUrl: "https://example.invalid/v1", apiKey: "fake-only", explicitTransport: "auto" }));
    const before = readFileSync(file);
    expect(readReferencedConfig(file).model).toBe("kimi-k2.6");
    expect(readFileSync(file).equals(before)).toBe(true);
    writeFileSync(file, JSON.stringify({ profiles: [] }));
    expect(() => readReferencedConfig(file)).toThrow("档案格式");
  });
  it.runIf(process.env.CYRENE_READONLY_MODEL_TEST === "1")("真实配置只读解析（不网络调用，不输出内容）", () => {
    const file = process.env.CYRENE_READONLY_MODEL_PATH ?? path.join(process.env.APPDATA ?? "", "live2d-cyrene", "model-settings.json");
    const hash = () => createHash("sha256").update(readFileSync(file)).digest("hex");
    const before = hash(); const config = readReferencedConfig(file);
    expect(Boolean(config.apiKey && config.model && config.baseUrl)).toBe(true);
    expect(hash()).toBe(before);
  });
});

describe("独立聊天与记忆闭环", () => {
  it("只有成功回复进入记忆，失败投递可以跨实例重试", async () => {
    const data = storage(); const memory = createMemory(storage());
    let online = false;
    const deps = { storage: data, retrieve: async () => "证据", systemPrompt: () => "系统", generate: vi.fn().mockResolvedValue("回复"),
      ingest: async (t: Turn) => { if (!online) throw new Error("offline"); return memory.ingest(t); } };
    const chat = createChat(deps); const id = chat.createSession();
    const result = await chat.send(id, "你好", stop());
    expect(result.warning).not.toBe(""); expect(chat.view().outbox).toHaveLength(1);
    expect(deps.generate.mock.calls[0][0][1].content).toContain("证据");
    online = true; await createChat(deps).sync();
    expect(createChat(deps).view().outbox).toHaveLength(0); expect(memory.view().turns).toHaveLength(1);
  });
  it("取消后迟到回复不能落盘，也不能进入记忆", async () => {
    let complete!: (s: string) => void;
    const ingest = vi.fn(); const chat = createChat({ storage: storage(), retrieve: async () => "", systemPrompt: () => "",
      generate: () => new Promise<string>((resolve) => { complete = resolve; }), ingest });
    const id = chat.createSession(); const run = chat.send(id, "问题", stop());
    await vi.waitFor(() => expect(complete).toBeTypeOf("function"));
    chat.cancel(); complete("迟到回复"); await expect(run).rejects.toThrow("取消");
    expect(chat.view().sessions[0].messages).toHaveLength(1); expect(ingest).not.toHaveBeenCalled();
  });
  it("记忆插件不可用时不启动模型请求", async () => {
    const generate = vi.fn(); const chat = createChat({ storage: storage(), retrieve: async () => { throw new Error("offline"); }, systemPrompt: () => "", generate, ingest: vi.fn() });
    await expect(chat.send(chat.createSession(), "问题", stop())).rejects.toThrow("offline"); expect(generate).not.toHaveBeenCalled();
  });
  it("满 10 轮提取、前 2 后 10、来源时间、队列恢复与重复交付", async () => {
    const data = storage(); let memory = createMemory(data);
    for (let i = 0; i < 10; i++) memory.ingest(turn(i));
    memory.ingest(turn(0));
    const generate = vi.fn().mockResolvedValue(JSON.stringify([{ content: "喜欢第0种茶", quote: "我喜欢第0种茶", turnId: "s-0" }]));
    await memory.maintain(generate, stop()); expect(memory.view().entries[0].sourceAt).toBe(1000);
    memory = createMemory(data);
    for (let i = 10; i < 20; i++) memory.ingest(turn(i));
    generate.mockResolvedValue("[]"); await memory.maintain(generate, stop());
    const prompt = generate.mock.calls[1][0];
    expect(prompt).toContain('"id":"s-8"'); expect(prompt).not.toContain('"id":"s-7"'); expect(prompt).toContain('"id":"s-19"');
    expect(memory.view().pending).toBe(0);
  });
  it("提取只清洗助手派生文本，不改原始轮次或用户原文", async () => {
    const memory = createMemory(storage());
    for (let i = 0; i < 10; i++) memory.ingest({ ...turn(i),
      user: i === 0 ? "用户讨论 <think> 标签" : turn(i).user,
      assistant: i === 0 ? "公开回答<think>隐藏推理</think><soul>隐藏设定</soul>后文" : "收到",
    });
    const original = memory.view().turns[0];
    const generate = vi.fn().mockResolvedValue("[]");
    await memory.maintain(generate, stop());
    const prompt = generate.mock.calls[0][0] as string;
    expect(prompt).toContain("用户讨论 <think> 标签");
    expect(prompt).toContain("公开回答后文");
    expect(prompt).not.toContain("隐藏推理");
    expect(prompt).not.toContain("隐藏设定");
    expect(memory.view().turns[0]).toEqual(original);
  });
  it("非法证据或解析失败不消耗批次，不跨会话凑批", async () => {
    const memory = createMemory(storage());
    for (let i = 0; i < 9; i++) memory.ingest(turn(i));
    memory.ingest(turn(0, "other")); const generate = vi.fn().mockResolvedValue("bad-json");
    await memory.maintain(generate, stop()); expect(generate).not.toHaveBeenCalled();
    memory.ingest(turn(9)); await expect(memory.maintain(generate, stop())).rejects.toThrow();
    generate.mockResolvedValue('[{"content":"猜测","quote":"不存在","turnId":"s-0"}]');
    await expect(memory.maintain(generate, stop())).rejects.toThrow("证据"); expect(memory.view().pending).toBe(11);
  });
  it("存储写失败时不在内存中假装提交成功", () => {
    const data = storage(); const memory = createMemory(data); data.set = () => { throw new Error("disk"); };
    expect(() => memory.ingest(turn(0))).toThrow("disk"); expect(memory.view().turns).toHaveLength(0);
  });
});

describe("跨插件协议与路径边界", () => {
  it("两个实际插件通过 UI IPC 与真实协议完成聊天、检索注入、提取、停用", async () => {
    const generateText = vi.fn().mockImplementation(async (messages) => messages[0]?.content?.startsWith("提取用户") ? "[]" : "已经记住你喜欢乌龙茶");
    const observe = vi.fn(async ({ focus }: { focus?: string } = {}) => `屏幕摘要:${focus ?? ""}`);
    const a = createMockPluginContext({ pluginId: CHAT_ID, deps: { llm: { generateText }, screenObservation: { observe } } });
    const b = createMockPluginContext({ pluginId: MEMORY_ID, deps: { llm: { generateText } } });
    for (const ctx of [a,b]) { const dir = temporaryDirectory(ctx.id); ctx.storage.rootDir = () => dir; }
    for (const [source, target] of [[a,b], [b,a]]) source.events.emit = async (event, payload) => {
      for (const s of [...target.subscriptions]) if (s.event === `plugin:${source.id}:${event}`) s.listener(payload);
    };
    try {
      await chatPlugin.register(a); await memoryPlugin.register(b);
      const ui = async (action: string, data?: unknown) => {
        const result = await a.ipcChannels.get("ui")!(action, data) as any;
        if (!result.ok) throw new Error(result.error);
        return result.data;
      };
      await ui("save-model", { ...DEFAULT_MODEL_CONFIG, reuse: "current" });
      await ui("save-memory-link", { enabled: true });
      const memoryTool = a.tools.find((tool) => tool.id === "companion-chat_memory_search");
      expect(memoryTool).toMatchObject({ modes: ["chat"], effectKind: "read", verificationPolicy: "none" });
      await expect(memoryTool!.execute({ query: "" }, { userQuery: "", signal: stop() })).rejects.toThrow("1 至 2000");
      const sessionId = await ui("new");
      for (let i = 0; i < 10; i++) await ui("send", { sessionId, text: `我喜欢乌龙茶，第${i}次提到` });
      expect((await ui("memory")).turns).toHaveLength(10);
      const dmaeBeforeToolSearch = (await ui("memory")).dmae;
      expect(await memoryTool!.execute({ query: "乌龙茶" }, { userQuery: "乌龙茶", signal: stop() })).toContain("乌龙茶");
      expect((await ui("memory")).dmae).toEqual(dmaeBeforeToolSearch);
      const screenTool = a.tools.find((tool) => tool.id === "companion-chat_screen_observation");
      expect(screenTool).toMatchObject({ modes: ["chat"], effectKind: "read", verificationPolicy: "none" });
      expect(await screenTool!.execute({ focus: "正在做什么" }, { userQuery: "看看屏幕", signal: stop() })).toBe("屏幕摘要:正在做什么");
      expect(observe).toHaveBeenCalledOnce();
      expect(generateText.mock.calls[1][0].some((m: any) => m.content.includes("[历史"))).toBe(true);
      expect((await ui("extract")).batches).toBe(1);
      expect((await ui("memory")).pending).toBe(0);
    } finally { await a.dispose(); await b.dispose(); await chatPlugin.unregister?.(); await memoryPlugin.unregister?.(); }
    expect(a.subscriptions).toHaveLength(0); expect(b.subscriptions).toHaveLength(0);
  });
  it("取消传播到对方任务，不接受迟到结果", async () => {
    const a = createMockPluginContext({ pluginId: CHAT_ID }), b = createMockPluginContext({ pluginId: MEMORY_ID });
    for (const [source, target] of [[a,b], [b,a]]) source.events.emit = async (event, payload) => {
      for (const s of [...target.subscriptions]) if (s.event === `plugin:${source.id}:${event}`) s.listener(payload);
    };
    const pa = createPeer(a, MEMORY_ID, async () => "unused"); let remoteSignal: AbortSignal | undefined;
    createPeer(b, CHAT_ID, async (_m, _d, signal) => { remoteSignal = signal; return new Promise((resolve) => signal.addEventListener("abort", () => resolve("late"), { once: true })); });
    const control = new AbortController(); const run = pa.request("slow", null, control.signal);
    await vi.waitFor(() => expect(remoteSignal).toBeDefined()); control.abort();
    await expect(run).rejects.toThrow("取消"); expect(remoteSignal?.aborted).toBe(true);
    await a.dispose(); await b.dispose();
  });
  it("请求/响应联动、缺席超时、停止清理", async () => {
    const a = createMockPluginContext({ pluginId: CHAT_ID }), b = createMockPluginContext({ pluginId: MEMORY_ID });
    for (const [source, target] of [[a,b], [b,a]]) source.events.emit = async (event, payload) => {
      for (const s of [...target.subscriptions]) if (s.event === `plugin:${source.id}:${event}`) s.listener(payload);
    };
    const pa = createPeer(a, MEMORY_ID, async () => "模型"), pb = createPeer(b, CHAT_ID, async (_m, d) => `结果:${d}`);
    expect(await pa.request("search", "茶")).toBe("结果:茶");
    pb.stop(); await expect(pa.request("search", "茶", undefined, 10)).rejects.toThrow("超时");
    const pending = pa.request("search", "茶"); await a.dispose(); await expect(pending).rejects.toThrow("停止");
    expect(a.subscriptions).toHaveLength(0);
  });
  it("只允许插件私有存储目录直属文件，并拒绝相邻路径", () => {
    const parent = path.resolve(".test-runtime");
    const root = temporaryDirectory("storage-");
    const realRoot = resolvePluginStorageRoot(root);
    expect(() => assertPluginStorageFile(realRoot, path.join(root, "state.json"))).not.toThrow();
    expect(() => assertPluginStorageFile(realRoot, path.join(parent, "state.json"))).toThrow();
  });
  it("已有状态文件损坏时停止加载，不回退为不存在", () => {
    const root = temporaryDirectory("corrupt-");
    writeFileSync(path.join(root, "memory-state.json"), "{broken");
    const ctx = createMockPluginContext();
    const fallback = vi.spyOn(ctx.storage, "get");
    const write = vi.spyOn(ctx.storage, "set");
    ctx.storage.rootDir = () => root;
    const guarded = strictStorage(ctx);
    expect(() => guarded.get("memory-state")).toThrow("不会覆盖原文件");
    expect(() => guarded.set("memory-state", {})).toThrow("不会覆盖原文件");
    expect(fallback).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });
  it("独立聊天默认不等待未安装的记忆插件", async () => {
    const ctx = createMockPluginContext({ pluginId: CHAT_ID, deps: { llm: { generateText: async () => "独立回复" } } });
    ctx.storage.rootDir = () => temporaryDirectory("chat-only-");
    try {
      await chatPlugin.register(ctx);
      const ui = async (action: string, data?: unknown) => (await ctx.ipcChannels.get("ui")!(action, data) as any);
      const created = await ui("new");
      const result = await ui("send", { sessionId: created.data, text: "你好" });
      expect(result.ok).toBe(true);
      expect(result.data.warning).toBe("");
      expect((await ui("state")).data.memoryEnabled).toBe(false);
    } finally { await ctx.dispose(); await chatPlugin.unregister?.(); }
  });

  it("生活日程只注入陪伴后端的桌面 Chat，关闭后立即停止", async () => {
    const ctx = createMockPluginContext({ pluginId: CHAT_ID, deps: { llm: { generateText: async () => "回复" } } });
    ctx.storage.rootDir = () => temporaryDirectory("life-context-");
    try {
      await chatPlugin.register(ctx);
      const provider = ctx.promptProviders.find((item) => item.id === "life-context");
      expect(provider).toBeDefined();
      expect(provider!.priority).toBe(100);
      expect(ctx.promptProviders.find((item) => item.id === "worldbook")?.priority).toBe(300);
      const input = { source: "conversation", mode: "chat", userText: "你好", conversationId: "c",
        signal: ctx.signal } as const;
      expect(await provider!.provide({ ...input, chatBackend: "companion" } as never)).toContain("[你的生活]");
      expect(await provider!.provide({ ...input, chatBackend: "native" } as never)).toBe("");
      expect(await provider!.provide({ ...input, chatBackend: "companion", channel: "wechat" } as never)).toBe("");
      const saved = await ctx.ipcChannels.get("ui")!("save-life-settings", { enabled: false, importantDatesText: "" }) as any;
      expect(saved).toMatchObject({ ok: true, data: { enabled: false } });
      expect(await provider!.provide({ ...input, chatBackend: "companion" } as never)).toBe("");
    } finally { await ctx.dispose(); await chatPlugin.unregister?.(); }
  });
  it("主动消息测试只在显式调用后生成并交给宿主投递", async () => {
    const generateText = vi.fn().mockResolvedValue('{"decision":"send","text":"最近还好吗？记得也给自己留一点休息时间。"}');
    const postProactiveMessage = vi.fn(async (text: string) => ({
      conversationId: "proactive-1", messageId: "message-1", at: "2026-09-18T00:00:00.000Z", text,
    }));
    const ctx = createMockPluginContext({
      pluginId: CHAT_ID,
      deps: { llm: { generateText }, assistantDelivery: { postProactiveMessage } },
    });
    ctx.storage.rootDir = () => temporaryDirectory("proactive-test-");
    try {
      await chatPlugin.register(ctx);
      expect(generateText).not.toHaveBeenCalled();
      expect(postProactiveMessage).not.toHaveBeenCalled();
      const result = await ctx.ipcChannels.get("ui")!("send-proactive-test") as any;
      expect(result.ok).toBe(true);
      expect(result.data).toMatchObject({ conversationId: "proactive-1", messageId: "message-1" });
      expect(generateText).toHaveBeenCalledTimes(1);
      expect(postProactiveMessage).toHaveBeenCalledWith(
        "最近还好吗？记得也给自己留一点休息时间。",
        { allowIgnoreFeedback: false },
      );
    } finally { await ctx.dispose(); await chatPlugin.unregister?.(); }
  });
});
