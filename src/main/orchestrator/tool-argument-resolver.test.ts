import { describe, expect, it } from "vitest";
import {
  buildToolArgumentRequest,
  parseAndValidateToolArguments,
  resolveToolForCapability,
} from "./tool-argument-resolver";
import type { ToolDefinition } from "./tool-registry";
import type { ChatResponse } from "./vendors/types";

function tool(): ToolDefinition {
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
    controlledInput: { candidateRef: "context_ref" },
    execute: async () => "ok",
  };
}

function response(text: string): ChatResponse {
  return {
    assistantMessage: { role: "assistant", content: text },
    text,
    toolCalls: [],
    finishReason: "stop",
    raw: {},
  };
}

describe("tool argument resolver", () => {
  it("maps a capability to one enabled runtime tool", () => {
    expect(resolveToolForCapability([tool()], "music.play_track").id).toBe("music_play_track");
  });

  it("requests plain JSON arguments without provider tools or toolChoice", () => {
    const request = buildToolArgumentRequest({
      model: "m",
      messages: [{ role: "user", content: "播放第一首" }],
      toolSystemContent: "TOOL_SYSTEM",
      citaContextBlock: "ctx_song_1",
      decision: {
        decision: "act",
        capability: "music.play_track",
        objective: "播放当前日推第一首",
        targetRefs: ["ctx_song_1"],
      },
      toolResults: [],
      tool: tool(),
    });

    expect(request.tools).toBeUndefined();
    expect(request.toolChoice).toBeUndefined();
    expect(String(request.messages[0].content)).toContain("candidateRef");
    expect(String(request.messages[0].content)).toContain("只返回一个 JSON 对象");
  });

  it("validates schema and accepts a controlled ref from the decision", () => {
    expect(parseAndValidateToolArguments(
      response('{"candidateRef":"ctx_song_1"}'),
      tool(),
      ["ctx_song_1"],
      [],
    )).toEqual({ candidateRef: "ctx_song_1" });
  });

  it("rejects missing required args and invented controlled refs", () => {
    expect(() => parseAndValidateToolArguments(response("{}"), tool(), ["ctx_song_1"], []))
      .toThrow("E_TOOL_ARGUMENT_SCHEMA");
    expect(() => parseAndValidateToolArguments(
      response('{"candidateRef":"ctx_invented"}'),
      tool(),
      ["ctx_song_1"],
      [],
    )).toThrow("E_TOOL_ARGUMENT_SOURCE");
  });

  it("accepts controlled ids only when they occur in a successful prior tool result", () => {
    const playlistTool: ToolDefinition = {
      ...tool(),
      id: "music_play_playlist",
      capability: "music.play_playlist",
      inputSchema: {
        type: "object",
        properties: { playlistId: { type: "string" } },
        required: ["playlistId"],
      },
      controlledInput: { playlistId: "tool_result" },
    };
    const results = [{
      toolId: "music_get_playlist",
      args: {},
      output: '{"playlistId":"playlist-42"}',
      status: "succeeded" as const,
    }];

    expect(parseAndValidateToolArguments(
      response('{"playlistId":"playlist-42"}'), playlistTool, [], results,
    )).toEqual({ playlistId: "playlist-42" });
    expect(() => parseAndValidateToolArguments(
      response('{"playlistId":"invented"}'), playlistTool, [], results,
    )).toThrow("E_TOOL_ARGUMENT_SOURCE");
  });
});
