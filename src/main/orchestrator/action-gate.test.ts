import { describe, expect, it } from "vitest";
import {
  buildActionGateRequest,
  parseActionDecisionResponse,
  ActionGateProtocolError,
  type BuildActionGateRequestInput,
} from "./action-gate";
import type { ActionGateStrategy } from "./vendors/action-gate-profiles";
import type { ChatResponse, ToolCall } from "./vendors/types";

// ── 测试辅助 ─────────────────────────────────────────────

function toolCallResponse(args: object, name = "submit_decision"): ChatResponse {
  const toolCall: ToolCall = { id: `call-${Date.now()}`, name, arguments: JSON.stringify(args) };
  return {
    assistantMessage: { role: "assistant", content: "", toolCalls: [toolCall] },
    text: "",
    toolCalls: [toolCall],
    finishReason: "tool_calls",
    raw: {},
  };
}

function textResponse(text: string): ChatResponse {
  return {
    assistantMessage: { role: "assistant", content: text },
    text,
    toolCalls: [],
    finishReason: "stop",
    raw: {},
  };
}

function emptyResponse(): ChatResponse {
  return { assistantMessage: { role: "assistant", content: "" }, text: "", toolCalls: [], finishReason: "stop", raw: {} };
}

function baseInput(strategy: ActionGateStrategy, protocolFeedback?: string): BuildActionGateRequestInput {
  return {
    model: "test-model",
    originalQuery: "播放第一首",
    contextualizedQuery: "播放当前网易云日推第一首",
    citaContextBlock: "",
    messages: [{ role: "user", content: "播放第一首" }],
    availableCapabilities: [{ capability: "music.play_track", toolId: "music_play_track", description: "播放歌曲" }],
    toolResults: [],
    strategy,
    ...(protocolFeedback ? { protocolFeedback } : {}),
  };
}

// ── buildActionGateRequest 测试 ──────────────────────────

describe("buildActionGateRequest", () => {
  it("includes tools + named override for named_decision_tool strategy", () => {
    const request = buildActionGateRequest(baseInput("named_decision_tool"));
    expect(request.tools).toHaveLength(1);
    expect(request.tools?.[0].name).toBe("submit_decision");
    expect(request.toolChoiceOverride).toEqual({ kind: "named", toolName: "submit_decision" });
  });

  it("includes tools + required override for required_single_decision_tool strategy", () => {
    const request = buildActionGateRequest(baseInput("required_single_decision_tool"));
    expect(request.tools).toHaveLength(1);
    expect(request.toolChoiceOverride).toEqual({ kind: "required" });
  });

  it("includes tools + auto override for auto_single_decision_tool_with_json_fallback", () => {
    const request = buildActionGateRequest(baseInput("auto_single_decision_tool_with_json_fallback"));
    expect(request.tools).toHaveLength(1);
    expect(request.toolChoiceOverride).toEqual({ kind: "auto" });
  });

  it("includes tools + omit override for omit_tool_choice_with_json_fallback", () => {
    const request = buildActionGateRequest(baseInput("omit_tool_choice_with_json_fallback"));
    expect(request.tools).toHaveLength(1);
    expect(request.toolChoiceOverride).toEqual({ kind: "omit" });
  });

  it("omits tools entirely for plain_json_text strategy", () => {
    const request = buildActionGateRequest(baseInput("plain_json_text"));
    expect(request.tools).toBeUndefined();
    expect(request.toolChoiceOverride).toBeUndefined();
    expect(String(request.messages[0].content)).toContain("只输出一个 JSON 对象");
  });

  it("includes strategy-specific protocol feedback in repair request", () => {
    const request = buildActionGateRequest(baseInput("named_decision_tool", "MISSING_DECISION_TOOL_CALL"));
    const content = String(request.messages[0].content);
    expect(content).toContain("MISSING_DECISION_TOOL_CALL");
    expect(content).toContain("只提交一个 submit_decision 工具调用");
  });

  it("includes different protocol feedback for plain_json_text strategy", () => {
    const request = buildActionGateRequest(baseInput("plain_json_text", "INVALID_TEXT_JSON"));
    const content = String(request.messages[0].content);
    expect(content).toContain("INVALID_TEXT_JSON");
    expect(content).toContain("只输出一个完整 JSON 对象");
    expect(content).toContain("不得调用工具");
  });
});

// ── parseActionDecisionResponse 测试 ─────────────────────

