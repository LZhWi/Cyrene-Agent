import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPluginPromptRegistry,
  MAX_PLUGIN_PROMPT_CHARS,
  MAX_PLUGIN_PROMPT_TOTAL_CHARS,
  PLUGIN_PROMPT_PROVIDER_TIMEOUT_MS,
} from "./prompts";
import type { PluginPromptSource } from "./types";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("PluginPromptRegistry", () => {
  it("稳定人格层不接收用户正文，并按模式、停止信号和所有者注销过滤", async () => {
    const registry = createPluginPromptRegistry();
    const owner = new AbortController();
    const provide = vi.fn(({ conversationId }) => `PERSONA:${conversationId}`);
    registry.registerStable("companion", { id: "persona", modes: ["chat"], provide }, owner.signal);

    expect(await registry.buildStable({ source: "conversation", mode: "chat", conversationId: "c1" }))
      .toBe("PERSONA:c1");
    expect(provide.mock.calls[0][0]).not.toHaveProperty("userText");
    expect(await registry.buildStable({ source: "conversation", mode: "work", conversationId: "c1" })).toBe("");

    expect(registry.unregisterStable("other", "persona")).toBe(false);
    owner.abort();
    expect(await registry.buildStable({ source: "conversation", mode: "chat", conversationId: "c1" })).toBe("");
  });

  it("keeps tool and soul stable providers in separate cache prefixes", async () => {
    const registry = createPluginPromptRegistry();
    const signal = new AbortController().signal;
    registry.registerStable("companion", { id: "persona", modes: ["chat"], provide: () => "SOUL" }, signal);
    registry.registerStable("companion", {
      id: "tool-rules", modes: ["chat"], target: "tool", provide: ({ target }) => `TOOL:${target}`,
    }, signal);

    expect(await registry.buildStable({ source: "conversation", mode: "chat", conversationId: "c1", target: "soul" }))
      .toBe("SOUL");
    expect(await registry.buildStable({ source: "conversation", mode: "chat", conversationId: "c1", target: "tool" }))
      .toBe("TOOL:tool");
  });

  it("keeps companion tone and final Soul anchor in independent targets", async () => {
    const registry = createPluginPromptRegistry();
    const signal = new AbortController().signal;
    registry.registerStable("companion", {
      id: "tone", modes: ["chat"], target: "tone", provide: () => "TONE_RULES",
    }, signal);
    registry.registerStable("companion", {
      id: "tail", modes: ["chat"], target: "soul-tail", provide: () => "TAIL_ANCHOR",
    }, signal);

    expect(await registry.buildStable({ source: "conversation", mode: "chat", conversationId: "c1", target: "tone" }))
      .toBe("TONE_RULES");
    expect(await registry.buildStable({ source: "conversation", mode: "chat", conversationId: "c1", target: "soul-tail" }))
      .toBe("TAIL_ANCHOR");
    expect(await registry.buildStable({ source: "conversation", mode: "chat", conversationId: "c1", target: "soul" }))
      .toBe("");
  });

  it("按注册顺序拼接命名空间内容，并按模式过滤", async () => {
    const registry = createPluginPromptRegistry();
    const first = new AbortController();
    const second = new AbortController();
    registry.register("alpha", {
      id: "shared",
      modes: ["chat"],
      provide: ({ userText }) => `A:${userText}`,
    }, first.signal);
    registry.register("beta", {
      id: "shared",
      modes: ["work"],
      provide: async ({ source }) => `B:${source}`,
    }, second.signal);

    expect(await registry.build({
      source: "conversation",
      mode: "chat",
      userText: "你好",
    })).toBe("[插件上下文：plugin:alpha:shared]\nA:你好");
    expect(await registry.build({
      source: "scheduler",
      mode: "work",
      userText: "检查任务",
    })).toBe("[插件上下文：plugin:beta:shared]\nB:scheduler");
  });

  it("按 priority 跨插件排序，同值继续保持注册顺序", async () => {
    const registry = createPluginPromptRegistry();
    const signal = new AbortController().signal;
    registry.register("worldbook", { id: "context", priority: 300, provide: () => "WORLD" }, signal);
    registry.register("memory-a", { id: "context", priority: 200, provide: () => "MEMORY_A" }, signal);
    registry.register("life", { id: "context", priority: 100, provide: () => "LIFE" }, signal);
    registry.register("memory-b", { id: "context", priority: 200, provide: () => "MEMORY_B" }, signal);

    const result = await registry.build({ source: "conversation", mode: "chat", userText: "hi" });
    expect(result.indexOf("LIFE")).toBeLessThan(result.indexOf("MEMORY_A"));
    expect(result.indexOf("MEMORY_A")).toBeLessThan(result.indexOf("MEMORY_B"));
    expect(result.indexOf("MEMORY_B")).toBeLessThan(result.indexOf("WORLD"));
  });

  it("同一插件拒绝重复和非法 id，不同插件可使用相同短 id", () => {
    const registry = createPluginPromptRegistry();
    const signal = new AbortController().signal;
    const provider = { id: "context", provide: () => "ok" };
    registry.register("alpha", provider, signal);
    expect(() => registry.register("alpha", provider, signal)).toThrow(/已注册/);
    expect(() => registry.register("beta", provider, signal)).not.toThrow();
    expect(() => registry.register("alpha", { id: "../bad", provide: () => "bad" }, signal)).toThrow(/非法/);
  });

  it("单个 Provider 失败不阻止其他内容", async () => {
    const registry = createPluginPromptRegistry();
    const signal = new AbortController().signal;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    registry.register("broken", { id: "context", provide: () => { throw new Error("failed"); } }, signal);
    registry.register("kept", { id: "context", provide: () => "KEPT" }, signal);

    const result = await registry.build({ source: "conversation", mode: "chat", userText: "hi" });

    expect(result).toContain("KEPT");
    expect(result).not.toContain("broken:context]");
    expect(warn).toHaveBeenCalledOnce();
  });

  it("Provider 超时后跳过且不阻塞其他内容", async () => {
    vi.useFakeTimers();
    const registry = createPluginPromptRegistry();
    const signal = new AbortController().signal;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    registry.register("slow", { id: "context", provide: () => new Promise<string>(() => {}) }, signal);
    registry.register("fast", { id: "context", provide: () => "FAST" }, signal);

    const building = registry.build({ source: "conversation", mode: "chat", userText: "hi" });
    await vi.advanceTimersByTimeAsync(PLUGIN_PROMPT_PROVIDER_TIMEOUT_MS);

    await expect(building).resolves.toContain("FAST");
  });

  it("动态与稳定插件提示词均统一允许两分钟内完成", async () => {
    vi.useFakeTimers();
    const registry = createPluginPromptRegistry();
    const signal = new AbortController().signal;
    registry.register("demo", { id: "context", provide: () => new Promise<string>((resolve) => setTimeout(() => resolve("MEMORY"), 3_000)) }, signal);
    registry.registerStable("demo", { id: "stable", provide: () => new Promise<string>((resolve) => setTimeout(() => resolve("STABLE"), 3_000)) }, signal);
    const dynamic = registry.build({ source: "conversation", mode: "chat", userText: "hi" });
    const stable = registry.buildStable({ source: "conversation", mode: "chat" });
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(dynamic).resolves.toContain("MEMORY");
    await expect(stable).resolves.toContain("STABLE");
    expect(PLUGIN_PROMPT_PROVIDER_TIMEOUT_MS).toBe(120_000);
  });

  it("停止信号、所有者注销和单项长度上限均生效", async () => {
    const registry = createPluginPromptRegistry();
    const owner = new AbortController();
    const removed = new AbortController();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    registry.register("active", { id: "long", provide: () => "x".repeat(MAX_PLUGIN_PROMPT_CHARS + 10) }, owner.signal);
    registry.register("removed", { id: "context", provide: () => "REMOVED" }, removed.signal);
    expect(registry.unregister("other", "context")).toBe(false);
    expect(registry.unregister("removed", "context")).toBe(true);

    const active = await registry.build({ source: "conversation", mode: "chat", userText: "hi" });
    expect(active).toContain("x".repeat(MAX_PLUGIN_PROMPT_CHARS));
    expect(active).not.toContain("REMOVED");

    owner.abort();
    expect(await registry.build({ source: "conversation", mode: "chat", userText: "hi" })).toBe("");
  });

  it("总长度上限包含标题和分隔符", async () => {
    const registry = createPluginPromptRegistry();
    const signal = new AbortController().signal;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (let index = 0; index < 3; index += 1) {
      registry.register("demo", {
        id: `context-${index}`,
        provide: () => "x".repeat(MAX_PLUGIN_PROMPT_CHARS),
      }, signal);
    }

    const result = await registry.build({ source: "conversation", mode: "chat", userText: "hi" });

    expect(result.length).toBe(MAX_PLUGIN_PROMPT_TOTAL_CHARS);
    expect(result).toContain("plugin:demo:context-0");
    expect(result).toContain("plugin:demo:context-1");
    expect(result).not.toContain("plugin:demo:context-2");
  });

  it("Companion Chat 内建动态段沿用本地拼接，不增加来源标题或通用字符截断", async () => {
    const registry = createPluginPromptRegistry();
    const signal = new AbortController().signal;
    const memory = "M".repeat(MAX_PLUGIN_PROMPT_TOTAL_CHARS + 1);
    registry.register("companion-chat", { id: "life-context", priority: 100, provide: () => "LIFE" }, signal);
    registry.register("companion-memory", {
      id: "memory-context", priority: 200, consumptionReceipt: true, provide: () => memory,
    }, signal);
    registry.register("companion-chat", { id: "worldbook", priority: 300, provide: () => "WORLD" }, signal);

    const result = await registry.buildDetailed({
      source: "conversation", mode: "chat", chatBackend: "companion", userText: "hi", runId: "run-local",
    } as never);

    expect(result.content).toBe(`LIFE\n\n${memory}\n\nWORLD`);
    expect(result.content).not.toContain("[插件上下文：");
    expect(result.receipts).toEqual([{
      providerId: "plugin:companion-memory:memory-context",
      acceptedChars: memory.length,
      complete: true,
    }]);
  });

  it("旧 Provider 不产生回执，显式声明后返回完整接收回执", async () => {
    const registry = createPluginPromptRegistry();
    const signal = new AbortController().signal;
    registry.register("legacy", { id: "context", provide: () => "LEGACY" }, signal);
    registry.register("memory", {
      id: "context",
      consumptionReceipt: true,
      provide: () => "MEMORY",
    }, signal);

    const result = await registry.buildDetailed({
      source: "conversation", mode: "chat", userText: "hi", runId: "run-1",
    });

    expect(result.content).toContain("LEGACY");
    expect(result.content).toContain("MEMORY");
    expect(result.receipts).toEqual([{
      providerId: "plugin:memory:context",
      acceptedChars: 6,
      complete: true,
    }]);
  });

  it("回执准确报告单项和总预算截断，完全忽略的 Provider 不产生回执", async () => {
    const registry = createPluginPromptRegistry();
    const signal = new AbortController().signal;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    registry.register("demo", {
      id: "single",
      consumptionReceipt: true,
      provide: () => "a".repeat(MAX_PLUGIN_PROMPT_CHARS + 10),
    }, signal);
    registry.register("demo", {
      id: "global",
      consumptionReceipt: true,
      provide: () => "b".repeat(MAX_PLUGIN_PROMPT_CHARS),
    }, signal);
    registry.register("demo", {
      id: "ignored",
      consumptionReceipt: true,
      provide: () => "c",
    }, signal);

    const result = await registry.buildDetailed({ source: "conversation", mode: "chat", userText: "hi", runId: "run-budget" });

    expect(result.content.length).toBe(MAX_PLUGIN_PROMPT_TOTAL_CHARS);
    expect(result.receipts[0]).toMatchObject({ providerId: "plugin:demo:single", acceptedChars: MAX_PLUGIN_PROMPT_CHARS, complete: false });
    expect(result.receipts[1]).toMatchObject({ providerId: "plugin:demo:global", complete: false });
    expect(result.receipts[1].acceptedChars).toBeGreaterThan(0);
    expect(result.receipts).toHaveLength(2);
  });

  it("非法 consumptionReceipt 声明在注册时拒绝", () => {
    const registry = createPluginPromptRegistry();
    const signal = new AbortController().signal;
    expect(() => registry.register("bad", {
      id: "context",
      consumptionReceipt: "yes" as unknown as boolean,
      provide: () => "BAD",
    }, signal)).toThrow(/consumptionReceipt/);
  });

  it("非法 priority 声明在注册时拒绝", () => {
    const registry = createPluginPromptRegistry();
    const signal = new AbortController().signal;
    for (const priority of [1.5, Number.NaN, 1001, -1001]) {
      expect(() => registry.register("bad", {
        id: `context-${String(priority)}`,
        priority,
        provide: () => "BAD",
      }, signal)).toThrow(/priority/);
    }
  });
});

