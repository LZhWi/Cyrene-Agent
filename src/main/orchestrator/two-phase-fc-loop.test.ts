import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "./tool-registry";
import type { ToolCallResult } from "./types";
import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ChatVendorAdapter,
  HttpRequest,
  ProviderCapability,
  ToolCall,
  ToolExecutionResult,
  VendorConfig,
} from "./vendors/types";
import { runTwoPhaseFcLoop } from "./two-phase-fc-loop";

const TEST_CAPABILITY: ProviderCapability = {
  id: "test",
  displayName: "test",
  transport: "openai",
  baseUrl: "https://test/",
  authStyle: "bearer",
  defaultModel: "m",
  supportsTools: true,
  supportsThinking: false,
  thinkingField: null,
  cacheStrategy: "none",
  testStrategy: "text",
  supportsVision: false,
};

/**
 * 极简 fake adapter —— 不发真 HTTP 请求，按 sequence 里的脚本返回响应。
 */
class FakeAdapter implements ChatVendorAdapter {
  readonly id = "fake";
  readonly transport = "openai" as const;
  capability: ProviderCapability = TEST_CAPABILITY;

  /** 控制台返回的脚本：每次 fetch 调用消耗一个 script 元素。 */
  private scripts: Array<
    | { kind: "text"; text: string }
    | { kind: "tool"; toolCalls: ToolCall[] }
    | { kind: "error"; message: string }
  > = [];
  private callIndex = 0;
  /** 记录所有发出的请求体，便于断言。 */
  readonly requests: ChatRequest[] = [];
  /** 记录每次请求携带的 cfg，便于断言分阶段 reasoning。 */
  readonly configs: VendorConfig[] = [];

  enqueueText(text: string) {
    this.scripts.push({ kind: "text", text });
  }
  enqueueToolCalls(toolCalls: ToolCall[]) {
    this.scripts.push({ kind: "tool", toolCalls });
  }
  enqueueError(message: string) {
    this.scripts.push({ kind: "error", message });
  }

  buildRequest(req: ChatRequest, cfg: VendorConfig): HttpRequest {
    this.requests.push(req);
    this.configs.push(cfg);
    return {
      url: "https://fake/",
      method: "POST",
      headers: {},
      body: JSON.stringify({}),
    };
  }
  parseResponse(raw: unknown): ChatResponse {
    const script = this.scripts[this.callIndex++];
    if (!script) throw new Error("FakeAdapter: no script enqueued for call " + this.callIndex);
    if (script.kind === "error") throw new Error(script.message);

    const text = script.kind === "text" ? script.text : "";
    const toolCalls = script.kind === "tool" ? script.toolCalls : [];

    return {
      assistantMessage: {
        role: "assistant",
        ...(text ? { content: text } : {}),
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      },
      text,
      toolCalls,
      finishReason: toolCalls.length > 0 ? "tool_calls" : "stop",
      raw: {},
    };
  }
  appendToolResults(messages: ChatMessage[], results: ToolExecutionResult[]): ChatMessage[] {
    const next = messages.slice();
    for (const r of results) {
      next.push({
        role: "tool",
        toolCallId: r.toolCall.id,
        name: r.toolCall.name,
        content: r.output,
      });
    }
    return next;
  }
  buildStreamRequest(req: ChatRequest, cfg: VendorConfig): HttpRequest {
    return this.buildRequest({ ...req, stream: true }, cfg);
  }
  parseStreamEvent(): null {
    return null;
  }
  async testConnection() {
    return { ok: true, latency: 0 };
  }
}

function makeTool(id: string, enabled = true): ToolDefinition {
  return {
    id,
    name: id,
    description: id,
    enabled,
    inputSchema: { type: "object", properties: {} },
    execute: async () => "ok",
  };
}

const baseMessages: ChatMessage[] = [
  { role: "user", content: "你好" },
];

const baseOptions = {
  messages: baseMessages,
  tools: [makeTool("weather")],
  toolSystemContent: "TOOL_SYSTEM",
  soulSystemBaseContent: "SOUL_SYSTEM_BASE",
  timeoutMs: 30_000,
};

