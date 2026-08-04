import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "./tool-registry";
import type { ToolCallResult } from "./types";
import { AgentRuntimeError } from "./agent-runtime-error";
import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ChatVendorAdapter,
  HttpRequest,
  ProviderCapability,
  ToolCall,
  ToolExecutionResult,
} from "./vendors/types";
import { runTwoPhaseFcLoop } from "./two-phase-fc-loop";
import type { SdkStreamRunInput } from "./vendors/sdk-stream/runtime";
import type { UnifiedStreamDelta } from "./vendors/sdk-stream/types";

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

  enqueueText(text: string) {
    this.scripts.push({ kind: "text", text });
  }
  enqueueToolCalls(toolCalls: ToolCall[]) {
    this.scripts.push({ kind: "tool", toolCalls });
  }
  enqueueError(message: string) {
    this.scripts.push({ kind: "error", message });
  }

  buildRequest(req: ChatRequest): HttpRequest {
    this.requests.push(req);
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
  buildStreamRequest(req: ChatRequest): HttpRequest {
    return this.buildRequest({ ...req, stream: true });
  }
  parseStreamEvent(): null {
    return null;
  }
  async testConnection() {
    return { ok: true, latency: 0 };
  }
}

async function fakeStreamChat(input: SdkStreamRunInput): Promise<ChatResponse> {
  input.adapter.buildStreamRequest(input.request, input.config);
  const response = input.adapter.parseResponse({});
  if (response.thinking) input.onDelta?.({ type: "reasoning_delta", delta: response.thinking });
  if (response.text) input.onDelta?.({ type: "text_delta", delta: response.text });
  response.toolCalls.forEach((toolCall, index) => {
    input.onDelta?.({ type: "tool_call_start", index, id: toolCall.id, nameDelta: toolCall.name });
    input.onDelta?.({ type: "tool_call_arguments_delta", index, id: toolCall.id, delta: toolCall.arguments });
    input.onDelta?.({ type: "tool_call_end", index, id: toolCall.id });
  });
  if (response.usage) {
    input.onDelta?.({
      type: "usage",
      inputTokens: response.usage.input,
      outputTokens: response.usage.output,
    });
  }
  input.onDelta?.({ type: "finish", reason: response.finishReason });
  return response;
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
  streamChat: fakeStreamChat,
};

