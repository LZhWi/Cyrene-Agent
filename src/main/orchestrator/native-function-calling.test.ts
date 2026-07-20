import { describe, expect, it, vi } from "vitest";
import { resolveNativeToolCall } from "./native-function-calling";
import type { ToolDefinition } from "./tool-registry";
import type { ChatRequest, ChatResponse } from "./vendors/types";

function tool(properties: ToolDefinition["inputSchema"]["properties"] = {}): ToolDefinition {
  return {
    id: "music_search", capability: "music.search", name: "搜索音乐",
    description: "搜索真实歌曲", enabled: true,
    inputSchema: {
      type: "object", properties,
      required: Object.keys(properties),
    },
    execute: async () => "unused",
  };
}

function response(toolCalls: ChatResponse["toolCalls"], text = ""): ChatResponse {
  return {
    assistantMessage: { role: "assistant", content: text, ...(toolCalls.length ? { toolCalls } : {}) },
    text, toolCalls, finishReason: toolCalls.length ? "tool_calls" : "stop", raw: {},
  };
}

describe("resolveNativeToolCall", () => {
  it("executes a zero-argument action without another model request", async () => {
    const invoke = vi.fn<(_: ChatRequest) => Promise<ChatResponse>>();
    const result = await resolveNativeToolCall({
      model: "m", messages: [], toolSystemContent: "tools", citaContextBlock: "ctx",
      decision: { decision: "act", capability: "music.daily_recommendations", objective: "读取日推", targetRefs: [] },
      toolResults: [], tool: { ...tool(), id: "music_get_daily_recommendations", capability: "music.daily_recommendations" },
    }, invoke);

    expect(invoke).not.toHaveBeenCalled();
    expect(result).toMatchObject({ name: "music_get_daily_recommendations", arguments: "{}" });
  });

  it("uses one native tool schema and accepts only the Adapter-normalized ToolCall", async () => {
    const invoke = vi.fn(async (request: ChatRequest) => response([{
      id: "call-1", name: "music_search", arguments: '{"keyword":"左转灯"}',
    }]));
    const result = await resolveNativeToolCall({
      model: "m", messages: [{ role: "user", content: "搜索左转灯" }],
      toolSystemContent: "tools", citaContextBlock: "ctx",
      decision: { decision: "act", capability: "music.search", objective: "搜索左转灯", targetRefs: [] },
      toolResults: [], tool: tool({ keyword: { type: "string" } }),
    }, invoke);

    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({
      tools: [expect.objectContaining({ name: "music_search" })],
      toolChoiceIntent: { mode: "must_call", toolName: "music_search" },
    }));
    expect(result).toEqual({ id: "call-1", name: "music_search", arguments: '{"keyword":"左转灯"}' });
  });

  it("rejects text pretending to be a function call", async () => {
    const invoke = vi.fn(async () => response([], '{"name":"music_search","arguments":{"keyword":"左转灯"}}'));
    await expect(resolveNativeToolCall({
      model: "m", messages: [], toolSystemContent: "tools", citaContextBlock: "ctx",
      decision: { decision: "act", capability: "music.search", objective: "搜索", targetRefs: [] },
      toolResults: [], tool: tool({ keyword: { type: "string" } }),
    }, invoke)).rejects.toThrow("E_NATIVE_TOOL_PROTOCOL");
  });
});