describe("parseActionDecisionResponse", () => {
  const caps = ["music.play_track"];

  // ── A. 强制模式（named/required）：合法 ToolCall ──
  it("parses act decision from submit_decision tool call in forced mode", () => {
    const result = parseActionDecisionResponse({
      response: toolCallResponse({ decision: "act", capability: "music.play_track", objective: "播放", targetRefs: ["ctx_1"], afterSuccess: "respond" }),
      strategy: "named_decision_tool",
      availableCapabilities: caps,
    });
    expect(result).toEqual({ decision: "act", capability: "music.play_track", objective: "播放", targetRefs: ["ctx_1"], afterSuccess: "respond" });
  });

  // ── B. 强制模式：无 ToolCall -> 不允许文本兜底 ──
  it("throws MISSING_DECISION_TOOL_CALL when forced mode has no tool call", () => {
    expect(() => parseActionDecisionResponse({
      response: textResponse('{"decision":"respond"}'),
      strategy: "named_decision_tool",
      availableCapabilities: caps,
    })).toThrow(ActionGateProtocolError);
    try {
      parseActionDecisionResponse({ response: textResponse('{"decision":"respond"}'), strategy: "named_decision_tool", availableCapabilities: caps });
    } catch (e) {
      expect((e as ActionGateProtocolError).code).toBe("MISSING_DECISION_TOOL_CALL");
    }
  });

  // ── C. 强制模式：arguments 非法 ──
  it("throws INVALID_TOOL_ARGUMENTS_JSON when tool call arguments are not valid JSON", () => {
    const badResponse: ChatResponse = {
      assistantMessage: { role: "assistant", content: "" },
      text: "",
      toolCalls: [{ id: "call-1", name: "submit_decision", arguments: "not json" }],
      finishReason: "tool_calls",
      raw: {},
    };
    expect(() => parseActionDecisionResponse({ response: badResponse, strategy: "named_decision_tool", availableCapabilities: caps }))
      .toThrow(ActionGateProtocolError);
    try {
      parseActionDecisionResponse({ response: badResponse, strategy: "named_decision_tool", availableCapabilities: caps });
    } catch (e) {
      expect((e as ActionGateProtocolError).code).toBe("INVALID_TOOL_ARGUMENTS_JSON");
    }
  });

  // ── D. 强制模式：错误工具名 ──
  it("throws UNEXPECTED_TOOL_NAME when tool call name is not submit_decision", () => {
    expect(() => parseActionDecisionResponse({
      response: toolCallResponse({ decision: "respond" }, "wrong_tool"),
      strategy: "named_decision_tool",
      availableCapabilities: caps,
    })).toThrow(ActionGateProtocolError);
  });

  // ── E. best-effort 模式（auto/omit）：有 ToolCall -> 解析 ──
  it("parses tool call in best-effort mode when tool call is present", () => {
    const result = parseActionDecisionResponse({
      response: toolCallResponse({ decision: "respond" }),
      strategy: "auto_single_decision_tool_with_json_fallback",
      availableCapabilities: caps,
    });
    expect(result).toEqual({ decision: "respond", reason: "ready_to_respond" });
  });

  // ── F. best-effort 模式：无 ToolCall + 合法文本 JSON -> 兜底 ──
  it("falls back to text JSON in best-effort mode when no tool call", () => {
    const result = parseActionDecisionResponse({
      response: textResponse('{"decision":"respond"}'),
      strategy: "auto_single_decision_tool_with_json_fallback",
      availableCapabilities: caps,
    });
    expect(result).toEqual({ decision: "respond", reason: "ready_to_respond" });
  });

  // ── G. best-effort 模式：无 ToolCall + 非法文本 -> 报错 ──
  it("throws INVALID_TEXT_JSON in best-effort mode when text is not valid JSON", () => {
    expect(() => parseActionDecisionResponse({
      response: textResponse("not json at all"),
      strategy: "omit_tool_choice_with_json_fallback",
      availableCapabilities: caps,
    })).toThrow(ActionGateProtocolError);
    try {
      parseActionDecisionResponse({ response: textResponse("not json"), strategy: "omit_tool_choice_with_json_fallback", availableCapabilities: caps });
    } catch (e) {
      expect((e as ActionGateProtocolError).code).toBe("INVALID_TEXT_JSON");
    }
  });

  // ── H. plain_json_text 模式：有 ToolCall -> 报错（GPT 第 5 点）──
  it("throws UNEXPECTED_TOOL_CALL_IN_TEXT_MODE when plain_json_text receives a tool call", () => {
    expect(() => parseActionDecisionResponse({
      response: toolCallResponse({ decision: "respond" }),
      strategy: "plain_json_text",
      availableCapabilities: caps,
    })).toThrow(ActionGateProtocolError);
    try {
      parseActionDecisionResponse({ response: toolCallResponse({ decision: "respond" }), strategy: "plain_json_text", availableCapabilities: caps });
    } catch (e) {
      expect((e as ActionGateProtocolError).code).toBe("UNEXPECTED_TOOL_CALL_IN_TEXT_MODE");
    }
  });

  // ── I. plain_json_text 模式：合法文本 JSON -> 解析 ──
  it("parses text JSON in plain_json_text mode", () => {
    const result = parseActionDecisionResponse({
      response: textResponse('{"decision":"respond","reason":"done"}'),
      strategy: "plain_json_text",
      availableCapabilities: caps,
    });
    expect(result).toEqual({ decision: "respond", reason: "done" });
  });

  // ── J. plain_json_text 模式：空文本 -> 报错 ──
  it("throws INVALID_TEXT_JSON in plain_json_text mode when text is empty", () => {
    expect(() => parseActionDecisionResponse({
      response: emptyResponse(),
      strategy: "plain_json_text",
      availableCapabilities: caps,
    })).toThrow(ActionGateProtocolError);
  });

  // ── K. capability 容错匹配（toolId -> capability）──
  it("tolerates toolId-style capability by normalizing to dot notation", () => {
    const result = parseActionDecisionResponse({
      response: toolCallResponse({ decision: "act", capability: "music_play_track", objective: "播放", targetRefs: ["ctx_1"] }),
      strategy: "named_decision_tool",
      availableCapabilities: caps,
    });
    expect(result.decision).toBe("act");
    if (result.decision === "act") {
      expect(result.capability).toBe("music.play_track");
    }
  });

  // ── L. afterSuccess 解析 ──
  it("parses afterSuccess=replan for multi-step tasks", () => {
    const result = parseActionDecisionResponse({
      response: toolCallResponse({ decision: "act", capability: "music.play_track", objective: "播放", targetRefs: ["ctx_1"], afterSuccess: "replan" }),
      strategy: "named_decision_tool",
      availableCapabilities: caps,
    });
    expect(result).toEqual({ decision: "act", capability: "music.play_track", objective: "播放", targetRefs: ["ctx_1"], afterSuccess: "replan" });
  });

  it("omits afterSuccess when not declared", () => {
    const result = parseActionDecisionResponse({
      response: toolCallResponse({ decision: "act", capability: "music.play_track", objective: "播放", targetRefs: ["ctx_1"] }),
      strategy: "named_decision_tool",
      availableCapabilities: caps,
    });
    expect(result.decision).toBe("act");
    expect("afterSuccess" in result).toBe(false);
  });

  // ── M. <think> 标签防御：stripThinkBlocks 后正确解析 ──
  it("strips <think> tags and parses JSON in best-effort mode", () => {
    const result = parseActionDecisionResponse({
      response: textResponse('<think>用户要公式，直接回复</think>\n{"decision":"respond","reason":"ok"}'),
      strategy: "auto_single_decision_tool_with_json_fallback",
      availableCapabilities: caps,
    });
    expect(result).toEqual({ decision: "respond", reason: "ok" });
  });

  it("strips multiple <think> blocks and parses JSON", () => {
    const result = parseActionDecisionResponse({
      response: textResponse('<think>第一段思考</think>\n<think>第二段思考</think>\n{"decision":"respond"}'),
      strategy: "plain_json_text",
      availableCapabilities: caps,
    });
    expect(result).toEqual({ decision: "respond", reason: "ready_to_respond" });
  });

  it("strips multiline <think> blocks", () => {
    const result = parseActionDecisionResponse({
      response: textResponse('<think>\n多行\n思考\n内容\n</think>\n{"decision":"respond","reason":"done"}'),
      strategy: "plain_json_text",
      availableCapabilities: caps,
    });
    expect(result).toEqual({ decision: "respond", reason: "done" });
  });

  it("throws INVALID_TEXT_JSON when only <think> tags exist", () => {
    expect(() => parseActionDecisionResponse({
      response: textResponse("<think>只有思考没有 JSON</think>"),
      strategy: "plain_json_text",
      availableCapabilities: caps,
    })).toThrow(ActionGateProtocolError);
    try {
      parseActionDecisionResponse({ response: textResponse("<think>只有思考</think>"), strategy: "plain_json_text", availableCapabilities: caps });
    } catch (e) {
      expect((e as ActionGateProtocolError).code).toBe("INVALID_TEXT_JSON");
    }
  });

  it("throws INVALID_TEXT_JSON when <think> is unclosed and no JSON follows", () => {
    expect(() => parseActionDecisionResponse({
      response: textResponse("<think>未闭合的思考"),
      strategy: "plain_json_text",
      availableCapabilities: caps,
    })).toThrow(ActionGateProtocolError);
  });

  it("parses JSON with leading/trailing whitespace after think strip", () => {
    const result = parseActionDecisionResponse({
      response: textResponse('  <think>x</think>  \n  {"decision":"respond"}  '),
      strategy: "plain_json_text",
      availableCapabilities: caps,
    });
    expect(result.decision).toBe("respond");
  });

  it("still parses clean JSON without think tags", () => {
    const result = parseActionDecisionResponse({
      response: textResponse('{"decision":"respond","reason":"clean"}'),
      strategy: "plain_json_text",
      availableCapabilities: caps,
    });
    expect(result).toEqual({ decision: "respond", reason: "clean" });
  });
});
