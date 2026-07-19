import { describe, expect, it } from "vitest";
import { buildForcedToolRequest, parseForcedToolResponse, resolveToolForCapability } from "./forced-tool-call";
import type { ToolDefinition } from "./tool-registry";
import type { ChatResponse } from "./vendors/types";

function tool(id: string, capability?: string): ToolDefinition {
  return {
    id,
    name: id,
    description: `${id} description`,
    capability,
    enabled: true,
    inputSchema: { type: "object", properties: { candidateRef: { type: "string" } }, required: ["candidateRef"] },
    execute: async () => "ok",
  };
}

describe("forced tool call", () => {
  it("maps a generic capability to the enabled runtime tool", () => {
    expect(resolveToolForCapability([tool("music_play_track", "music.play_track")], "music.play_track").id)
      .toBe("music_play_track");
  });

  it("forces exactly the selected tool and preserves CITA refs for argument generation", () => {
    const selected = tool("music_play_track", "music.play_track");
    const request = buildForcedToolRequest({
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
      toolResults: [{
        toolId: "music_search",
        args: { keyword: "左转灯" },
        output: JSON.stringify({ candidateRef: "ctx_song_1", name: "左转灯" }),
        status: "succeeded",
      }],
      tool: selected,
    });

    expect(request.tools?.map((item) => item.name)).toEqual(["music_play_track"]);
    expect(request.toolChoice).toEqual({ name: "music_play_track" });
    expect(String(request.messages[0].content)).toContain("ctx_song_1");
    expect(String(request.messages[0].content)).toContain("music_search");
  });

  it("rejects a model response that skips the forced tool", () => {
    const response: ChatResponse = {
      assistantMessage: { role: "assistant", content: "已经播放" },
      text: "已经播放",
      toolCalls: [],
      finishReason: "stop",
      raw: {},
    };

    expect(() => parseForcedToolResponse(response, "music_play_track"))
      .toThrow("E_FORCED_TOOL_PROTOCOL");
  });
});