beforeEach(() => {
  globalThis.fetch = vi.fn(async () => {
    throw new Error("WorkLoop tests must not access the network");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runTwoPhaseFcLoop", () => {
  it("forwards reasoning deltas before the model call resolves and closes once", async () => {
    const adapter = new FakeAdapter();
    const events: Array<{ type: string; delta?: string }> = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const streamChat = async (input: SdkStreamRunInput): Promise<ChatResponse> => {
      input.onDelta?.({ type: "reasoning_delta", delta: "先分析" });
      input.onDelta?.({ type: "reasoning_delta", delta: "再核对" });
      input.onDelta?.({ type: "text_delta", delta: "完成" });
      markStarted?.();
      await gate;
      return {
        assistantMessage: { role: "assistant", content: "完成", thinking: "先分析再核对" },
        text: "完成",
        thinking: "先分析再核对",
        toolCalls: [],
        finishReason: "stop",
        raw: {},
      };
    };

    const pending = runTwoPhaseFcLoop({
      ...baseOptions,
      optimizeFirstRound: true,
      settings: { provider: "test", baseUrl: "https://test", model: "m", apiKey: "k", contextWindowTokens: 256000 },
      adapter,
      streamChat,
      executeTool: async () => "unused",
      onEvent: (event) => events.push(event),
    });

    await started;
    expect(events.filter((event) => event.type.startsWith("reasoning_message"))).toEqual([
      expect.objectContaining({ type: "reasoning_message_start" }),
      { type: "reasoning_message_content", messageId: expect.any(String), delta: "先分析" },
      { type: "reasoning_message_content", messageId: expect.any(String), delta: "再核对" },
    ]);
    release?.();
    await pending;
    expect(events.filter((event) => event.type === "reasoning_message_end")).toHaveLength(1);
  });

  it("streams Soul text before terminal reconciliation resolves", async () => {
    const adapter = new FakeAdapter();
    const events: Array<{ type: string; delta?: string }> = [];
    let call = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markSoulStarted: (() => void) | undefined;
    const soulStarted = new Promise<void>((resolve) => {
      markSoulStarted = resolve;
    });
    const streamChat = async (input: SdkStreamRunInput): Promise<ChatResponse> => {
      call += 1;
      if (call === 1) {
        return {
          assistantMessage: { role: "assistant", content: "hidden" },
          text: "hidden",
          toolCalls: [],
          finishReason: "stop",
          raw: {},
        };
      }
      input.onDelta?.({ type: "text_delta", delta: "实时" });
      input.onDelta?.({ type: "text_delta", delta: "回复" });
      markSoulStarted?.();
      await gate;
      return {
        assistantMessage: { role: "assistant", content: "实时回复" },
        text: "实时回复",
        toolCalls: [],
        finishReason: "stop",
        raw: {},
      };
    };

    const pending = runTwoPhaseFcLoop({
      ...baseOptions,
      settings: { provider: "test", baseUrl: "https://test", model: "m", apiKey: "k", contextWindowTokens: 256000 },
      adapter,
      streamChat,
      executeTool: async () => "unused",
      onEvent: (event) => events.push(event),
    });

    await soulStarted;
    expect(events.filter((event) => event.type.startsWith("text_message"))).toEqual([
      expect.objectContaining({ type: "text_message_start" }),
      { type: "text_message_content", messageId: expect.any(String), delta: "实时" },
      { type: "text_message_content", messageId: expect.any(String), delta: "回复" },
    ]);
    release?.();
    const result = await pending;
    expect(result.reply).toBe("实时回复");
    expect(events.filter((event) => event.type === "text_message_end")).toHaveLength(1);
  });

  it("does not leak a leading chat timestamp when it is split across deltas", async () => {
    const adapter = new FakeAdapter();
    let call = 0;
    let streamed = "";
    const streamChat = async (input: SdkStreamRunInput): Promise<ChatResponse> => {
      call += 1;
      if (call === 1) {
        return {
          assistantMessage: { role: "assistant" },
          text: "",
          toolCalls: [],
          finishReason: "stop",
          raw: {},
        };
      }
      for (const delta of ["[", "2026-07-13 13:36, Asia/", "Shanghai]\n", "干净回复"]) {
        input.onDelta?.({ type: "text_delta", delta });
      }
      return {
        assistantMessage: { role: "assistant", content: "[2026-07-13 13:36, Asia/Shanghai]\n干净回复" },
        text: "[2026-07-13 13:36, Asia/Shanghai]\n干净回复",
        toolCalls: [],
        finishReason: "stop",
        raw: {},
      };
    };

    const result = await runTwoPhaseFcLoop({
      ...baseOptions,
      settings: { provider: "test", baseUrl: "https://test", model: "m", apiKey: "k", contextWindowTokens: 256000 },
      adapter,
      streamChat,
      executeTool: async () => "unused",
      onEvent: (event) => {
        if (event.type === "text_message_content") streamed += event.delta;
      },
    });

    expect(result.reply).toBe("干净回复");
    expect(streamed).toBe("干净回复");
  });

  it("falls back to Soul when an optimized first round has no tool calls or text", async () => {
    const adapter = new FakeAdapter();
    let calls = 0;
    const streamChat = async (): Promise<ChatResponse> => {
      calls += 1;
      const text = calls === 1 ? "" : "Soul fallback";
      return {
        assistantMessage: { role: "assistant", ...(text ? { content: text } : {}) },
        text,
        toolCalls: [],
        finishReason: "stop",
        raw: {},
      };
    };

    const result = await runTwoPhaseFcLoop({
      ...baseOptions,
      optimizeFirstRound: true,
      settings: { provider: "test", baseUrl: "https://test", model: "m", apiKey: "k", contextWindowTokens: 256000 },
      adapter,
      streamChat,
      executeTool: async () => "unused",
    });

    expect(calls).toBe(2);
    expect(result.reply).toBe("Soul fallback");
  });

  it("emits streamed tool lifecycle once before execution result", async () => {
    const adapter = new FakeAdapter();
    const events: Array<{ type: string; toolCallId?: string; delta?: string }> = [];
    let call = 0;
    const streamChat = async (input: SdkStreamRunInput): Promise<ChatResponse> => {
      call += 1;
      if (call === 1) {
        const deltas: UnifiedStreamDelta[] = [
          { type: "tool_call_start", index: 0, id: "call-1", nameDelta: "wea" },
          { type: "tool_call_start", index: 0, id: "call-1", nameDelta: "ther" },
          { type: "tool_call_arguments_delta", index: 0, id: "call-1", delta: "{\"city\":" },
          { type: "tool_call_arguments_delta", index: 0, id: "call-1", delta: "\"北京\"}" },
          { type: "tool_call_end", index: 0, id: "call-1" },
        ];
        deltas.forEach((delta) => input.onDelta?.(delta));
        return {
          assistantMessage: {
            role: "assistant",
            toolCalls: [{ id: "call-1", name: "weather", arguments: "{\"city\":\"北京\"}" }],
          },
          text: "",
          toolCalls: [{ id: "call-1", name: "weather", arguments: "{\"city\":\"北京\"}" }],
          finishReason: "tool_calls",
          raw: {},
        };
      }
      const text = call === 2 ? "" : "查好了";
      if (text) input.onDelta?.({ type: "text_delta", delta: text });
      return {
        assistantMessage: { role: "assistant", ...(text ? { content: text } : {}) },
        text,
        toolCalls: [],
        finishReason: "stop",
        raw: {},
      };
    };

    await runTwoPhaseFcLoop({
      ...baseOptions,
      settings: { provider: "test", baseUrl: "https://test", model: "m", apiKey: "k", contextWindowTokens: 256000 },
      adapter,
      streamChat,
      executeTool: async () => "晴",
      onEvent: (event) => events.push(event),
    });

    expect(events.filter((event) => event.toolCallId === "call-1").map((event) => event.type)).toEqual([
      "tool_call_start",
      "tool_call_args",
      "tool_call_args",
      "tool_call_end",
      "tool_call_result",
    ]);
  });

  it("counts SDK timeout errors but preserves caller cancellation", async () => {
    const adapter = new FakeAdapter();
    let calls = 0;
    const timeoutThenSoul = async (input: SdkStreamRunInput): Promise<ChatResponse> => {
      calls += 1;
      if (calls <= 2) throw new AgentRuntimeError("E_MODEL_REQUEST_TIMEOUT", "timeout");
      input.onDelta?.({ type: "text_delta", delta: "超时后总结" });
      return {
        assistantMessage: { role: "assistant", content: "超时后总结" },
        text: "超时后总结",
        toolCalls: [],
        finishReason: "stop",
        raw: {},
      };
    };

    const timeoutResult = await runTwoPhaseFcLoop({
      ...baseOptions,
      settings: { provider: "test", baseUrl: "https://test", model: "m", apiKey: "k", contextWindowTokens: 256000 },
      adapter,
      streamChat: timeoutThenSoul,
      maxConsecutiveTimeouts: 2,
      executeTool: async () => "unused",
    });
    expect(timeoutResult.reply).toBe("超时后总结");
    expect(timeoutResult.soulPhaseReason).toBe("timeout");
    expect(calls).toBe(3);

    const caller = new AbortController();
    const cancelled = new DOMException("cancelled", "AbortError");
    const cancelStream = async (): Promise<ChatResponse> => {
      caller.abort(cancelled);
      throw cancelled;
    };
    await expect(runTwoPhaseFcLoop({
      ...baseOptions,
      settings: { provider: "test", baseUrl: "https://test", model: "m", apiKey: "k", contextWindowTokens: 256000 },
      adapter,
      streamChat: cancelStream,
      signal: caller.signal,
      executeTool: async () => "unused",
    })).rejects.toBe(cancelled);
  });
  it("executes only model-authored tool calls", async () => {
    const adapter = new FakeAdapter();
    adapter.enqueueToolCalls([{ id: "call-1", name: "music_search", arguments: JSON.stringify({ keyword: "左转灯" }) }]);
    adapter.enqueueText("工具阶段结束");
    adapter.enqueueText("已经找到真实结果");
    const executed: ToolCall[] = [];

    await runTwoPhaseFcLoop({
      ...baseOptions,
      tools: [makeTool("music_search")],
      settings: { provider: "test", baseUrl: "https://test", model: "m", apiKey: "k", contextWindowTokens: 256000 },
      adapter,
      executeTool: async (toolCall) => {
        executed.push(toolCall);
        return JSON.stringify({ kind: "search", set: { tracks: [{ id: "1", name: "左转灯" }] } });
      },
    });

    expect(JSON.parse(executed[0].arguments)).toEqual({ keyword: "左转灯" });
    expect(adapter.requests[0].messages.some((message) => message.role === "tool")).toBe(false);
    expect(adapter.requests[1].messages.some((message) => message.role === "tool")).toBe(true);
    expect(adapter.requests[0].toolChoiceIntent).toBeUndefined();
  });

  it("never forces a tool choice before the model decides", async () => {
    const adapter = new FakeAdapter();
    adapter.enqueueText("模型仍未调用工具");
    adapter.enqueueText("最终回复");

    await runTwoPhaseFcLoop({
      ...baseOptions,
      settings: { provider: "test", baseUrl: "https://test", model: "m", apiKey: "k", contextWindowTokens: 256000 },
      adapter,
      executeTool: async () => "ok",
    });

    expect(adapter.requests[0].toolChoiceIntent).toBeUndefined();
    expect(adapter.requests[1].toolChoiceIntent).toBeUndefined();
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
        contextWindowTokens: 256000,
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
    expect(String(soulReq.messages[0].content)).toContain("SOUL_SYSTEM_BASE");
    expect(String(soulReq.messages[0].content)).toContain('"actions":[]');
    // soul 阶段不携带 tools
    expect(soulReq.tools).toBeUndefined();

    // 关键：工具阶段的 UNSEEN_TOOL_TEXT 不进入 soul 的 conversation
    // soul request 的所有 messages 拼接起来不应该出现 UNSEEN_TOOL_TEXT
    const allSoulContent = soulReq.messages
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n");
    expect(allSoulContent).not.toContain("UNSEEN_TOOL_TEXT");
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
        contextWindowTokens: 256000,
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
    // soul 阶段 system 同时包含 soul base 与本轮执行事实
    expect(String(soulReq.messages[0].content)).toContain("SOUL_SYSTEM_BASE");
    expect(String(soulReq.messages[0].content)).toContain('"executionStatus":"succeeded"');
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
        contextWindowTokens: 256000,
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
        contextWindowTokens: 256000,
      },
      adapter,
      maxToolRounds: 3,
      executeTool: async () => "tool output",
    });

    expect(result.soulPhaseReason).toBe("max_rounds");
    expect(result.reply).toBe("抱歉，已经循环太多次了");
  });

  it("工具执行异常不影响主流程，并记录结构化失败状态", async () => {
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
        contextWindowTokens: 256000,
      },
      adapter,
      executeTool: async () => {
        throw new Error("boom");
      },
    });

    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults[0]).toMatchObject({
      output: "boom",
      status: "failed",
      errorCode: "E_TOOL_EXECUTION_FAILED",
    });
    expect(result.reply).toBe("出错了但我继续");
  });

  it("preserves a structured runtime failure for the final Soul call", async () => {
    const adapter = new FakeAdapter();
    adapter.enqueueToolCalls([{ id: "play-1", name: "music_play_track", arguments: "{\"candidateRef\":\"ctx_missing\"}" }]);
    adapter.enqueueText("");
    adapter.enqueueText("这次请求没有成功，我再确认一下目标。");

    const result = await runTwoPhaseFcLoop({
      ...baseOptions,
      tools: [makeTool("music_play_track")],
      settings: { provider: "test", baseUrl: "https://test", model: "m", apiKey: "k", contextWindowTokens: 256000 },
      adapter,
      executeTool: async () => ({
        status: "failed" as const,
        output: "E_CONTEXT_REF_NOT_FOUND",
        errorCode: "E_CONTEXT_REF_NOT_FOUND",
      }),
    });

    expect(result.toolResults[0]).toMatchObject({
      toolId: "music_play_track",
      status: "failed",
      errorCode: "E_CONTEXT_REF_NOT_FOUND",
    });
    const sysContent = String(adapter.requests.at(-1)!.messages[0].content);
    expect(sysContent).toContain('"executionStatus":"failed"');
    expect(sysContent).toContain('"errorCode":"E_CONTEXT_REF_NOT_FOUND"');
  });

  it("emits a concise structured tool execution trace", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const adapter = new FakeAdapter();
      adapter.enqueueToolCalls([{ id: "play-1", name: "music_play_track", arguments: "{}" }]);
      adapter.enqueueText("");
      adapter.enqueueText("没有执行成功。");

      await runTwoPhaseFcLoop({
        ...baseOptions,
        tools: [makeTool("music_play_track")],
        settings: { provider: "test", baseUrl: "https://test", model: "m", apiKey: "k", contextWindowTokens: 256000 },
        adapter,
        executeTool: async () => ({
          status: "failed",
          output: "E_CONTEXT_REF_NOT_FOUND",
          errorCode: "E_CONTEXT_REF_NOT_FOUND",
        }),
      });

      const lines = log.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(lines).toContain("[ToolExecution/Trace] tool=music_play_track status=failed errorCode=E_CONTEXT_REF_NOT_FOUND");
    } finally {
      log.mockRestore();
    }
  });

  it("Soul 阶段同时保留 tool 消息并注入本轮权威执行上下文", async () => {
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
        contextWindowTokens: 256000,
      },
      adapter,
      executeTool: async () => "北京：晴 25°C",
    });

    const soulReq = adapter.requests[adapter.requests.length - 1];
    const sysContent = String(soulReq.messages[0].content);
    expect(sysContent).toContain("SOUL_SYSTEM_BASE");
    expect(sysContent).toContain("[SOUL_EXECUTION_CONTEXT]");
    expect(sysContent).toContain('"executionStatus":"succeeded"');
    expect(sysContent).not.toContain('"toolId"');
    expect(soulReq.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "tool", name: "weather", content: "北京：晴 25°C" }),
    ]));
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
        contextWindowTokens: 256000,
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
        contextWindowTokens: 256000,
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
        contextWindowTokens: 256000,
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

  it("never emits MiniMax textual tool-call protocol from the Soul phase", async () => {
    const adapter = new FakeAdapter();
    adapter.enqueueText("");
    adapter.enqueueText("]<]minimax[>[<tool_call>\n]<]minimax[>[<invoke name=\"music_get_daily_recommendations\">]<]minimax[>[</invoke>\n]<]minimax[>[</tool_call>");

    let streamed = "";
    const result = await runTwoPhaseFcLoop({
      ...baseOptions,
      settings: { provider: "test", baseUrl: "https://test", model: "m", apiKey: "k", contextWindowTokens: 256000 },
      adapter,
      executeTool: async () => "ok",
      onEvent: (event) => {
        if (event.type === "text_message_content") streamed += event.delta;
      },
    });

    expect(result.reply).not.toContain("tool_call");
    expect(result.reply).not.toContain("minimax");
    expect(result.reply.trim().length).toBeGreaterThan(0);
    expect(streamed).toBe(result.reply);
  });

  it("replaces a leaked textual tool protocol with a generic retry message", async () => {
    const adapter = new FakeAdapter();
    adapter.enqueueToolCalls([{ id: "daily-1", name: "music_get_daily_recommendations", arguments: "{}" }]);
    adapter.enqueueText("");
    adapter.enqueueText("[tool_call]\nmusic_get_daily_recommendations\n[/tool_call]");

    const result = await runTwoPhaseFcLoop({
      ...baseOptions,
      tools: [makeTool("music_get_daily_recommendations")],
      settings: { provider: "test", baseUrl: "https://test", model: "m", apiKey: "k", contextWindowTokens: 256000 },
      adapter,
      executeTool: async () => JSON.stringify({
        kind: "recommendations",
        set: { tracks: [{ id: "1", name: "真实歌曲" }] },
        presentation: { cardRef: "cyrene:music:daily-1" },
      }),
    });

    expect(result.reply).toContain("没有生成正常回复")
    expect(result.reply).not.toContain("tool_call")
  });

  it("lets Soul generate the natural card reply from structured tool facts without fixed replacement", async () => {
    const adapter = new FakeAdapter();
    adapter.enqueueToolCalls([{ id: "daily-1", name: "music_get_daily_recommendations", arguments: "{}" }]);
    adapter.enqueueText("");
    adapter.enqueueText("今天的推荐已经整理好啦，看看卡片里有没有喜欢的♪");

    const result = await runTwoPhaseFcLoop({
      ...baseOptions,
      tools: [makeTool("music_get_daily_recommendations")],
      settings: { provider: "test", baseUrl: "https://test", model: "m", apiKey: "k", contextWindowTokens: 256000 },
      adapter,
      executeTool: async () => JSON.stringify({
        kind: "recommendations",
        context: {
          setRef: "ctx_set",
          source: "daily_recommendation",
          candidates: [{
            candidateRef: "ctx_song_1",
            position: 1,
            name: "最初的记忆",
            artists: ["徐佳莹"],
          }],
        },
        presentation: { presented: true },
      }),
    });

    expect(result.reply).toBe("今天的推荐已经整理好啦，看看卡片里有没有喜欢的♪");
    const soulReq = adapter.requests.at(-1)!;
    const sysContent = String(soulReq.messages[0].content);
    expect(sysContent).toContain('[SOUL_EXECUTION_CONTEXT]');
    expect(sysContent).toContain('"executionStatus":"succeeded"');
    expect(sysContent).not.toContain('"kind":"recommendations"');
  });

  it("tells Soul explicitly when no tool ran instead of using a reply regex", async () => {
    const adapter = new FakeAdapter();
    adapter.enqueueText("");
    adapter.enqueueText("正在为你播放♪");

    const result = await runTwoPhaseFcLoop({
      ...baseOptions,
      settings: { provider: "test", baseUrl: "https://test", model: "m", apiKey: "k", contextWindowTokens: 256000 },
      adapter,
      executeTool: async () => "ok",
    });

    expect(result.reply).toBe("正在为你播放♪");
    const sysContent = String(adapter.requests.at(-1)!.messages[0].content);
    expect(sysContent).toContain('"actions":[]');
  });

  it("provides dispatched playback as a runtime fact and leaves wording to Soul", async () => {
    const adapter = new FakeAdapter();
    adapter.enqueueToolCalls([{
      id: "play-1",
      name: "music_play_track",
      arguments: JSON.stringify({ provider: "netease-cloud-music", setId: "s1", trackId: "1" }),
    }]);
    adapter.enqueueText("");
    adapter.enqueueText("已经开始播放了♪");

    const result = await runTwoPhaseFcLoop({
      ...baseOptions,
      tools: [makeTool("music_play_track")],
      settings: { provider: "test", baseUrl: "https://test", model: "m", apiKey: "k", contextWindowTokens: 256000 },
      adapter,
      executeTool: async () => JSON.stringify({
        kind: "playback",
        dispatch: { state: "dispatched", resourceType: "song", resourceId: "1" },
      }),
    });

    expect(result.reply).toBe("已经开始播放了♪");
    const sysContent = String(adapter.requests.at(-1)!.messages[0].content);
    expect(sysContent).toContain('"executionStatus":"succeeded"');
    expect(sysContent).not.toContain('"toolId"');
    expect(sysContent).not.toContain('effect.state');
  });

  it("keeps style sampling out of tool requests and applies it to Soul only", async () => {
    const adapter = new FakeAdapter();
    adapter.enqueueText("");
    adapter.enqueueText("done");

    await runTwoPhaseFcLoop({
      ...baseOptions,
      settings: { provider: "test", baseUrl: "https://test", model: "m", apiKey: "k", contextWindowTokens: 256000 },
      adapter,
      soulSampling: { temperature: 0.9, frequencyPenalty: 0.2 },
      executeTool: async () => {
        throw new Error("不应调用");
      },
    });

    expect(adapter.requests).toHaveLength(2);
    expect(adapter.requests[0]).not.toHaveProperty("temperature");
    expect(adapter.requests[0]).not.toHaveProperty("frequencyPenalty");
    expect(adapter.requests[1]).toMatchObject({ temperature: 0.9, frequencyPenalty: 0.2 });
    expect(adapter.requests[1].tools).toBeUndefined();
  });
});
