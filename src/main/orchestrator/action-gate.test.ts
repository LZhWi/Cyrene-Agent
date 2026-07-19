import { describe, expect, it } from "vitest";
import {
  ACTION_DECISION_TOOL_ID,
  buildActionGateRequest,
  parseActionDecisionResponse,
} from "./action-gate";
import type { ChatResponse } from "./vendors/types";

describe("ActionGate", () => {
  it("forces a structured decision and exposes the contextualized query explicitly", () => {
    const request = buildActionGateRequest({
      model: "test-model",
      originalQuery: "播放第一首",
      contextualizedQuery: "播放当前网易云日推第一首《最初的记忆》",
      citaContextBlock: "[CITA_CONTEXT]\n{}\n[/CITA_CONTEXT]",
      messages: [{ role: "user", content: "播放第一首" }],
      availableCapabilities: [{ capability: "music.play_track", toolId: "music_play_track", description: "播放歌曲" }],
      toolResults: [],
    });

    expect(request.toolChoice).toEqual({ name: ACTION_DECISION_TOOL_ID });
    expect(request.tools).toHaveLength(1);
    expect(String(request.messages[0].content)).toContain("播放当前网易云日推第一首《最初的记忆》");
    expect(String(request.messages[0].content)).toContain("music.play_track");
  });

  it("parses an act decision only from the forced decision tool", () => {
    const response: ChatResponse = {
      assistantMessage: { role: "assistant" },
      text: "",
      thinking: "",
      toolCalls: [{
        id: "decision-1",
        name: ACTION_DECISION_TOOL_ID,
        arguments: JSON.stringify({
          decision: "act",
          capability: "music.play_track",
          objective: "播放已选择歌曲",
          targetRefs: ["ctx_song_1"],
        }),
      }],
      finishReason: "tool_calls",
      raw: {},
    };

    expect(parseActionDecisionResponse(response, ["music.play_track"])).toEqual({
      decision: "act",
      capability: "music.play_track",
      objective: "播放已选择歌曲",
      targetRefs: ["ctx_song_1"],
    });
  });

  it("rejects free text instead of treating it as respond", () => {
    const response: ChatResponse = {
      assistantMessage: { role: "assistant", content: "我来播放" },
      text: "我来播放",
      toolCalls: [],
      finishReason: "stop",
      raw: {},
    };

    expect(() => parseActionDecisionResponse(response, ["music.play_track"]))
      .toThrow("E_ACTION_GATE_PROTOCOL");
  });

  it("rejects an unavailable capability", () => {
    const response: ChatResponse = {
      assistantMessage: { role: "assistant" },
      text: "",
      toolCalls: [{
        id: "decision-1",
        name: ACTION_DECISION_TOOL_ID,
        arguments: JSON.stringify({
          decision: "act",
          capability: "email.send",
          objective: "发送邮件",
          targetRefs: [],
        }),
      }],
      finishReason: "tool_calls",
      raw: {},
    };

    expect(() => parseActionDecisionResponse(response, ["music.play_track"]))
      .toThrow("E_ACTION_GATE_CAPABILITY_UNAVAILABLE");
  });
});