describe("场景作用域（sources）", () => {
  it("无 Provider 参与时 moments-post 构建返回空串（mode 缺省合法）", async () => {
    const registry = createPluginPromptRegistry();

    expect(await registry.build({ source: "moments-post", userText: "x" })).toBe("");
  });

  it("未声明 sources 的 Provider 只参与既有场景（向后兼容）", async () => {
    const registry = createPluginPromptRegistry();
    const signal = new AbortController().signal;
    registry.register("legacy", { id: "context", provide: () => "LEGACY" }, signal);

    expect(await registry.build({ source: "moments-post", userText: "hi" })).toBe("");
    expect(await registry.build({ source: "conversation", mode: "chat", userText: "hi" }))
      .toBe("[插件上下文：plugin:legacy:context]\nLEGACY");
    expect(await registry.build({ source: "scheduler", mode: "work", userText: "hi" }))
      .toBe("[插件上下文：plugin:legacy:context]\nLEGACY");
  });

  it("显式 sources: [\"moments-post\"] 后完全按声明生效", async () => {
    const registry = createPluginPromptRegistry();
    const signal = new AbortController().signal;
    registry.register("moments", {
      id: "context",
      sources: ["moments-post"],
      provide: ({ source }) => `POST:${source}`,
    }, signal);

    expect(await registry.build({ source: "moments-post", userText: "hi" }))
      .toBe("[插件上下文：plugin:moments:context]\nPOST:moments-post");
    expect(await registry.build({ source: "conversation", mode: "chat", userText: "hi" })).toBe("");
  });

  it("plugin-agent 场景只调用显式声明该来源的 Provider", async () => {
    const registry = createPluginPromptRegistry();
    const signal = new AbortController().signal;
    registry.register("minecraft", {
      id: "goal-context",
      sources: ["plugin-agent"] as unknown as PluginPromptSource[],
      provide: ({ source }) => `GOAL:${source}`,
    }, signal);
    registry.register("legacy", {
      id: "conversation-context",
      provide: () => "LEGACY",
    }, signal);

    expect(await registry.build({
      source: "plugin-agent",
      mode: "work",
      userText: "收集木头",
    } as never)).toBe("[插件上下文：plugin:minecraft:goal-context]\nGOAL:plugin-agent");
  });

  it("moments-post 场景下 Provider 抛错时降级为空串", async () => {
    const registry = createPluginPromptRegistry();
    const signal = new AbortController().signal;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    registry.register("broken", {
      id: "context",
      sources: ["moments-post"],
      provide: () => { throw new Error("failed"); },
    }, signal);

    expect(await registry.build({ source: "moments-post", userText: "hi" })).toBe("");
    expect(warn).toHaveBeenCalledOnce();
  });

  it("声明 modes 的 Provider 在 moments-post 场景仅由 sources 决定生效（绕过 modes 过滤）", async () => {
    const registry = createPluginPromptRegistry();
    const signal = new AbortController().signal;
    let calls = 0;
    registry.register("moments", {
      id: "context",
      sources: ["moments-post"],
      modes: ["chat"],
      provide: () => { calls += 1; return "POSTED"; },
    }, signal);

    // moments-post 不携带 mode：即使声明了 modes 也参与，是否生效仅由 sources 决定。
    expect(await registry.build({ source: "moments-post", userText: "hi" }))
      .toBe("[插件上下文：plugin:moments:context]\nPOSTED");
    expect(calls).toBe(1);
    // 会话场景被 sources 排除：无论 mode 是否匹配都不参与。
    expect(await registry.build({ source: "conversation", mode: "chat", userText: "hi" })).toBe("");
    expect(await registry.build({ source: "conversation", mode: "work", userText: "hi" })).toBe("");
    expect(calls).toBe(1);
  });

  it("同时声明 moments-post 与 conversation 时，会话场景仍受 modes 约束", async () => {
    const registry = createPluginPromptRegistry();
    const signal = new AbortController().signal;
    registry.register("hybrid", {
      id: "context",
      sources: ["moments-post", "conversation"],
      modes: ["chat"],
      provide: ({ source }) => `HYBRID:${source}`,
    }, signal);

    expect(await registry.build({ source: "moments-post", userText: "hi" }))
      .toBe("[插件上下文：plugin:hybrid:context]\nHYBRID:moments-post");
    expect(await registry.build({ source: "conversation", mode: "work", userText: "hi" })).toBe("");
    expect(await registry.build({ source: "conversation", mode: "chat", userText: "hi" }))
      .toBe("[插件上下文：plugin:hybrid:context]\nHYBRID:conversation");
  });

  it("moments-post 构建只输出声明该场景的 Provider（与仅会话 Provider 混合）", async () => {
    const registry = createPluginPromptRegistry();
    const signal = new AbortController().signal;
    registry.register("chat", {
      id: "context",
      sources: ["conversation"],
      provide: () => "CHAT-ONLY",
    }, signal);
    registry.register("moments", {
      id: "context",
      sources: ["moments-post"],
      provide: () => "POST-ONLY",
    }, signal);

    expect(await registry.build({ source: "moments-post", userText: "hi" }))
      .toBe("[插件上下文：plugin:moments:context]\nPOST-ONLY");
    expect(await registry.build({ source: "conversation", mode: "chat", userText: "hi" }))
      .toBe("[插件上下文：plugin:chat:context]\nCHAT-ONLY");
  });

  it("register 拒绝空数组或含未知场景的 sources", () => {
    const registry = createPluginPromptRegistry();
    const signal = new AbortController().signal;
    expect(() => registry.register("alpha", { id: "context", sources: [], provide: () => "ok" }, signal))
      .toThrow(/sources 非法/);
    const unknownSource = ["moments"] as unknown as PluginPromptSource[];
    expect(() => registry.register("alpha", { id: "context", sources: unknownSource, provide: () => "ok" }, signal))
      .toThrow(/sources 非法/);
  });

  it("register 拒绝假值或非数组形式的 sources，且不影响后续合法注册", async () => {
    const registry = createPluginPromptRegistry();
    const signal = new AbortController().signal;
    const invalidSources = [false, 0, "moments-post", [], ["bogus"]];
    for (const sources of invalidSources) {
      expect(() => registry.register("alpha", {
        id: "context",
        sources: sources as unknown as PluginPromptSource[],
        provide: () => "ok",
      }, signal)).toThrow(/sources 非法/);
    }

    // 只拒绝坏的 Provider：之后合法注册与构建不受影响。
    registry.register("alpha", { id: "context", sources: ["moments-post"], provide: () => "STILL-OK" }, signal);
    expect(await registry.build({ source: "moments-post", userText: "hi" }))
      .toBe("[插件上下文：plugin:alpha:context]\nSTILL-OK");
  });

  it("旧式参数解构写法在升级后保持编译与运行兼容", async () => {
    // 既有 TypeScript 插件常见写法：provide 参数一次解构 source/mode/userText。
    // moments-post 的 mode 类型为 never（可选），升级 SDK 后旧解构必须仍能编译，
    // 且运行时 moments-post 场景不携带 mode（undefined），会话场景照常传值。
    const registry = createPluginPromptRegistry();
    const signal = new AbortController().signal;
    registry.register("alpha", {
      id: "legacy-destructure",
      sources: ["moments-post", "conversation"],
      provide: ({ source, mode, userText }) => `${source}|${String(mode)}|${userText}`,
    }, signal);

    // 编译期兼容即本文件可通过 tsc：这里同时验证运行时语义。
    expect(await registry.build({ source: "moments-post", userText: "hi" }))
      .toBe("[插件上下文：plugin:alpha:legacy-destructure]\nmoments-post|undefined|hi");
    expect(await registry.build({ source: "conversation", mode: "chat", userText: "yo" }))
      .toBe("[插件上下文：plugin:alpha:legacy-destructure]\nconversation|chat|yo");
  });
});
