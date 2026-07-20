import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runLangGraphAgentLoop } from "./langgraph-agent-loop";
import { ExecutionLedger } from "./execution-ledger";
import type { ToolDefinition } from "./tool-registry";
import type {
  ChatMessage, ChatRequest, ChatResponse, ChatVendorAdapter, HttpRequest,
  ProviderCapability, ToolCall, ToolExecutionResult,
} from "./vendors/types";

const capability: ProviderCapability = {
  id: "test", displayName: "test", transport: "openai", baseUrl: "https://test/",
  authStyle: "bearer", defaultModel: "m", supportsTools: true, supportsThinking: false,
  thinkingField: null, cacheStrategy: "none", testStrategy: "text", supportsVision: false,
};

class FakeAdapter implements ChatVendorAdapter {
  readonly id = "fake";
  readonly transport = "openai" as const;
  capability = capability;
  readonly requests: ChatRequest[] = [];
  private scripts: Array<{ text: string; toolCalls?: never } | { text?: never; toolCalls: ToolCall[] }> = [];
  private index = 0;

  enqueueText(text: string) { this.scripts.push({ text }); }
  enqueueJson(value: unknown) { this.enqueueText(JSON.stringify(value)); }
  enqueueToolCall(name: string, args: Record<string, unknown>, id = `call-${this.scripts.length + 1}`) {
    this.scripts.push({ toolCalls: [{ id, name, arguments: JSON.stringify(args) }] });
  }
  buildRequest(req: ChatRequest): HttpRequest {
    this.requests.push(req);
    return { url: "https://fake/", method: "POST", headers: {}, body: "{}" };
  }
  parseResponse(): ChatResponse {
    const script = this.scripts[this.index++];
    if (script === undefined) throw new Error("missing fake response");
    const text = script.text ?? "";
    const toolCalls = script.toolCalls ?? [];
    return {
      assistantMessage: { role: "assistant", content: text, ...(toolCalls.length ? { toolCalls } : {}) },
      text, toolCalls, finishReason: toolCalls.length ? "tool_calls" : "stop", raw: {},
    };
  }
  appendToolResults(messages: ChatMessage[], results: ToolExecutionResult[]): ChatMessage[] {
    return [...messages, ...results.map((result): ChatMessage => ({
      role: "tool", name: result.toolCall.name, toolCallId: result.toolCall.id, content: result.output,
    }))];
  }
  buildStreamRequest(req: ChatRequest) { return this.buildRequest(req); }
  parseStreamEvent(): null { return null; }
  async testConnection() { return { ok: true, latency: 0 }; }
}

function musicPlayTool(): ToolDefinition {
  return {
    id: "music_play_track", capability: "music.play_track", name: "播放歌曲",
    description: "播放可信歌曲候选", enabled: true,
    inputSchema: {
      type: "object", properties: { candidateRef: { type: "string" } }, required: ["candidateRef"],
    },
    controlledInput: { candidateRef: "context_ref" },
    execute: async () => "unused",
  };
}

function options(adapter: FakeAdapter, executeTool = vi.fn(async () => ({
  status: "succeeded" as const,
  output: JSON.stringify({ kind: "playback", dispatch: { state: "dispatched" } }),
}))) {
  return {
    settings: { provider: "test", baseUrl: "https://test", model: "m", apiKey: "k" },
    adapter,
    messages: [{ role: "user" as const, content: "播放第一首" }],
    tools: [musicPlayTool()],
    toolSystemContent: "TOOL_SYSTEM",
    soulSystemBaseContent: "SOUL_SYSTEM",
    originalQuery: "播放第一首",
    contextualizedQuery: "播放当前网易云日推第一首",
    citaContextBlock: "ctx_song_1",
    timeoutMs: 30_000,
    executeTool,
  };
}

beforeEach(() => {
  globalThis.fetch = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
});
afterEach(() => vi.restoreAllMocks());

