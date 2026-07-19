import { describe, expect, it } from "vitest";
import { buildActionGateRequest, parseActionDecisionResponse } from "./action-gate";
import type { ChatResponse } from "./vendors/types";

function response(text: string): ChatResponse {
  return {
    assistantMessage: { role: "assistant", content: text },
    text,
    toolCalls: [],
    finishReason: "stop",
    raw: {},
  };
}

describe("ActionGate JSON protocol", () => {
  it("requests provider-neutral JSON without tools or toolChoice", () => {
    const request = buildActionGateRequest({
      model: "test-model",
      originalQuery: "播放第一首",
      contextualizedQuery: "播放当前网易云日推第一首《最初的记忆》",
      citaContextBlock: "[CITA_CONTEXT]\n{}\n[/CITA_CONTEXT]",
      messages: [{ role: "user", content: "播放第一首" }],
      availableCapabilities: [{ capability: "music.play_track", toolId: "music_play_track", description: "播放歌曲" }],
      toolResults: [],
    });

    expect(request.tools).toBeUndefined();
    expect(request.toolChoiceIntent).toBeUndefined();
    expect(String(request.messages[0].content)).toContain("只返回一个 JSON 对象");
    expect(String(request.messages[0].content)).not.toContain('输出结构：{"act"');
    expect(String(request.messages[0].content)).toContain('respond 示例：{"decision":"respond"');
    expect(String(request.messages[0].content)).toContain("播放当前网易云日推第一首《最初的记忆》");
  });

  it("parses an act decision from exact JSON text", () => {
    expect(parseActionDecisionResponse(response(JSON.stringify({
      decision: "act",
      capability: "music.play_track",
      objective: "播放已选择歌曲",
      targetRefs: ["ctx_song_1"],
    })), ["music.play_track"])).toEqual({
      decision: "act",
      capability: "music.play_track",
      objective: "播放已选择歌曲",
      targetRefs: ["ctx_song_1"],
    });
  });

  it("parses respond and ask_user decisions without diagnostic-only optional fields", () => {
    expect(parseActionDecisionResponse(response('{"decision":"respond"}'), [])).toEqual({
      decision: "respond",
      reason: "ready_to_respond",
    });
    expect(parseActionDecisionResponse(response('{"decision":"ask_user","reason":"版本不明确"}'), [])).toEqual({
      decision: "ask_user",
      reason: "版本不明确",
      missingInformation: [],
    });
  });

  it("rejects natural language and markdown-wrapped JSON", () => {
    expect(() => parseActionDecisionResponse(response("我来播放"), ["music.play_track"]))
      .toThrow("E_ACTION_GATE_PROTOCOL");
    expect(() => parseActionDecisionResponse(response('```json\n{"decision":"respond"}\n```'), []))
      .toThrow("E_ACTION_GATE_PROTOCOL");
  });

  it("includes protocol feedback in a JSON repair request", () => {
    const request = buildActionGateRequest({
      model: "test-model",
      originalQuery: "播放第一首",
      contextualizedQuery: "播放当前第一首",
      citaContextBlock: "",
      messages: [{ role: "user", content: "播放第一首" }],
      availableCapabilities: [{ capability: "music.play_track", toolId: "music_play_track", description: "播放歌曲" }],
      toolResults: [],
      protocolFeedback: "E_ACTION_GATE_PROTOCOL",
    });

    expect(String(request.messages[0].content)).toContain("上一次 JSON 决策无效");
    expect(String(request.messages[0].content)).toContain("E_ACTION_GATE_PROTOCOL");
  });
});