beforeEach(() => {
  // 默认 fetch stub：如果 fake adapter 返回了正常响应，这里不会真发请求
  // （adapter 的 buildRequest 不真发请求）。但 runTwoPhaseFcLoop 内部仍走 fetch。
  globalThis.fetch = vi.fn(async () => {
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runTwoPhaseFcLoop", () => {
  it("aborts an in-flight tool-phase model fetch with the outer signal", async () => {
    const adapter = new FakeAdapter();
    const controller = new AbortController();
    const executeTool = vi.fn().mockResolvedValue("should not run");
    globalThis.fetch = vi.fn((_url, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal as AbortSignal;
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    })) as unknown as typeof fetch;

    const run = runTwoPhaseFcLoop({
      ...baseOptions,
      settings: { provider: "test", baseUrl: "https://test", model: "m", apiKey: "k" },
      adapter,
      executeTool,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledOnce());
    controller.abort();

    await expect(run).rejects.toThrow(/E_RUN_CANCELLED/);
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("does not turn cancellation during Soul fetch into a fallback reply", async () => {
    const adapter = new FakeAdapter();
    adapter.enqueueText("switch to soul");
    const controller = new AbortController();
    const emitted: string[] = [];
    let calls = 0;
    globalThis.fetch = vi.fn((_url, init) => {
      calls += 1;
      if (calls === 1) return Promise.resolve(new Response("{}", { status: 200 }));
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal as AbortSignal;
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    }) as unknown as typeof fetch;

    const run = runTwoPhaseFcLoop({
      ...baseOptions,
      settings: { provider: "test", baseUrl: "https://test", model: "m", apiKey: "k" },
      adapter,
      executeTool: async () => "ok",
      signal: controller.signal,
      onEvent: (event) => emitted.push(event.type),
    });
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(2));
    controller.abort();

    await expect(run).rejects.toThrow(/E_RUN_CANCELLED/);
    expect(emitted).not.toContain("text_message_start");
  });

  it("passes an explicit required tool choice only to the first tool-phase request", async () => {
    const adapter = new FakeAdapter();
    adapter.enqueueText("模型仍未调用工具");
    adapter.enqueueText("最终回复");

    await runTwoPhaseFcLoop({
      ...baseOptions,
      requiredToolName: "weather",
      settings: { provider: "test", baseUrl: "https://test", model: "m", apiKey: "k" },
      adapter,
      executeTool: async () => "ok",
    });

    expect(adapter.requests[0].toolChoice).toEqual({ name: "weather" });
    expect(adapter.requests[1].toolChoice).toBeUndefined();
  });

  it("模型无 tool_calls → 切 SOUL_PHASE，工具阶段自由文本不写入 conversation", async () => {
    const adapter = new FakeAdapter();
    // TOOL_PHASE: 模型生成自由文本（这个文本不应进入 soul 的 conversation）
    adapter.enqueueText("UNSEEN_TOOL_TEXT");
    // SOUL_PHASE: 模型返回最终回复
    adapter.enqueueText("最终面向用户的回复");

    const executeToolCalls: ToolCall[] = [];
    const events: string[] = [];

    const result = await runTwoPhaseFcLoop({
      ...baseOptions,
      settings: {
        provider: "test",
        baseUrl: "https://test",
        model: "m",
        apiKey: "k",
      },
      adapter,
      executeTool: async (tc) => {
        executeToolCalls.push(tc);
        return "tool output";
      },
      onEvent: (e) => events.push(e.type),
    });

    expect(result.reply).toBe("最终面向用户的回复");
    expect(result.soulPhaseReason).toBe("no_tool");
    expect(executeToolCalls).toHaveLength(0);

    // 第一个请求用 tool_system，第二个请求用 soul_systemBase
    expect(adapter.requests).toHaveLength(2);
    const toolReq = adapter.requests[0];
    const soulReq = adapter.requests[1];

    // tool 阶段 system
    expect(toolReq.messages[0].role).toBe("system");
    expect(toolReq.messages[0].content).toBe("TOOL_SYSTEM");
    expect(toolReq.tools).toBeDefined();
    expect(toolReq.tools!.length).toBeGreaterThan(0);

    // soul 阶段 system
    expect(soulReq.messages[0].role).toBe("system");
    expect(soulReq.messages[0].content).toBe("SOUL_SYSTEM_BASE");
    // soul 阶段不携带 tools
    expect(soulReq.tools).toBeUndefined();

    // 关键：工具阶段的 UNSEEN_TOOL_TEXT 不进入 soul 的 conversation
    // soul request 的所有 messages 拼接起来不应该出现 UNSEEN_TOOL_TEXT
    const allSoulContent = soulReq.messages
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n");
    expect(allSoulContent).not.toContain("UNSEEN_TOOL_TEXT");

    // 未传 soulTailAnchorContent 时，soul 请求末尾不追加 system 锚点
    expect(soulReq.messages[soulReq.messages.length - 1].role).not.toBe("system");
  });

  it("soulTailAnchorContent 作为独立 system 消息追加在 conversation 之后", async () => {
    const adapter = new FakeAdapter();
    // TOOL_PHASE: 无 tool_calls → 切 SOUL_PHASE
    adapter.enqueueText("");
    // SOUL_PHASE
    adapter.enqueueText("最终回复");

    await runTwoPhaseFcLoop({
      ...baseOptions,
      soulTailAnchorContent: "TAIL_ANCHOR_MARKER",
      settings: { provider: "test", baseUrl: "https://test", model: "m", apiKey: "k" },
      adapter,
      executeTool: async () => "ok",
    });

    expect(adapter.requests).toHaveLength(2);
    const soulReq = adapter.requests[1];

    // 首条仍是 soul 阶段基础 system
    expect(soulReq.messages[0].role).toBe("system");
    expect(soulReq.messages[0].content).toBe("SOUL_SYSTEM_BASE");

    // 锚点是最后一条消息，且位于对话消息（user）之后
    const last = soulReq.messages[soulReq.messages.length - 1];
    expect(last.role).toBe("system");
    expect(last.content).toBe("TAIL_ANCHOR_MARKER");
    expect(soulReq.messages[soulReq.messages.length - 2].role).toBe("user");

    // tool 阶段请求不受锚点影响
    const toolReq = adapter.requests[0];
    const toolContents = toolReq.messages
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n");
    expect(toolContents).not.toContain("TAIL_ANCHOR_MARKER");
  });

  it("工具阶段：模型调用工具 → 执行 → 继续 TOOL_PHASE", async () => {
    const adapter = new FakeAdapter();
    // 第 1 轮：模型调工具
    adapter.enqueueToolCalls([
      { id: "tc-1", name: "weather", arguments: '{"city":"北京"}' },
    ]);
    // 第 2 轮：模型不调工具（自由文本）→ 切 SOUL_PHASE
    adapter.enqueueText("");
    // SOUL_PHASE
    adapter.enqueueText("北京今天 25 度");

    const executeResults: string[] = [];

    const result = await runTwoPhaseFcLoop({
      ...baseOptions,
      settings: {
        provider: "test",
        baseUrl: "https://test",
        model: "m",
        apiKey: "k",
      },
      adapter,
      executeTool: async (tc) => {
        executeResults.push(tc.name);
        return "北京：晴 25°C";
      },
    });

    expect(executeResults).toEqual(["weather"]);
    expect(result.reply).toBe("北京今天 25 度");
    expect(result.soulPhaseReason).toBe("no_tool");

    // 3 个请求：2 个 tool 阶段 + 1 个 soul 阶段
    expect(adapter.requests.length).toBeGreaterThanOrEqual(3);
    // soul 阶段不带 tools
    const soulReq = adapter.requests[adapter.requests.length - 1];
    expect(soulReq.tools).toBeUndefined();
    // soul 阶段 system 是 soul base
    expect(soulReq.messages[0].content).toBe("SOUL_SYSTEM_BASE");
  });

  it("纯聊天场景：tool 阶段 no_tool → soul 阶段回复", async () => {
    const adapter = new FakeAdapter();
    adapter.enqueueText(""); // tool 阶段：模型没调工具（自由文本忽略）
    adapter.enqueueText("hi 朋友～");

    const result = await runTwoPhaseFcLoop({
      ...baseOptions,
      settings: {
        provider: "test",
        baseUrl: "https://test",
        model: "m",
        apiKey: "k",
      },
      adapter,
      executeTool: async () => {
        throw new Error("executeTool 不应在纯聊天时被调用");
      },
    });

    expect(result.reply).toBe("hi 朋友～");
    expect(result.soulPhaseReason).toBe("no_tool");
    expect(result.toolResults).toHaveLength(0);
  });

  it("达到 maxToolRounds → SOUL_PHASE 强制总结", async () => {
    const adapter = new FakeAdapter();
    // 永远调工具，直到达到上限
    for (let i = 0; i < 3; i++) {
      adapter.enqueueToolCalls([
        { id: `tc-${i}`, name: "weather", arguments: "{}" },
      ]);
    }
    // soul 阶段
    adapter.enqueueText("抱歉，已经循环太多次了");

    const result = await runTwoPhaseFcLoop({
      ...baseOptions,
      settings: {
        provider: "test",
        baseUrl: "https://test",
        model: "m",
        apiKey: "k",
      },
      adapter,
      maxToolRounds: 3,
      executeTool: async () => "tool output",
    });

    expect(result.soulPhaseReason).toBe("max_rounds");
    expect(result.reply).toBe("抱歉，已经循环太多次了");
  });

  it("工具执行异常不影响主流程，结果带 [工具执行失败] 前缀", async () => {
    const adapter = new FakeAdapter();
    adapter.enqueueToolCalls([
      { id: "tc-1", name: "weather", arguments: "{}" },
    ]);
    adapter.enqueueText(""); // tool 阶段：不再调
    adapter.enqueueText("出错了但我继续");

    const result = await runTwoPhaseFcLoop({
      ...baseOptions,
      settings: {
        provider: "test",
        baseUrl: "https://test",
        model: "m",
        apiKey: "k",
      },
      adapter,
      executeTool: async () => {
        throw new Error("boom");
      },
    });

    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults[0].output).toContain("[工具执行失败]");
    expect(result.reply).toBe("出错了但我继续");
  });

  it("Soul 阶段不重复注入同一份工具结果（依赖 conversation 中的 tool 消息）", async () => {
    const adapter = new FakeAdapter();
    adapter.enqueueToolCalls([
      { id: "tc-1", name: "weather", arguments: "{}" },
    ]);
    adapter.enqueueText("");
    adapter.enqueueText("北京 25 度");

    // 不传 buildSoulToolResultsSummary：默认应该是空字符串
    await runTwoPhaseFcLoop({
      ...baseOptions,
      settings: {
        provider: "test",
        baseUrl: "https://test",
        model: "m",
        apiKey: "k",
      },
      adapter,
      executeTool: async () => "北京：晴 25°C",
      // 不传 buildSoulToolResultsSummary，默认应该是空字符串
    });

    // 第一期：默认 buildSoulToolResultsSummary 是空，soul system 不含具体工具结果
    // 调用方可以选择注入摘要，但默认不重复 conversation 已有的 tool 消息
    const soulReq = adapter.requests[adapter.requests.length - 1];
    const sysContent = String(soulReq.messages[0].content);
    expect(sysContent).toBe("SOUL_SYSTEM_BASE");
  });

  it("buildSoulToolResultsSummary 非空时，会追加到 soul system 末尾", async () => {
    const adapter = new FakeAdapter();
    adapter.enqueueToolCalls([
      { id: "tc-1", name: "weather", arguments: "{}" },
    ]);
    adapter.enqueueText("");
    adapter.enqueueText("北京 25 度");

    await runTwoPhaseFcLoop({
      ...baseOptions,
      settings: {
        provider: "test",
        baseUrl: "https://test",
        model: "m",
        apiKey: "k",
      },
      adapter,
      executeTool: async () => "北京：晴 25°C",
      buildSoulToolResultsSummary: () => "工具摘要：天气查询成功",
    });

    const soulReq = adapter.requests[adapter.requests.length - 1];
    const sysContent = String(soulReq.messages[0].content);
    expect(sysContent).toContain("SOUL_SYSTEM_BASE");
    expect(sysContent).toContain("工具摘要：天气查询成功");
  });

  it("tool 阶段自由文本绝不能发给用户（不进入 reply）", async () => {
    const adapter = new FakeAdapter();
    // 工具阶段模型返回了一段看起来很完整的文本
    adapter.enqueueText("这是工具阶段的文本，绝对不能泄露给用户");
    adapter.enqueueText("这是 soul 阶段的正式回复");

    const result = await runTwoPhaseFcLoop({
      ...baseOptions,
      settings: {
        provider: "test",
        baseUrl: "https://test",
        model: "m",
        apiKey: "k",
      },
      adapter,
      executeTool: async () => {
        throw new Error("不应调用");
      },
    });

    expect(result.reply).not.toContain("工具阶段的文本");
    expect(result.reply).toBe("这是 soul 阶段的正式回复");
  });

  it("strips leaked leading chat timestamp metadata before emitting and returning reply", async () => {
    const adapter = new FakeAdapter();
    adapter.enqueueText("");
    adapter.enqueueText("[2026-07-13 13:36, Asia/Shanghai]\n怎么啦，看起来不太高兴的样子…");

    let streamed = "";
    const result = await runTwoPhaseFcLoop({
      ...baseOptions,
      settings: {
        provider: "test",
        baseUrl: "https://test",
        model: "m",
        apiKey: "k",
      },
      adapter,
      executeTool: async () => {
        throw new Error("不应调用");
      },
      onEvent: (event) => {
        if (event.type === "text_message_content") streamed += event.delta;
      },
    });

    expect(result.reply).toBe("怎么啦，看起来不太高兴的样子…");
    expect(streamed).toBe("怎么啦，看起来不太高兴的样子…");
  });

  it("分阶段 reasoning：TOOL_PHASE 强制 off，SOUL_PHASE 沿用用户设置", async () => {
    const adapter = new FakeAdapter();
    // 第 1 轮：调工具；第 2 轮：不调 → 切 SOUL_PHASE
    adapter.enqueueToolCalls([{ id: "tc-1", name: "weather", arguments: "{}" }]);
    adapter.enqueueText("");
    adapter.enqueueText("最终回复");

    await runTwoPhaseFcLoop({
      ...baseOptions,
      settings: {
        provider: "test",
        baseUrl: "https://test",
        model: "m",
        apiKey: "k",
        reasoning: { mode: "on", effort: "high" },
      },
      adapter,
      executeTool: async () => "ok",
    });

    expect(adapter.configs).toHaveLength(3);
    // 两轮 TOOL_PHASE：reasoning 被强制覆盖为 off
    expect(adapter.configs[0].reasoning).toEqual({ mode: "off" });
    expect(adapter.configs[1].reasoning).toEqual({ mode: "off" });
    // SOUL_PHASE：透传用户设置里的偏好，不被工具阶段的覆盖污染
    expect(adapter.configs[2].reasoning).toEqual({ mode: "on", effort: "high" });
  });

  it("分阶段 reasoning：用户未设置 reasoning 时，SOUL_PHASE 保持缺省（auto 语义）", async () => {
    const adapter = new FakeAdapter();
    adapter.enqueueText("");
    adapter.enqueueText("最终回复");

    await runTwoPhaseFcLoop({
      ...baseOptions,
      settings: { provider: "test", baseUrl: "https://test", model: "m", apiKey: "k" },
      adapter,
      executeTool: async () => "ok",
    });

    expect(adapter.configs).toHaveLength(2);
    expect(adapter.configs[0].reasoning).toEqual({ mode: "off" });
    expect(adapter.configs[1].reasoning).toBeUndefined();
  });
});
