import { describe, expect, it } from "vitest";
import { buildActionGateRequest, parseActionDecisionResponse } from "./action-gate";
import type { ChatResponse, ToolCall } from "./vendors/types";

/** 构造一个带 submit_decision tool call 的 ChatResponse（模拟 Provider 原生 function calling 返回）。 */
function toolCallResponse(args: object, name = "submit_decision"): ChatResponse {
  const toolCall: ToolCall = {
    id: `call-${Date.now()}`,
    name,
    arguments: JSON.stringify(args),
  };
  return {
    assistantMessage: { role: "assistant", content: "", toolCalls: [toolCall] },
    text: "",
    toolCalls: [toolCall],
    finishReason: "tool_calls",
    raw: {},
  };
}

/** 构造一个空 toolCalls 的 ChatResponse（模拟 LLM 没调虚拟工具的异常情况）。 */
function emptyResponse(text = ""): ChatResponse {
  return {
    assistantMessage: { role: "assistant", content: text },
    text,
    toolCalls: [],
    finishReason: "stop",
    raw: {},
  };
}

describe("ActionGate native function calling protocol", () => {
  it("requests a virtual submit_decision tool with must_call intent", () => {
    const request = buildActionGateRequest({
      model: "test-model",
      originalQuery: "播放第一首",
      contextualizedQuery: "播放当前网易云日推第一首《最初的记忆》",
      citaContextBlock: "[CITA_CONTEXT]\n{}\n[/CITA_CONTEXT]",
      messages: [{ role: "user", content: "播放第一首" }],
      availableCapabilities: [{ capability: "music.play_track", toolId: "music_play_track", description: "播放歌曲" }],
      toolResults: [],
    });

    expect(request.tools).toHaveLength(1);
    expect(request.tools?.[0].name).toBe("submit_decision");
    expect(request.toolChoiceIntent).toEqual({ mode: "must_call", toolName: "submit_decision" });
    // capability 字段应该是 enum，限制 LLM 只能选可用能力
    const capabilityProp = (request.tools?.[0].parameters as { properties: { capability: { enum?: string[] } } }).properties.capability;
    expect(capabilityProp.enum).toEqual(["music.play_track"]);
    expect(String(request.messages[0].content)).toContain("必须调用 submit_decision 工具提交决策");
    expect(String(request.messages[0].content)).toContain("播放当前网易云日推第一首《最初的记忆》");
  });

  it("parses an act decision from submit_decision tool arguments", () => {
    expect(parseActionDecisionResponse(toolCallResponse({
      decision: "act",
      capability: "music.play_track",
      objective: "播放已选择歌曲",
      targetRefs: ["ctx_song_1"],
    }), ["music.play_track"])).toEqual({
      decision: "act",
      capability: "music.play_track",
      objective: "播放已选择歌曲",
      targetRefs: ["ctx_song_1"],
    });
  });

  it("parses afterSuccess=respond from an act decision", () => {
    expect(parseActionDecisionResponse(toolCallResponse({
      decision: "act",
      capability: "music.play_track",
      objective: "播放",
      targetRefs: ["ctx_song_1"],
      afterSuccess: "respond",
    }), ["music.play_track"])).toEqual({
      decision: "act",
      capability: "music.play_track",
      objective: "播放",
      targetRefs: ["ctx_song_1"],
      afterSuccess: "respond",
    });
  });

  it("parses afterSuccess=replan for multi-step tasks", () => {
    expect(parseActionDecisionResponse(toolCallResponse({
      decision: "act",
      capability: "music.play_track",
      objective: "播放第一首",
      targetRefs: ["ctx_song_1"],
      afterSuccess: "replan",
    }), ["music.play_track"])).toEqual({
      decision: "act",
      capability: "music.play_track",
      objective: "播放第一首",
      targetRefs: ["ctx_song_1"],
      afterSuccess: "replan",
    });
  });

  it("omits afterSuccess when not declared (default respond is derived downstream)", () => {
    const parsed = parseActionDecisionResponse(toolCallResponse({
      decision: "act",
      capability: "music.play_track",
      objective: "播放",
      targetRefs: ["ctx_song_1"],
    }), ["music.play_track"]);
    expect(parsed.decision).toBe("act");
    expect("afterSuccess" in parsed).toBe(false);
  });

  it("tolerates toolId-style capability (underscore) by normalizing to dot notation", () => {
    // LLM 可能填 music_play_track（toolId）而非 music.play_track（capability）
    const parsed = parseActionDecisionResponse(toolCallResponse({
      decision: "act",
      capability: "music_play_track",
      objective: "播放",
      targetRefs: ["ctx_song_1"],
    }), ["music.play_track"]);
    expect(parsed.decision).toBe("act");
    if (parsed.decision === "act") {
      expect(parsed.capability).toBe("music.play_track");
    }
  });

  it("still throws E_ACTION_GATE_CAPABILITY_UNAVAILABLE for truly unknown capability", () => {
    expect(() => parseActionDecisionResponse(toolCallResponse({
      decision: "act",
      capability: "nonexistent.capability",
      objective: "播放",
      targetRefs: ["ctx_song_1"],
    }), ["music.play_track"])).toThrow("E_ACTION_GATE_CAPABILITY_UNAVAILABLE");
  });

  it("includes afterSuccess guidance in the system prompt", () => {
    const request = buildActionGateRequest({
      model: "test-model",
      originalQuery: "播放第四首",
      contextualizedQuery: "播放第四首",
      citaContextBlock: "",
      messages: [{ role: "user", content: "播放第四首" }],
      availableCapabilities: [{ capability: "music.play_track", toolId: "music_play_track", description: "播放歌曲" }],
      toolResults: [],
    });
    const content = String(request.messages[0].content);
    expect(content).toContain("afterSuccess");
    expect(content).toContain("单步任务");
    expect(content).toContain("多步任务");
  });

  it("parses respond and ask_user decisions", () => {
    expect(parseActionDecisionResponse(toolCallResponse({ decision: "respond" }), [])).toEqual({
      decision: "respond",
      reason: "ready_to_respond",
    });
    expect(parseActionDecisionResponse(toolCallResponse({
      decision: "ask_user",
      reason: "版本不明确",
    }), [])).toEqual({
      decision: "ask_user",
      reason: "版本不明确",
      missingInformation: [],
    });
  });

  it("throws E_ACTION_GATE_PROTOCOL when toolCalls is empty (LLM did not call the virtual tool)", () => {
    expect(() => parseActionDecisionResponse(emptyResponse("我来播放"), ["music.play_track"]))
      .toThrow("E_ACTION_GATE_PROTOCOL");
    expect(() => parseActionDecisionResponse(emptyResponse(), []))
      .toThrow("E_ACTION_GATE_PROTOCOL");
  });

  it("throws E_ACTION_GATE_PROTOCOL when the tool call name is not submit_decision", () => {
    expect(() => parseActionDecisionResponse(
      toolCallResponse({ decision: "respond" }, "wrong_tool_name"),
      [],
    )).toThrow("E_ACTION_GATE_PROTOCOL");
  });

  it("throws E_ACTION_GATE_PROTOCOL when tool arguments are not valid JSON", () => {
    const badResponse: ChatResponse = {
      assistantMessage: { role: "assistant", content: "" },
      text: "",
      toolCalls: [{ id: "call-1", name: "submit_decision", arguments: "not valid json" }],
      finishReason: "tool_calls",
      raw: {},
    };
    expect(() => parseActionDecisionResponse(badResponse, [])).toThrow("E_ACTION_GATE_PROTOCOL");
  });

  it("includes protocol feedback in a repair request", () => {
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

    expect(String(request.messages[0].content)).toContain("上一次决策未通过校验");
    expect(String(request.messages[0].content)).toContain("E_ACTION_GATE_PROTOCOL");
  });
});
