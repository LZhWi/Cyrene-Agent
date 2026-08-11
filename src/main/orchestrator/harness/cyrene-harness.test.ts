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
import type { HarnessCheckpoint, HarnessEvent } from "./types";
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

  it("checkpoints a cloned transcript after tool work and before terminal settlement", async () => {
    const { fn: fetchMock } = fakeFetchSequencer([
      assistantResponse({ toolCalls: [mutationToolCall("checkpoint-call")] }),
      assistantResponse({ text: "检查完成。" }),
    ]);
    vi.stubGlobal("fetch", fetchMock);
    mockedDispatch.mockResolvedValue(successDispatchResult("checkpoint-call"));
    const checkpoints: HarnessCheckpoint[] = [];

    await runCyreneHarness({
      systemPrompt: "you are a test agent",
      messages: [{ role: "user", content: "检查任务" }],
      tools: [],
      vendorConfig,
      onCheckpoint: (checkpoint) => checkpoints.push(checkpoint),
    });

    expect(checkpoints.some((checkpoint) => checkpoint.messages.some((message) => message.role === "tool"))).toBe(true);
    expect(checkpoints.at(-1)).toMatchObject({ rounds: 1 });
    const last = checkpoints.at(-1);
    if (!last) throw new Error("expected a terminal checkpoint");
    last.messages.push({ role: "user", content: "不能污染 Harness" });
    expect(checkpoints.at(-2)?.messages.some((message) => message.content === "不能污染 Harness")).toBe(false);
  });

  it("settles as a runtime error when a required checkpoint cannot be persisted", async () => {
    const { fn: fetchMock } = fakeFetchSequencer([
      assistantResponse({ text: "不能假装已经保存。" }),
    ]);
    vi.stubGlobal("fetch", fetchMock);

    const result = await runCyreneHarness({
      systemPrompt: "you are a test agent",
      messages: [{ role: "user", content: "执行任务" }],
      tools: [],
      vendorConfig,
      onCheckpoint: () => { throw new Error("disk unavailable"); },
    });

    expect(result.terminateReason).toBe("error");
    expect(result.finalAnswer).toContain("执行状态保存失败");
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

  it("shows the updated mutable Todo notebook to the next tool round", async () => {
    const updateCall: ToolCall = {
      id: "todo-1",
      name: "update_todo",
      arguments: JSON.stringify({
        todos: [{ id: "inspect", content: "检查项目结构", status: "in_progress" }],
      }),
    };
    const { fn: fetchMock } = fakeFetchSequencer([
      assistantResponse({ text: "先记一下步骤。", toolCalls: [updateCall] }),
      assistantResponse({ text: "现在继续检查。" }),
    ]);
    vi.stubGlobal("fetch", fetchMock);
    mockedDispatch.mockImplementation(async (_call, ctx) => {
      ctx.state.todoItems = [{ id: "inspect", content: "检查项目结构", status: "in_progress" }];
      return {
        outcome: "success",
        tool: "update_todo",
        message: "待办列表已更新",
        output: "{}",
      };
    });

    await runCyreneHarness({
      systemPrompt: "base prompt",
      messages: [{ role: "user", content: "检查并修复这个项目" }],
      tools: [],
      vendorConfig,
    });

    const firstRequest = fakeStreamChatWithSdk.mock.calls[0][0].request as { messages: ChatMessage[] };
    const secondRequest = fakeStreamChatWithSdk.mock.calls[1][0].request as { messages: ChatMessage[] };
    expect(firstRequest.messages[0].content).toContain("当前工作笔记为空");
    expect(secondRequest.messages[0].content).toContain("[in_progress] inspect: 检查项目结构");
    expect(secondRequest.messages[0].content).toContain(`binding="false"`);
  });

  it("resumes the same Harness run after a complete Ask observation", async () => {
    const askCall: ToolCall = {
      id: "ask-mixed",
      name: "ask_user",
      arguments: JSON.stringify({
        questions: [
          { id: "format", question: "格式？", type: "single_select", options: [{ label: "Markdown", value: "md" }, { label: "Word", value: "docx" }] },
          { id: "sections", question: "章节？", type: "multi_select", options: [{ label: "摘要", value: "summary" }, { label: "风险", value: "risks" }] },
          { id: "note", question: "补充要求？", type: "text" },
        ],
      }),
    };
    const { fn: fetchMock } = fakeFetchSequencer([
      assistantResponse({ text: "先确认几个选择。", toolCalls: [askCall] }),
      assistantResponse({ text: "已经按你的选择继续完成。" }),
    ]);
    vi.stubGlobal("fetch", fetchMock);
    mockedDispatch.mockResolvedValue({
      outcome: "success",
      tool: "ask_user",
      message: "用户已回答 3 个问题",
      output: JSON.stringify({
        answers: [
          { questionId: "format", selectedValues: ["md"], selectedLabels: ["Markdown"] },
          { questionId: "sections", selectedValues: ["summary", "risks"], selectedLabels: ["摘要", "风险"] },
          { questionId: "note", customInput: "停止当前任务" },
        ],
      }),
    });

    const result = await runCyreneHarness({
      systemPrompt: "base prompt",
      messages: [{ role: "user", content: "完成方案" }],
      tools: [],
      vendorConfig,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.finalAnswer).toBe("已经按你的选择继续完成。");
    const secondRequest = fakeStreamChatWithSdk.mock.calls[1][0].request as { messages: ChatMessage[] };
    expect(JSON.stringify(secondRequest.messages)).toContain("停止当前任务");
  });
});
