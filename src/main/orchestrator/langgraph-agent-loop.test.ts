import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACTION_DECISION_TOOL_ID } from "./action-gate";
import { runLangGraphAgentLoop } from "./langgraph-agent-loop";
import type { ToolDefinition } from "./tool-registry";
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
  private scripts: Array<{ text?: string; toolCalls?: ToolCall[] }> = [];
  private index = 0;

  enqueueText(text: string) { this.scripts.push({ text }); }
  enqueueTool(name: string, args: Record<string, unknown>) {
    this.scripts.push({ toolCalls: [{ id: `call-${this.scripts.length + 1}`, name, arguments: JSON.stringify(args) }] });
  }
  buildRequest(req: ChatRequest): HttpRequest {
    this.requests.push(req);
    return { url: "https://fake/", method: "POST", headers: {}, body: "{}" };
  }
  parseResponse(): ChatResponse {
    const script = this.scripts[this.index++];
    if (!script) throw new Error("missing fake response");
    const toolCalls = script.toolCalls ?? [];
    return {
      assistantMessage: { role: "assistant", content: script.text, ...(toolCalls.length ? { toolCalls } : {}) },
      text: script.text ?? "",
      toolCalls,
      finishReason: toolCalls.length ? "tool_calls" : "stop",
      raw: {},
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
    id: "music_play_track",
    capability: "music.play_track",
    name: "播放歌曲",
    description: "播放可信歌曲候选",
    enabled: true,
    inputSchema: {
      type: "object",
      properties: { candidateRef: { type: "string" } },
      required: ["candidateRef"],
    },
    execute: async () => "unused",
  };
}

beforeEach(() => {
  globalThis.fetch = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
});
afterEach(() => vi.restoreAllMocks());