describe("runLangGraphAgentLoop native Function Calling runtime", () => {
  it("decides an action, resolves one native ToolCall, then Runtime executes it", async () => {
    const adapter = new FakeAdapter();
    adapter.enqueueJson({ decision: "act", capability: "music.play_track", objective: "播放第一首", targetRefs: ["ctx_song_1"], afterSuccess: "respond" });
    adapter.enqueueToolCall("music_play_track", { candidateRef: "ctx_song_1" });
    // routeAfterTool 在工具成功后直接路由到 soul，不再调 Action Gate
    adapter.enqueueText("已向网易云发送播放请求。");
    const executeTool = vi.fn(async () => ({ status: "succeeded" as const, output: "{\"kind\":\"playback\"}" }));

    const result = await runLangGraphAgentLoop(options(adapter, executeTool));

    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(executeTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "music_play_track", arguments: '{"candidateRef":"ctx_song_1"}' }),
      expect.any(Set),
    );
    const nativeRequests = adapter.requests.filter((request) => request.tools !== undefined);
    expect(nativeRequests).toHaveLength(1);
    expect(nativeRequests[0]).toMatchObject({
      toolChoiceIntent: { mode: "must_call", toolName: "music_play_track" },
    });
    expect(result.reply).toBe("已向网易云发送播放请求。");
  });

  it("routes ask_user to Soul without executing a tool", async () => {
    const adapter = new FakeAdapter();
    adapter.enqueueJson({ decision: "ask_user", reason: "版本不明确", missingInformation: ["歌曲版本"] });
    adapter.enqueueText("你想听哪个版本？");
    const executeTool = vi.fn();

    const result = await runLangGraphAgentLoop(options(adapter, executeTool));

    expect(executeTool).not.toHaveBeenCalled();
    expect(result.reply).toBe("你想听哪个版本？");
  });

  it("repairs malformed Action Gate JSON once", async () => {
    const adapter = new FakeAdapter();
    adapter.enqueueText("我直接回复用户");
    adapter.enqueueJson({ decision: "respond" });
    adapter.enqueueText("好的。");

    const result = await runLangGraphAgentLoop(options(adapter));

    expect(String(adapter.requests[1].messages[0].content)).toContain("上一次 JSON 决策无效");
    expect(result.reply).toBe("好的。");
  });

  it("repairs a native ToolCall whose arguments fail Runtime validation", async () => {
    const adapter = new FakeAdapter();
    adapter.enqueueJson({ decision: "act", capability: "music.play_track", objective: "播放第一首", targetRefs: ["ctx_song_1"], afterSuccess: "respond" });
    adapter.enqueueToolCall("music_play_track", { candidateRef: "ctx_invented" });
    adapter.enqueueToolCall("music_play_track", { candidateRef: "ctx_song_1" });
    // routeAfterTool 在工具成功后直接路由到 soul
    adapter.enqueueText("请求已发送。");
    const executeTool = vi.fn(async () => ({ status: "succeeded" as const, output: "ok" }));

    await runLangGraphAgentLoop(options(adapter, executeTool));

    expect(String(adapter.requests[2].messages[0].content)).toContain("E_TOOL_ARGUMENT_SOURCE");
    expect(executeTool).toHaveBeenCalledTimes(1);
  });

  it("feeds failed execution facts back so the model can explicitly retry", async () => {
    const adapter = new FakeAdapter();
    adapter.enqueueJson({ decision: "act", capability: "music.play_track", objective: "播放第一首", targetRefs: ["ctx_song_1"], afterSuccess: "respond" });
    adapter.enqueueToolCall("music_play_track", { candidateRef: "ctx_song_1" });
    adapter.enqueueJson({ decision: "act", capability: "music.play_track", objective: "重试播放第一首", targetRefs: ["ctx_song_1"], afterSuccess: "respond" });
    adapter.enqueueToolCall("music_play_track", { candidateRef: "ctx_song_1" });
    // routeAfterTool 在第二次（succeeded）后直接路由到 soul
    adapter.enqueueText("第二次请求成功发送。");
    const executeTool = vi.fn()
      .mockResolvedValueOnce({ status: "failed" as const, errorCode: "E_LAUNCH_FAILED", output: "启动失败", retryable: true })
      .mockResolvedValueOnce({ status: "succeeded" as const, output: "{\"ok\":true}" });

    const result = await runLangGraphAgentLoop(options(adapter, executeTool));

    expect(executeTool).toHaveBeenCalledTimes(2);
    expect(result.toolResults.map((item) => item.status)).toEqual(["failed", "succeeded"]);
    expect(String(adapter.requests[2].messages[0].content)).toContain("E_LAUNCH_FAILED");
  });

  it("does not repeat a successful side effect because routeAfterTool routes directly to Soul", async () => {
    // 新主路径：act 成功后 routeAfterTool 直接路由到 soul，模型没有机会再次输出相同 act。
    // ExecutionLedger 的去重 / forced_respond 不再承担正常终止职责。
    const adapter = new FakeAdapter();
    adapter.enqueueJson({ decision: "act", capability: "music.play_track", objective: "播放第一首", targetRefs: ["ctx_song_1"], afterSuccess: "respond" });
    adapter.enqueueToolCall("music_play_track", { candidateRef: "ctx_song_1" });
    adapter.enqueueText("请求已发送。");
    const executeTool = vi.fn(async () => ({ status: "succeeded" as const, output: "{\"ok\":true}" }));

    const result = await runLangGraphAgentLoop(options(adapter, executeTool));

    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(result.reply).toBe("请求已发送。");
  });

  it("forces respond on a deduplicated terminal action as a fallback (routeAfterTool -> decide -> duplicate)", async () => {
    // 异常兜底路径：routeAfterTool 因为 afterSuccess=replan 回到 decide，
    // 模型又重复同一动作 -> execute 命中缓存 deduplicated=true -> forced_respond 不调 LLM。
    const adapter = new FakeAdapter();
    adapter.enqueueJson({ decision: "act", capability: "music.play_track", objective: "播放", targetRefs: ["ctx_song_1"], afterSuccess: "replan" });
    adapter.enqueueToolCall("music_play_track", { candidateRef: "ctx_song_1" });
    // replan 后模型重复同一动作（相同 capability+targetRefs+args）
    adapter.enqueueJson({ decision: "act", capability: "music.play_track", objective: "再播放", targetRefs: ["ctx_song_1"], afterSuccess: "replan" });
    adapter.enqueueToolCall("music_play_track", { candidateRef: "ctx_song_1" });
    // execute 命中缓存 deduplicated=true -> routeAfterTool 看到 succeeded+terminal+respond(默认) -> soul
    // （注意：replan 只在第一次 act 声明；第二次 act 也声明 replan，但 routeAfterTool 仍会路由到 soul，
    //  因为 deduplicated=true 时 forced_respond 在 decide 里已经触发，不会到 routeAfterTool。
    //  实际上：第二次 execute 返回 deduplicated=true，streak=1，routeAfterTool 看到 succeeded+terminal+replan -> decide，
    //  decide 看到 deduplicated -> forced_respond -> soul）
    adapter.enqueueText("已发送播放请求。");
    const executeTool = vi.fn(async () => ({ status: "succeeded" as const, output: "{\"ok\":true}" }));

    const result = await runLangGraphAgentLoop(options(adapter, executeTool));

    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(result.reply).toBe("已发送播放请求。");
  });

  it("still allows a different action after a successful terminal action with afterSuccess=replan", async () => {
    // 多步任务：第 1 次 play(ctx_song_1) 成功 + afterSuccess=replan -> routeAfterTool 回 decide
    // -> 第 2 次 play(ctx_song_2) 指纹不同，cached=false，正常执行 -> respond
    const adapter = new FakeAdapter();
    adapter.enqueueJson({ decision: "act", capability: "music.play_track", objective: "播放第一首", targetRefs: ["ctx_song_1"], afterSuccess: "replan" });
    adapter.enqueueToolCall("music_play_track", { candidateRef: "ctx_song_1" });
    adapter.enqueueJson({ decision: "act", capability: "music.play_track", objective: "播放第二首", targetRefs: ["ctx_song_2"], afterSuccess: "respond" });
    adapter.enqueueToolCall("music_play_track", { candidateRef: "ctx_song_2" });
    adapter.enqueueText("完成。");
    const executeTool = vi.fn(async () => ({ status: "succeeded" as const, output: "{\"ok\":true}" }));

    const result = await runLangGraphAgentLoop(options(adapter, executeTool));

    expect(executeTool).toHaveBeenCalledTimes(2);
    expect(result.reply).toBe("完成。");
  });

  it("does not repeat a successful side effect when Soul fails and the same turn is retried", async () => {
    const ledger = new ExecutionLedger();
    const first = new FakeAdapter();
    first.enqueueJson({ decision: "act", capability: "music.play_track", objective: "播放第一首", targetRefs: ["ctx_song_1"], afterSuccess: "respond" });
    first.enqueueToolCall("music_play_track", { candidateRef: "ctx_song_1" });
    // routeAfterTool 在工具成功后直接路由到 soul，不调 Action Gate
    first.enqueueText("不会送达的 Soul 回复");
    const executeTool = vi.fn(async () => ({ status: "succeeded" as const, output: "{\"ok\":true}" }));
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(new Response("soul failed", { status: 500 })) as unknown as typeof fetch;

    await expect(runLangGraphAgentLoop({ ...options(first, executeTool), executionLedger: ledger })).rejects.toThrow("HTTP 500");

    const retry = new FakeAdapter();
    retry.enqueueJson({ decision: "act", capability: "music.play_track", objective: "播放第一首", targetRefs: ["ctx_song_1"], afterSuccess: "respond" });
    retry.enqueueToolCall("music_play_track", { candidateRef: "ctx_song_1" });
    // 重试时 execute 命中 ledger 缓存 -> deduplicated=true -> forced_respond 不调 LLM -> soul
    retry.enqueueText("已向网易云发送播放请求。");
    globalThis.fetch = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;

    const result = await runLangGraphAgentLoop({ ...options(retry, executeTool), executionLedger: ledger });

    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(result.reply).toBe("已向网易云发送播放请求。");
  });

  it("preserves image-caption fallback for the first JSON decision request", async () => {
    const adapter = new FakeAdapter();
    adapter.enqueueJson({ decision: "ask_user", reason: "图片信息不足", missingInformation: ["图片细节"] });
    adapter.enqueueText("你可以再描述一下图片吗？");
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response("unsupported image", { status: 400 }))
      .mockImplementation(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const imageCaptionFallback = vi.fn(async (): Promise<ChatMessage[]> => [
      { role: "user", content: "[图片描述] 一张夜景照片" },
    ]);

    await runLangGraphAgentLoop({ ...options(adapter), imageCaptionFallback });

    expect(imageCaptionFallback).toHaveBeenCalledTimes(1);
    expect(adapter.requests[1].messages).toContainEqual({ role: "user", content: "[图片描述] 一张夜景照片" });
  });
});
