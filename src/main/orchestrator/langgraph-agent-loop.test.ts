import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runLangGraphAgentLoop } from "./langgraph-agent-loop";
import { ExecutionLedger } from "./execution-ledger";
import type { ToolDefinition } from "./tool-registry";
import type {
  ChatMessage, ChatRequest, ChatResponse, ChatVendorAdapter, HttpRequest,
  ProviderCapability, ToolExecutionResult,
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
  private scripts: string[] = [];
  private index = 0;

  enqueueText(text: string) { this.scripts.push(text); }
  enqueueJson(value: unknown) { this.enqueueText(JSON.stringify(value)); }
  buildRequest(req: ChatRequest): HttpRequest {
    this.requests.push(req);
    return { url: "https://fake/", method: "POST", headers: {}, body: "{}" };
  }
  parseResponse(): ChatResponse {
    const text = this.scripts[this.index++];
    if (text === undefined) throw new Error("missing fake response");
    return {
      assistantMessage: { role: "assistant", content: text }, text, toolCalls: [],
      finishReason: "stop", raw: {},
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

describe("runLangGraphAgentLoop JSON runtime", () => {
  it("decides and resolves arguments as JSON, then Runtime directly executes the tool", async () => {
    const adapter = new FakeAdapter();
    adapter.enqueueJson({ decision: "act", capability: "music.play_track", objective: "播放第一首", targetRefs: ["ctx_song_1"] });
    adapter.enqueueJson({ candidateRef: "ctx_song_1" });
    adapter.enqueueJson({ decision: "respond" });
    adapter.enqueueText("已向网易云发送播放请求。");
    const executeTool = vi.fn(async () => ({ status: "succeeded" as const, output: "{\"kind\":\"playback\"}" }));

    const result = await runLangGraphAgentLoop(options(adapter, executeTool));

    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(executeTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "music_play_track", arguments: '{"candidateRef":"ctx_song_1"}' }),
      expect.any(Set),
    );
    expect(adapter.requests.every((request) => request.tools === undefined && request.toolChoice === undefined)).toBe(true);
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

  it("repairs malformed tool argument JSON before execution", async () => {
    const adapter = new FakeAdapter();
    adapter.enqueueJson({ decision: "act", capability: "music.play_track", objective: "播放第一首", targetRefs: ["ctx_song_1"] });
    adapter.enqueueJson({ candidateRef: "ctx_invented" });
    adapter.enqueueJson({ candidateRef: "ctx_song_1" });
    adapter.enqueueJson({ decision: "respond" });
    adapter.enqueueText("请求已发送。");
    const executeTool = vi.fn(async () => ({ status: "succeeded" as const, output: "ok" }));

    await runLangGraphAgentLoop(options(adapter, executeTool));

    expect(String(adapter.requests[2].messages[0].content)).toContain("E_TOOL_ARGUMENT_SOURCE");
    expect(executeTool).toHaveBeenCalledTimes(1);
  });

  it("feeds failed execution facts back so the model can explicitly retry", async () => {
    const adapter = new FakeAdapter();
    adapter.enqueueJson({ decision: "act", capability: "music.play_track", objective: "播放第一首", targetRefs: ["ctx_song_1"] });
    adapter.enqueueJson({ candidateRef: "ctx_song_1" });
    adapter.enqueueJson({ decision: "act", capability: "music.play_track", objective: "重试播放第一首", targetRefs: ["ctx_song_1"] });
    adapter.enqueueJson({ candidateRef: "ctx_song_1" });
    adapter.enqueueJson({ decision: "respond" });
    adapter.enqueueText("第二次请求成功发送。");
    const executeTool = vi.fn()
      .mockResolvedValueOnce({ status: "failed" as const, errorCode: "E_LAUNCH_FAILED", output: "启动失败" })
      .mockResolvedValueOnce({ status: "succeeded" as const, output: "{\"ok\":true}" });

    const result = await runLangGraphAgentLoop(options(adapter, executeTool));

    expect(executeTool).toHaveBeenCalledTimes(2);
    expect(result.toolResults.map((item) => item.status)).toEqual(["failed", "succeeded"]);
    expect(String(adapter.requests[2].messages[0].content)).toContain("E_LAUNCH_FAILED");
  });

  it("does not repeat a successful side effect when the graph reaches the same action again", async () => {
    const adapter = new FakeAdapter();
    adapter.enqueueJson({ decision: "act", capability: "music.play_track", objective: "播放第一首", targetRefs: ["ctx_song_1"] });
    adapter.enqueueJson({ candidateRef: "ctx_song_1" });
    adapter.enqueueJson({ decision: "act", capability: "music.play_track", objective: "确认播放第一首", targetRefs: ["ctx_song_1"] });
    adapter.enqueueJson({ candidateRef: "ctx_song_1" });
    adapter.enqueueJson({ decision: "respond" });
    adapter.enqueueText("请求已发送。");
    const executeTool = vi.fn(async () => ({ status: "succeeded" as const, output: "{\"ok\":true}" }));

    const result = await runLangGraphAgentLoop(options(adapter, executeTool));

    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(result.toolResults).toHaveLength(2);
  });

  it("does not repeat a successful side effect when Soul fails and the same turn is retried", async () => {
    const ledger = new ExecutionLedger();
    const first = new FakeAdapter();
    first.enqueueJson({ decision: "act", capability: "music.play_track", objective: "播放第一首", targetRefs: ["ctx_song_1"] });
    first.enqueueJson({ candidateRef: "ctx_song_1" });
    first.enqueueJson({ decision: "respond" });
    first.enqueueText("不会送达的 Soul 回复");
    const executeTool = vi.fn(async () => ({ status: "succeeded" as const, output: "{\"ok\":true}" }));
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(new Response("soul failed", { status: 500 })) as unknown as typeof fetch;

    await expect(runLangGraphAgentLoop({ ...options(first, executeTool), executionLedger: ledger })).rejects.toThrow("HTTP 500");

    const retry = new FakeAdapter();
    retry.enqueueJson({ decision: "act", capability: "music.play_track", objective: "播放第一首", targetRefs: ["ctx_song_1"] });
    retry.enqueueJson({ candidateRef: "ctx_song_1" });
    retry.enqueueJson({ decision: "respond" });
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
