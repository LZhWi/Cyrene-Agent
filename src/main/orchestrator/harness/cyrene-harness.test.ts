/**
 * Task 1 (P0-A) 失败测试：移除 Runtime-owned completion workflow
 *
 * 验收不变量（plan §Acceptance Invariants 第 1、2、10 条）：
 * - Model no-tool response -> final immediately
 * - Runtime has no continue_agent settlement
 * - UncertainEffectGuard never blocks honest final
 *
 * 这里只断言 P0-A 的核心：模型不再调用工具时立即结束，
 * Runtime 不再因 completionObligations 或 uncertainEffects 否决 final。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoisted mocks（必须在 import SUT 之前）──────────────

const { fakeAdapter, fakeStreamChatWithSdk } = vi.hoisted(() => {
  const adapter = {
    id: "fake",
    buildRequest: (req: unknown) => ({
      url: "https://fake.local/chat",
      method: "POST" as const,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    }),
    parseResponse: (raw: unknown) => raw,
  };
  return {
    fakeAdapter: adapter,
    fakeStreamChatWithSdk: vi.fn(async (input: {
      adapter: typeof adapter;
      request: unknown;
      config: unknown;
      signal?: AbortSignal;
    }) => {
      const http = input.adapter.buildRequest(input.request);
      const response = await fetch(http.url, {
        method: "POST",
        headers: http.headers,
        body: http.body,
        signal: input.signal,
      });
      return input.adapter.parseResponse(await response.json());
    }),
  };
});

vi.mock("../vendors", () => ({
  getAdapterForConfig: vi.fn(() => fakeAdapter),
  streamChatWithSdk: fakeStreamChatWithSdk,
}));

vi.mock("./tool-dispatcher", () => ({
  dispatchToolCall: vi.fn(),
}));

import { runCyreneHarness } from "./cyrene-harness";
import { dispatchToolCall } from "./tool-dispatcher";
import type { ToolDispatchResult } from "./tool-dispatcher";
import type { HarnessEvent } from "./types";
import type { ChatMessage, ChatResponse, ToolCall } from "../vendors/types";
import type { ToolDefinition } from "../tool-registry";

const mockedDispatch = vi.mocked(dispatchToolCall);

// ── Helpers ────────────────────────────────────────────

function assistantResponse(opts: { text?: string; toolCalls?: ToolCall[] }): ChatResponse {
  const text = opts.text ?? "";
  const toolCalls = opts.toolCalls ?? [];
  const assistantMessage: ChatMessage = {
    role: "assistant",
    content: text,
    ...(toolCalls.length ? { toolCalls } : {}),
  };
  return {
    assistantMessage,
    text,
    toolCalls,
    finishReason: toolCalls.length ? "tool_calls" : "stop",
    raw: {},
  };
}

function fakeFetchSequencer(responses: ChatResponse[]) {
  const calls: unknown[] = [];
  const fn = vi.fn(async (_url: unknown, _init?: unknown) => {
    const next = responses.shift();
    if (!next) {
      throw new Error("test: fetch sequencer exhausted");
    }
    return {
      ok: true,
      json: async () => next,
    } as unknown as Response;
  });
  return { fn, calls };
}

function mutationToolCall(id = "call-1"): ToolCall {
  return {
    id,
    name: "write_file",
    arguments: JSON.stringify({ path: "/tmp/x", content: "hello" }),
  };
}

function successDispatchResult(callId = "call-1"): ToolDispatchResult {
  return {
    outcome: "success",
    tool: "write_file",
    target: "/tmp/x",
    message: '{"success":true,"path":"/tmp/x","sizeBytes":5}',
    output: '{"success":true,"path":"/tmp/x","sizeBytes":5}',
    truncated: false,
    preview: '{"success":true,"path":"/tmp/x","sizeBytes":5}',
    rawResult: {
      toolId: "write_file",
      args: { path: "/tmp/x", content: "hello" },
      output: '{"success":true,"path":"/tmp/x","sizeBytes":5}',
      status: "succeeded",
      terminal: true,
      retryable: false,
    },
  };
}

function unknownDispatchResult(callId = "call-1"): ToolDispatchResult {
  return {
    outcome: "unknown",
    tool: "send_email",
    target: "x@y",
    message: "副作用已发起，但 Runtime 无法确认是否生效",
    rawResult: {
      toolId: "send_email",
      args: { to: "x@y" },
      output: "",
      status: "failed",
      terminal: true,
      retryable: false,
    },
  };
}

const vendorConfig = {
  provider: "fake",
  baseUrl: "https://fake.local",
  model: "fake-model",
  apiKey: "fake-key",
} as unknown as Parameters<typeof runCyreneHarness>[0]["vendorConfig"];

function sendEmailTool(): ToolDefinition {
  return {
    id: "send_email",
    name: "Send Email",
    description: "send an email",
    enabled: true,
    inputSchema: {
      type: "object",
      properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" } },
    },
    effectKind: "external_side_effect",
    execute: vi.fn(),
  };
}

// ── Tests ──────────────────────────────────────────────

describe("CyreneHarness completion (P0-A)", () => {
  beforeEach(() => {
    mockedDispatch.mockReset();
    fakeStreamChatWithSdk.mockClear();
  });

  it("uses the SDK stream runner with native tools enabled", async () => {
    const { fn: fetchMock } = fakeFetchSequencer([
      assistantResponse({ text: "直接完成。" }),
    ]);
    vi.stubGlobal("fetch", fetchMock);

    const result = await runCyreneHarness({
      systemPrompt: "you are a test agent",
      messages: [{ role: "user", content: "完成任务" }],
      tools: [],
      vendorConfig,
    });

    expect(result.finalAnswer).toBe("直接完成。");
    expect(fakeStreamChatWithSdk).toHaveBeenCalledTimes(1);
    expect(fakeStreamChatWithSdk).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({ stream: true, tools: expect.any(Array) }),
    }));
  });

  it("forwards only provider-returned reasoning deltas to the process stream", async () => {
    fakeStreamChatWithSdk.mockImplementationOnce(async (input: {
      adapter: typeof fakeAdapter;
      request: unknown;
      config: unknown;
      signal?: AbortSignal;
      onDelta?: (delta: { type: "reasoning_delta"; delta: string }) => void;
    }) => {
      input.onDelta?.({ type: "reasoning_delta", delta: "先检查" });
      input.onDelta?.({ type: "reasoning_delta", delta: "，再回答" });
      return assistantResponse({ text: "完成。" });
    });
    const events: HarnessEvent[] = [];

    await runCyreneHarness({
      systemPrompt: "you are a test agent",
      messages: [{ role: "user", content: "完成任务" }],
      tools: [],
      vendorConfig,
      onEvent: (event) => events.push(event),
    });

    expect(events.filter((event) => event.type.startsWith("reasoning_")).slice(0, 3)).toEqual([
      { type: "reasoning_start", messageId: "reasoning-0" },
      { type: "reasoning_delta", messageId: "reasoning-0", delta: "先检查" },
      { type: "reasoning_delta", messageId: "reasoning-0", delta: "，再回答" },
    ]);
    expect(events).toContainEqual({ type: "reasoning_end", messageId: "reasoning-0" });
  });

  it("falls back to a non-stream request only when the provider explicitly rejects streaming", async () => {
    fakeStreamChatWithSdk.mockRejectedValueOnce(Object.assign(
      new Error("streaming is not supported; stream must be false"),
      { status: 400 },
    ));
    const { fn: fetchMock } = fakeFetchSequencer([
      assistantResponse({ text: "降级完成。" }),
    ]);
    vi.stubGlobal("fetch", fetchMock);

    const result = await runCyreneHarness({
      systemPrompt: "you are a test agent",
      messages: [{ role: "user", content: "完成任务" }],
      tools: [],
      vendorConfig,
    });

    expect(result.finalAnswer).toBe("降级完成。");
    expect(fakeStreamChatWithSdk).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string)).toMatchObject({ stream: false });
  });

  it("never retries after any partial stream delta", async () => {
    fakeStreamChatWithSdk.mockImplementationOnce(async (input: {
      adapter: typeof fakeAdapter;
      request: unknown;
      config: unknown;
      signal?: AbortSignal;
      onDelta?: (delta: { type: "reasoning_delta"; delta: string }) => void;
    }) => {
      input.onDelta?.({ type: "reasoning_delta", delta: "已经开始" });
      throw Object.assign(new Error("streaming is not supported"), { status: 400 });
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await runCyreneHarness({
      systemPrompt: "you are a test agent",
      messages: [{ role: "user", content: "完成任务" }],
      tools: [],
      vendorConfig,
    });

    expect(result.terminateReason).toBe("error");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("accepts model final immediately after a mutation tool succeeds, without runtime_feedback", async () => {
    const { fn: fetchMock } = fakeFetchSequencer([
      assistantResponse({ toolCalls: [mutationToolCall("call-1")] }),
      assistantResponse({ text: "已创建文件。" }),
    ]);
    vi.stubGlobal("fetch", fetchMock);

    mockedDispatch.mockResolvedValue(successDispatchResult("call-1"));

    const events: HarnessEvent[] = [];
    const result = await runCyreneHarness({
      systemPrompt: "you are a test agent",
      messages: [{ role: "user", content: "创建一个文件" }],
      tools: [],
      vendorConfig,
      onEvent: (e) => events.push(e),
    });

    // 只调用过两次模型；不再有第三次循环
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // 不再有 runtime_feedback 事件
    expect(events.filter((e) => e.type === "runtime_feedback")).toEqual([]);
    // final 被接受
    expect(result.finalAnswer).toBe("已创建文件。");
    // finalState 不再拥有 completionObligations 字段
    expect("completionObligations" in result.finalState).toBe(false);
    // 自然结束（非超时、非取消）
    expect(result.terminated).toBe(false);
    expect(result.terminateReason).toBeUndefined();
    expect(events.filter((event) => event.type === "round_start" || event.type === "round_end")).toEqual([
      { type: "round_start", roundId: "round-0" },
      { type: "round_end", roundId: "round-0" },
      { type: "round_start", roundId: "round-1" },
      { type: "round_end", roundId: "round-1" },
    ]);
    expect(events.findIndex((event) => event.type === "round_end" && event.roundId === "round-1"))
      .toBeLessThan(events.findIndex((event) => event.type === "final_answer"));
  });

  it("accepts honest final after an unknown non-idempotent side effect; uncertainEffects retained", async () => {
    const { fn: fetchMock } = fakeFetchSequencer([
      assistantResponse({
        toolCalls: [
          { id: "call-1", name: "send_email", arguments: JSON.stringify({ to: "x@y", subject: "s", body: "b" }) },
        ],
      }),
      assistantResponse({ text: "我无法确认刚才的外部操作是否成功。" }),
    ]);
    vi.stubGlobal("fetch", fetchMock);

    mockedDispatch.mockResolvedValue(unknownDispatchResult("call-1"));

    const events: HarnessEvent[] = [];
    const result = await runCyreneHarness({
      systemPrompt: "you are a test agent",
      messages: [{ role: "user", content: "发邮件" }],
      tools: [sendEmailTool()],
      vendorConfig,
      onEvent: (e) => events.push(e),
    });

    // 只调用过两次模型
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // 没有 runtime_feedback 阻止 final
    expect(events.filter((e) => e.type === "runtime_feedback")).toEqual([]);
    // 模型的诚实 final 被接受
    expect(result.finalAnswer).toBe("我无法确认刚才的外部操作是否成功。");
    // finalState 没有 completionObligations
    expect("completionObligations" in result.finalState).toBe(false);
    // uncertainEffects 仍作为事实保留
    expect(result.finalState.uncertainEffects).toHaveLength(1);
    expect(result.finalState.uncertainEffects[0]?.toolName).toBe("send_email");
    // 自然结束
    expect(result.terminated).toBe(false);
    expect(result.terminateReason).toBeUndefined();
  });
});
