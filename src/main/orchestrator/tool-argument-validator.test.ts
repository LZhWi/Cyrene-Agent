import { describe, expect, it } from "vitest";
import { parseAndValidateToolCallArguments, resolveToolForCapability } from "./tool-argument-validator";
import type { ToolDefinition } from "./tool-registry";
import type { ToolCallResult } from "./types";

function trackTool(): ToolDefinition {
  return {
    id: "music_play_track", capability: "music.play_track", name: "播放歌曲",
    description: "播放可信歌曲候选", enabled: true,
    inputSchema: {
      type: "object", properties: { candidateRef: { type: "string" } }, required: ["candidateRef"],
    },
    controlledInput: { candidateRef: "context_ref" },
    execute: async () => "ok",
  };
}

describe("tool argument validator", () => {
  it("resolves one enabled tool for a capability", () => {
    expect(resolveToolForCapability([trackTool()], "music.play_track").id).toBe("music_play_track");
  });

  it("accepts Adapter-normalized arguments backed by a trusted ContextRef", () => {
    expect(parseAndValidateToolCallArguments(
      { id: "call-1", name: "music_play_track", arguments: '{"candidateRef":"ctx_song_1"}' },
      trackTool(), ["ctx_song_1"], [],
    )).toEqual({ candidateRef: "ctx_song_1" });
  });

  it("rejects malformed JSON, schema violations and invented controlled refs", () => {
    expect(() => parseAndValidateToolCallArguments(
      { id: "call-1", name: "music_play_track", arguments: "not json" }, trackTool(), ["ctx_song_1"], [],
    )).toThrow("E_TOOL_ARGUMENT_PROTOCOL");
    expect(() => parseAndValidateToolCallArguments(
      { id: "call-1", name: "music_play_track", arguments: "{}" }, trackTool(), ["ctx_song_1"], [],
    )).toThrow("E_TOOL_ARGUMENT_SCHEMA");
    expect(() => parseAndValidateToolCallArguments(
      { id: "call-1", name: "music_play_track", arguments: '{"candidateRef":"invented"}' },
      trackTool(), ["ctx_song_1"], [],
    )).toThrow("E_TOOL_ARGUMENT_SOURCE");
  });

  it("accepts controlled ids only from successful prior tool results", () => {
    const playlistTool: ToolDefinition = {
      ...trackTool(), id: "music_play_playlist", capability: "music.play_playlist",
      inputSchema: { type: "object", properties: { playlistId: { type: "string" } }, required: ["playlistId"] },
      controlledInput: { playlistId: "tool_result" },
    };
    const results: ToolCallResult[] = [{
      toolId: "music_get_playlist", args: {}, output: '{"playlistId":"playlist-42"}', status: "succeeded",
    }];
    expect(parseAndValidateToolCallArguments(
      { id: "call-1", name: "music_play_playlist", arguments: '{"playlistId":"playlist-42"}' },
      playlistTool, [], results,
    )).toEqual({ playlistId: "playlist-42" });
  });
});