describe("runLangGraphAgentLoop", () => {
  it("forces an act decision through the selected tool before Soul", async () => {
    const adapter = new FakeAdapter();
    adapter.enqueueTool(ACTION_DECISION_TOOL_ID, {
      decision: "act", capability: "music.play_track", objective: "播放第一首", targetRefs: ["ctx_song_1"],
    });
    adapter.enqueueTool("music_play_track", { candidateRef: "ctx_song_1" });
    adapter.enqueueTool(ACTION_DECISION_TOOL_ID, { decision: "respond", reason: "工具请求已成功发送" });
    adapter.enqueueText("已向网易云发送播放请求。");
    const executeTool = vi.fn(async () => ({
      status: "succeeded" as const,
      output: JSON.stringify({ kind: "playback", dispatch: { state: "dispatched" } }),
    }));

    const result = await runLangGraphAgentLoop({
      settings: { provider: "test", baseUrl: "https://test", model: "m", apiKey: "k" },
      adapter,
      messages: [{ role: "user", content: "播放第一首" }],
      tools: [musicPlayTool()],
      toolSystemContent: "TOOL_SYSTEM",
      soulSystemBaseContent: "SOUL_SYSTEM",
      originalQuery: "播放第一首",
      contextualizedQuery: "播放当前网易云日推第一首《最初的记忆》",
      citaContextBlock: "ctx_song_1",
      timeoutMs: 30_000,
      executeTool,
    });

    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(adapter.requests.map((request) => request.toolChoice?.name)).toEqual([
      ACTION_DECISION_TOOL_ID,
      "music_play_track",
      ACTION_DECISION_TOOL_ID,
      undefined,
    ]);
    expect(result.reply).toBe("已向网易云发送播放请求。");
    expect(result.toolResults[0].status).toBe("succeeded");
  });

  it("routes ask_user to Soul without exposing runtime tools", async () => {
    const adapter = new FakeAdapter();
    adapter.enqueueTool(ACTION_DECISION_TOOL_ID, {
      decision: "ask_user", reason: "存在多个版本", missingInformation: ["歌曲版本"],
    });
    adapter.enqueueText("你想听哪个版本？");
    const executeTool = vi.fn();

    const result = await runLangGraphAgentLoop({
      settings: { provider: "test", baseUrl: "https://test", model: "m", apiKey: "k" },
      adapter,
      messages: [{ role: "user", content: "播放左转灯" }],
      tools: [musicPlayTool()],
      toolSystemContent: "TOOL_SYSTEM",
      soulSystemBaseContent: "SOUL_SYSTEM",
      originalQuery: "播放左转灯",
      contextualizedQuery: "播放左转灯，但版本不明确",
      citaContextBlock: "",
      timeoutMs: 30_000,
      executeTool,
    });

    expect(executeTool).not.toHaveBeenCalled();
    expect(adapter.requests.at(-1)?.tools).toBeUndefined();
    expect(result.reply).toBe("你想听哪个版本？");
  });

  it("retries a skipped forced tool call instead of falling through to Soul", async () => {
    const adapter = new FakeAdapter();
    adapter.enqueueTool(ACTION_DECISION_TOOL_ID, {
      decision: "act", capability: "music.play_track", objective: "播放第一首", targetRefs: ["ctx_song_1"],
    });
    adapter.enqueueText("已经给你播放啦");
    adapter.enqueueTool("music_play_track", { candidateRef: "ctx_song_1" });
    adapter.enqueueTool(ACTION_DECISION_TOOL_ID, { decision: "respond", reason: "工具请求已成功发送" });
    adapter.enqueueText("播放请求已经发出。");
    const executeTool = vi.fn(async () => ({ status: "succeeded" as const, output: "{\"ok\":true}" }));

    const result = await runLangGraphAgentLoop({
      settings: { provider: "test", baseUrl: "https://test", model: "m", apiKey: "k" },
      adapter,
      messages: [{ role: "user", content: "播放第一首" }],
      tools: [musicPlayTool()],
      toolSystemContent: "TOOL_SYSTEM",
      soulSystemBaseContent: "SOUL_SYSTEM",
      originalQuery: "播放第一首",
      contextualizedQuery: "播放当前日推第一首",
      citaContextBlock: "ctx_song_1",
      timeoutMs: 30_000,
      executeTool,
    });

    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(adapter.requests.filter((request) => request.toolChoice?.name === "music_play_track")).toHaveLength(2);
    expect(result.reply).toBe("播放请求已经发出。");
    expect(result.reply).not.toContain("已经给你播放啦");
  });

  it("feeds a failed tool result back into Action Gate so the model can retry", async () => {
    const adapter = new FakeAdapter();
    adapter.enqueueTool(ACTION_DECISION_TOOL_ID, {
      decision: "act", capability: "music.play_track", objective: "播放第一首", targetRefs: ["ctx_song_1"],
    });
    adapter.enqueueTool("music_play_track", { candidateRef: "ctx_song_1" });
    adapter.enqueueTool(ACTION_DECISION_TOOL_ID, {
      decision: "act", capability: "music.play_track", objective: "重试播放第一首", targetRefs: ["ctx_song_1"],
    });
    adapter.enqueueTool("music_play_track", { candidateRef: "ctx_song_1" });
    adapter.enqueueTool(ACTION_DECISION_TOOL_ID, { decision: "respond", reason: "第二次请求成功" });
    adapter.enqueueText("第二次请求成功发送。");
    const executeTool = vi.fn()
      .mockResolvedValueOnce({ status: "failed" as const, errorCode: "E_LAUNCH_FAILED", output: "启动失败" })
      .mockResolvedValueOnce({ status: "succeeded" as const, output: "{\"ok\":true}" });

    const result = await runLangGraphAgentLoop({
      settings: { provider: "test", baseUrl: "https://test", model: "m", apiKey: "k" },
      adapter,
      messages: [{ role: "user", content: "播放第一首" }],
      tools: [musicPlayTool()],
      toolSystemContent: "TOOL_SYSTEM",
      soulSystemBaseContent: "SOUL_SYSTEM",
      originalQuery: "播放第一首",
      contextualizedQuery: "播放当前日推第一首",
      citaContextBlock: "ctx_song_1",
      timeoutMs: 30_000,
      executeTool,
    });

    expect(executeTool).toHaveBeenCalledTimes(2);
    expect(result.toolResults.map((item) => item.status)).toEqual(["failed", "succeeded"]);
    expect(String(adapter.requests[2].messages[0].content)).toContain("E_LAUNCH_FAILED");
  });

  it("preserves an explicit error code when a runtime tool throws", async () => {
    const adapter = new FakeAdapter();
    adapter.enqueueTool(ACTION_DECISION_TOOL_ID, {
      decision: "act", capability: "music.play_track", objective: "播放第一首", targetRefs: ["ctx_song_1"],
    });
    adapter.enqueueTool("music_play_track", { candidateRef: "ctx_song_1" });
    adapter.enqueueTool(ACTION_DECISION_TOOL_ID, { decision: "respond", reason: "播放失败" });
    adapter.enqueueText("这次没有成功发送播放请求。");

    const result = await runLangGraphAgentLoop({
      settings: { provider: "test", baseUrl: "https://test", model: "m", apiKey: "k" },
      adapter,
      messages: [{ role: "user", content: "播放第一首" }],
      tools: [musicPlayTool()],
      toolSystemContent: "TOOL_SYSTEM",
      soulSystemBaseContent: "SOUL_SYSTEM",
      originalQuery: "播放第一首",
      contextualizedQuery: "播放当前日推第一首",
      citaContextBlock: "ctx_song_1",
      timeoutMs: 30_000,
      executeTool: async () => { throw Object.assign(new Error("候选已过期"), { code: "E_CANDIDATE_EXPIRED" }); },
    });

    expect(result.toolResults[0]).toMatchObject({ status: "failed", errorCode: "E_CANDIDATE_EXPIRED" });
    expect(String(adapter.requests[2].messages[0].content)).toContain("E_CANDIDATE_EXPIRED");
  });

  it("preserves the existing image-caption fallback before continuing the graph", async () => {
    const adapter = new FakeAdapter();
    adapter.enqueueTool(ACTION_DECISION_TOOL_ID, {
      decision: "ask_user", reason: "图片信息不足", missingInformation: ["图片细节"],
    });
    adapter.enqueueText("你可以再描述一下图片吗？");
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response("unsupported image", { status: 400 }))
      .mockImplementation(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const imageCaptionFallback = vi.fn(async (): Promise<ChatMessage[]> => [
      { role: "user", content: "[图片描述] 一张夜景照片" },
    ]);

    await runLangGraphAgentLoop({
      settings: { provider: "test", baseUrl: "https://test", model: "m", apiKey: "k" },
      adapter,
      messages: [{ role: "user", content: "看看这张图" }],
      tools: [musicPlayTool()],
      toolSystemContent: "TOOL_SYSTEM",
      soulSystemBaseContent: "SOUL_SYSTEM",
      originalQuery: "看看这张图",
      contextualizedQuery: "看看这张图",
      citaContextBlock: "",
      timeoutMs: 30_000,
      executeTool: async () => ({ status: "succeeded", output: "ok" }),
      imageCaptionFallback,
    });

    expect(imageCaptionFallback).toHaveBeenCalledTimes(1);
    expect(adapter.requests[1].messages).toContainEqual({ role: "user", content: "[图片描述] 一张夜景照片" });
  });
});
