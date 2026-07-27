import { describe, expect, it, vi } from "vitest";
import { CyreneAgent, classifyAbortError } from "./cyrene-agent";
import { runTwoPhaseFcLoop } from "./two-phase-fc-loop";
import { runLangGraphAgentLoop } from "./langgraph-agent-loop";
import { requestUserClarification } from "../user-choice";

vi.mock("./vendors", () => ({
  getAdapterForConfig: vi.fn(() => ({ id: "fake-adapter" })),
}));

vi.mock("./tool-registry", () => ({
  toolRegistry: {
    getEnabledTools: vi.fn(() => []),
    getById: vi.fn(),
  },
}));

vi.mock("../permission", () => ({
  checkPermission: vi.fn(),
}));

vi.mock("./two-phase-fc-loop", () => ({
  runTwoPhaseFcLoop: vi.fn(async () => ({
    reply: "done",
    toolResults: [],
    soulPhaseReason: "no_tool",
  })),
}));

vi.mock("./langgraph-agent-loop", () => ({
  runLangGraphAgentLoop: vi.fn(async () => ({
    reply: "done",
    toolResults: [],
    soulPhaseReason: "no_tool",
  })),
}));

vi.mock("../user-choice", () => ({
  requestUserClarification: vi.fn(),
}));

describe("CyreneAgent", () => {
  it("passes CyreneRunOptions.soulSampling through to runTwoPhaseFcLoop", async () => {
    const agent = new CyreneAgent({ threadId: "test-thread" });
    const soulSampling = { temperature: 0.9, frequencyPenalty: 0.2 };

    await new Promise<void>((resolve, reject) => {
      agent.runWithEvents({
        settings: {
          provider: "test",
          baseUrl: "https://test",
          model: "m",
          apiKey: "k",
        },
        messages: [{ role: "user", content: "hi" }],
        timeoutMs: 1000,
        tools: [],
        toolSystemContent: "TOOL",
        soulSystemBaseContent: "SOUL",
        soulSampling,
        executionMode: "work",
        agentRuntime: "legacy",
      }).subscribe({
        complete: resolve,
        error: reject,
      });
    });

    expect(runTwoPhaseFcLoop).toHaveBeenCalledWith(expect.objectContaining({
      soulSampling,
    }));
  });

  it("wires the AG-UI choice-card callback into the LangGraph runtime", async () => {
    const agent = new CyreneAgent({ threadId: "test-thread" });

    await new Promise<void>((resolve, reject) => {
      agent.runWithEvents({
        settings: {
          provider: "test",
          baseUrl: "https://test",
          model: "m",
          apiKey: "k",
        },
        messages: [{ role: "user", content: "播放这首歌" }],
        timeoutMs: 1000,
        tools: [],
        toolSystemContent: "TOOL",
        soulSystemBaseContent: "SOUL",
        executionMode: "work",
        agentRuntime: "langgraph",
      }).subscribe({
        complete: resolve,
        error: reject,
      });
    });

    expect(runLangGraphAgentLoop).toHaveBeenCalledWith(expect.objectContaining({
      requestUserClarification,
    }));
  });
});

describe("classifyAbortError", () => {
  it("returns user_cancelled with empty message when source is user_cancelled", () => {
    const result = classifyAbortError(
      new DOMException("aborted", "AbortError"),
      "user_cancelled",
      "run-1", "conv-1", "soul", true,
    );
    expect(result.source).toBe("user_cancelled");
    expect(result.userMessage).toBe("");
  });

  it("returns call_timeout with phase-aware message when in soul with tool results", () => {
    const result = classifyAbortError(
      new DOMException("aborted", "AbortError"),
      "call_timeout",
      "run-2", "conv-2", "soul", true,
    );
    expect(result.source).toBe("call_timeout");
    expect(result.userMessage).toContain("工具结果已获得");
    expect(result.userMessage).toContain("超时");
  });

  it("returns call_timeout with generic message when before soul (no tool results)", () => {
    const result = classifyAbortError(
      new DOMException("aborted", "AbortError"),
      "call_timeout",
      "run-3", "conv-3", "decide", false,
    );
    expect(result.source).toBe("call_timeout");
    expect(result.userMessage).toBe("请求处理超时，请重试。");
    expect(result.userMessage).not.toContain("工具结果");
  });

  it("returns run_timeout for E_AGENT_GRAPH_TIMEOUT", () => {
    const result = classifyAbortError(
      new Error("E_AGENT_GRAPH_TIMEOUT"),
      undefined,
      "run-4", "conv-4", "execute", false,
    );
    expect(result.source).toBe("run_timeout");
    expect(result.userMessage).toBe("请求处理超时，请重试。");
  });

  it("returns run_timeout with tool-result message when in soul phase", () => {
    const result = classifyAbortError(
      new Error("E_AGENT_GRAPH_TIMEOUT"),
      undefined,
      "run-5", "conv-5", "soul", true,
    );
    expect(result.source).toBe("run_timeout");
    expect(result.userMessage).toContain("工具结果已获得");
  });

  it("returns unknown_abort when abortSource is undefined and error is AbortError", () => {
    const result = classifyAbortError(
      new DOMException("aborted", "AbortError"),
      undefined,
      "run-6", "conv-6", "unknown", false,
    );
    expect(result.source).toBe("unknown_abort");
    expect(result.userMessage).toBe("操作已中断，请重试。");
  });

  it("returns not_abort for non-abort errors", () => {
    const result = classifyAbortError(
      new Error("E_MODEL_REQUEST_FAILED"),
      undefined,
      "run-7", "conv-7", "decide", false,
    );
    expect(result.source).toBe("upstream_cleanup");
    expect(result.userMessage).toBe("E_MODEL_REQUEST_FAILED");
  });

  it("includes runId, conversationId, phase in diagnostics", () => {
    const result = classifyAbortError(
      new DOMException("aborted", "AbortError"),
      "call_timeout",
      "run-xyz", "conv-abc", "soul", true,
    );
    expect(result.diagnostics.runId).toBe("run-xyz");
    expect(result.diagnostics.conversationId).toBe("conv-abc");
    expect(result.diagnostics.phase).toBe("soul");
    expect(result.diagnostics.hasToolResults).toBe(true);
  });

  it("never contains raw English AbortError text in userMessage", () => {
    const result = classifyAbortError(
      new DOMException("This operation was aborted", "AbortError"),
      "upstream_cleanup",
      "run-8", "conv-8", "soul", true,
    );
    expect(result.userMessage).not.toContain("aborted");
    expect(result.userMessage).not.toContain("AbortError");
    expect(result.userMessage).not.toContain("operation");
  });

  it("call timeout after unsubscribe still classifies as call_timeout (first-source-wins)", () => {
    // 模拟：先 call_timeout，然后 user_cancelled
    // 由于 first-source-wins，abortSource 应该是 call_timeout
    const result = classifyAbortError(
      new DOMException("aborted", "AbortError"),
      "call_timeout",  // 第一个来源
      "run-9", "conv-9", "soul", true,
    );
    expect(result.source).toBe("call_timeout");
    expect(result.userMessage).toContain("超时");
  });
});
