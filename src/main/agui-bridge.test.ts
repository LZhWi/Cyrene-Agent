import { describe, expect, it, vi } from "vitest";
import { Observable } from "rxjs";
import { IPC } from "../shared/ipc-channels";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => unknown>(),
  getSession: vi.fn(),
  runCodeRequest: vi.fn(),
  runCyreneAgent: vi.fn(),
  requestUserClarification: vi.fn(),
  agentEvents: [] as unknown[],
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: any[]) => unknown) => {
      mocks.handlers.set(channel, handler);
    }),
  },
}));

vi.mock("./orchestrator/cyrene-agent", () => ({
  CyreneAgent: class {
    threadId: string;
    lastResult?: { reply: string; toolResults: unknown[] };

    constructor(input: { threadId: string }) {
      this.threadId = input.threadId;
    }

    runWithEvents(options: unknown) {
      mocks.runCyreneAgent(options);
      return new Observable((subscriber) => {
        this.lastResult = { reply: "抱抱你", toolResults: [] };
        subscriber.next({ type: "RUN_STARTED" });
        for (const event of mocks.agentEvents) subscriber.next(event);
        subscriber.next({ type: "RUN_FINISHED" });
        subscriber.complete();
      });
    }
  },
}));

vi.mock("./orchestrator/history-tools", () => ({
  indexConversationTurn: vi.fn(),
}));

vi.mock("./chats/chats-store", () => ({
  getSession: mocks.getSession,
}));

vi.mock("./orchestrator/code/code-request", () => ({
  runCodeRequest: mocks.runCodeRequest,
}));

vi.mock("./user-choice", () => ({
  requestUserClarification: mocks.requestUserClarification,
}));

describe("agui-bridge sticker event ordering", () => {
  it("maps Cline text and reasoning deltas onto the AG-UI stream contract", async () => {
    const { normalizeCodeRendererEvent } = await import("./agui-bridge");

    expect(normalizeCodeRendererEvent({
      type: "agent_event",
      payload: { event: { type: "content_start", contentType: "text", text: "完成" } },
    })).toMatchObject({ type: "TEXT_MESSAGE_CONTENT", delta: "完成" });
    expect(normalizeCodeRendererEvent({
      type: "agent_event",
      payload: { event: { type: "content_start", contentType: "reasoning", reasoning: "分析" } },
    })).toMatchObject({ type: "REASONING_MESSAGE_CONTENT", delta: "分析" });
    expect(normalizeCodeRendererEvent({
      type: "agent_event",
      payload: { event: { type: "content_update", contentType: "text", text: "继续" } },
    })).toMatchObject({ type: "TEXT_MESSAGE_CONTENT", delta: "继续" });
  });

  it("maps Cline tool lifecycle events onto visible AG-UI tool states", async () => {
    const { normalizeCodeRendererEvent } = await import("./agui-bridge");

    expect(normalizeCodeRendererEvent({
      type: "agent_event",
      payload: { event: { type: "content_start", contentType: "tool", toolName: "apply_patch", toolCallId: "tool-1" } },
    })).toMatchObject({ type: "TOOL_CALL_START", toolCallName: "apply_patch", toolCallId: "tool-1" });
    expect(normalizeCodeRendererEvent({
      type: "agent_event",
      payload: { event: { type: "content_end", contentType: "tool", toolName: "apply_patch", toolCallId: "tool-1", output: "done" } },
    })).toMatchObject({ type: "TOOL_CALL_RESULT", toolCallId: "tool-1", content: "done", status: "success" });
  });

  it("maps Cline Ask presentations onto a React-consumable custom event", async () => {
    const { normalizeCodeRendererEvent } = await import("./agui-bridge");
    const ask = { promptId: "ask-1", question: "选择方案？", options: ["A", "B"] };

    expect(normalizeCodeRendererEvent({ type: "code_ask", payload: ask, runId: "run-1" })).toEqual({
      type: "CUSTOM",
      name: "code_ask",
      value: ask,
      runId: "run-1",
    });
  });

  it("routes structured Ask cards to the AG-UI run sender", async () => {
    vi.resetModules();
    mocks.handlers.clear();
    mocks.runCyreneAgent.mockClear();
    mocks.requestUserClarification.mockReset();
    mocks.getSession.mockReturnValue({
      id: "work-ask",
      mode: "work",
      workspaceBinding: { workspaceRoot: "C:\\workspace", displayName: "workspace", boundAt: 1 },
    });
    mocks.requestUserClarification.mockImplementation(async (_card, send, onSettled, identity) => {
      send({
        interactionId: "choice-1",
        runId: identity.runId,
        revision: identity.revision,
        mode: "semantic_clarification",
        intro: "需要确认",
        questions: [{
          id: "question-1",
          prompt: "选择格式？",
          required: true,
          multiple: false,
          options: [{ id: "word", label: "Word" }, { id: "pdf", label: "PDF" }],
          customInput: { enabled: true },
        }],
      });
      onSettled({ id: "choice-1", runId: identity.runId, revision: identity.revision, reason: "timeout" });
      return { requestId: "choice-1", answers: [] };
    });
    const { registerAgUiIpc } = await import("./agui-bridge");
    const sent: unknown[] = [];
    const sender = { isDestroyed: () => false, send: (_channel: string, event: unknown) => sent.push(event) };
    registerAgUiIpc(async () => ({
      options: {
        settings: { provider: "test", baseUrl: "", model: "", apiKey: "", contextWindowTokens: 256000 },
        messages: [], timeoutMs: 1000, toolSystemContent: "TOOL", soulSystemBaseContent: "SOUL",
      },
      latestUserText: "帮我生成一份文档",
    }), async () => {}, () => null);

    const handler = mocks.handlers.get(IPC.AGUI_RUN);
    if (!handler) throw new Error("AGUI_RUN handler was not registered");
    await handler({ sender }, { messages: [{ role: "user", content: "帮我生成一份文档" }], sessionId: "work-ask" });

    const options = mocks.runCyreneAgent.mock.calls[0]?.[0] as {
      requestUserClarification: (card: unknown) => Promise<unknown>;
    };
    await options.requestUserClarification({ intro: "需要确认", questions: [], deferredFields: [] });

    expect(mocks.requestUserClarification).toHaveBeenCalledOnce();
    expect(sent).toContainEqual(expect.objectContaining({
      type: "CUSTOM",
      name: "cyrene.choice",
      value: expect.objectContaining({ interactionId: "choice-1", runId: expect.any(String), revision: 1 }),
    }));
    expect(sent).toContainEqual(expect.objectContaining({
      type: "CUSTOM",
      name: "cyrene.choice.dismiss",
      value: expect.objectContaining({ id: "choice-1", runId: expect.any(String), revision: 1, reason: "timeout" }),
    }));
  });

  it("turns leading <think> text into reasoning events before forwarding the assistant start", async () => {
    vi.resetModules();
    mocks.handlers.clear();
    mocks.agentEvents = [
      { type: "TEXT_MESSAGE_START", messageId: "m1", role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "<think>先分析" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "问题</think>正式回答" },
      { type: "TEXT_MESSAGE_END", messageId: "m1" },
    ];
    mocks.getSession.mockReturnValue({ id: "chat-think", mode: "chat" });
    const { registerAgUiIpc } = await import("./agui-bridge");
    const sent: Array<{ type?: string; delta?: string }> = [];
    const sender = {
      isDestroyed: () => false,
      send: (_channel: string, event: { type?: string; delta?: string }) => sent.push(event),
    };
    registerAgUiIpc(
      async () => ({
        options: {
          settings: { provider: "test", baseUrl: "", model: "", apiKey: "", contextWindowTokens: 256000 },
          messages: [],
          timeoutMs: 1000,
          toolSystemContent: "TOOL",
          soulSystemBaseContent: "SOUL",
        },
        latestUserText: "解释一下",
      }),
      async () => {},
      () => null,
    );

    const handler = mocks.handlers.get(IPC.AGUI_RUN);
    if (!handler) throw new Error("AGUI_RUN handler was not registered");
    await handler({ sender }, { messages: [{ role: "user", content: "解释一下" }], sessionId: "chat-think" });
    await expect.poll(() => sent.some((event) => event.type === "RUN_FINISHED")).toBe(true);

    expect(sent.map((event) => event.type)).toEqual([
      "RUN_STARTED",
      "REASONING_MESSAGE_START",
      "REASONING_MESSAGE_CONTENT",
      "REASONING_MESSAGE_END",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_FINISHED",
    ]);
    expect(sent.find((event) => event.type === "REASONING_MESSAGE_CONTENT")?.delta).toBe("先分析问题");
    expect(sent.find((event) => event.type === "TEXT_MESSAGE_CONTENT")?.delta).toBe("正式回答");
    mocks.agentEvents = [];
  });

  it("delivers sticker side effects before RUN_FINISHED so renderer keeps listening", async () => {
    vi.resetModules();
    mocks.handlers.clear();
    mocks.getSession.mockReturnValue({ id: "chat-sticker", mode: "chat" });
    const { registerAgUiIpc } = await import("./agui-bridge");
    const sent: unknown[] = [];
    const sender = {
      isDestroyed: () => false,
      send: (_channel: string, event: unknown) => {
        sent.push(event);
      },
    };

    registerAgUiIpc(
      async () => ({
        options: {
          settings: { provider: "test", baseUrl: "", model: "", apiKey: "", contextWindowTokens: 256000 },
          messages: [],
          timeoutMs: 1000,
          toolSystemContent: "TOOL",
          soulSystemBaseContent: "SOUL",
        },
        latestUserText: "累了",
      }),
      async () => ({ sticker: "hugtight" }),
      () => null,
    );

    const handler = mocks.handlers.get(IPC.AGUI_RUN);
    if (!handler) throw new Error("AGUI_RUN handler was not registered");
    await handler(
      { sender },
      { messages: [{ role: "user", content: "累了" }], sessionId: "chat-sticker", style: "01_default.md" },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    const eventTypes = sent.map((event) => (event as { type?: string; name?: string }).name ?? (event as { type?: string }).type);
    expect(eventTypes).toEqual(["RUN_STARTED", "cyrene.sticker", "RUN_FINISHED"]);
  });

  it("uses the Chat session mode while preserving renderer styleId", async () => {
    vi.resetModules();
    mocks.handlers.clear();
    mocks.getSession.mockReturnValue({ id: "chat-style", mode: "chat" });
    const { registerAgUiIpc } = await import("./agui-bridge");
    const buildOptions = vi.fn(async () => ({
      options: {
        settings: { provider: "test", baseUrl: "", model: "", apiKey: "", contextWindowTokens: 256000 },
        messages: [],
        timeoutMs: 1000,
        toolSystemContent: "TOOL",
        soulSystemBaseContent: "SOUL",
      },
      latestUserText: "hi",
    }));
    const sender = {
      isDestroyed: () => false,
      send: () => {},
    };

    registerAgUiIpc(buildOptions, async () => {}, () => null);

    const handler = mocks.handlers.get(IPC.AGUI_RUN);
    if (!handler) throw new Error("AGUI_RUN handler was not registered");
    await handler(
      { sender },
      {
        messages: [{ role: "user", content: "hi" }],
        sessionId: "chat-style",
        styleId: "lively",
        executionMode: "work",
      },
    );

    expect(buildOptions).toHaveBeenCalledWith(expect.objectContaining({
      styleId: "lively",
      executionMode: "chat",
    }));
    expect(mocks.runCodeRequest).not.toHaveBeenCalled();
  });

  it("keeps Work requests on CyreneAgent and never dispatches the Code runtime", async () => {
    vi.resetModules();
    mocks.handlers.clear();
    mocks.runCodeRequest.mockClear();
    mocks.runCyreneAgent.mockClear();
    mocks.getSession.mockReturnValue({
      id: "work-chat",
      mode: "work",
      workspaceBinding: { workspaceRoot: "C:\\workspace", displayName: "workspace", boundAt: 1 },
    });
    const { registerAgUiIpc } = await import("./agui-bridge");
    const buildOptions = vi.fn(async () => ({
      options: {
        settings: { provider: "test", baseUrl: "", model: "", apiKey: "", contextWindowTokens: 256000 },
        messages: [],
        timeoutMs: 1000,
        toolSystemContent: "TOOL",
        soulSystemBaseContent: "SOUL",
      },
      latestUserText: "修改项目文件",
    }));
    registerAgUiIpc(buildOptions, async () => {}, () => null);
    const handler = mocks.handlers.get(IPC.AGUI_RUN);
    if (!handler) throw new Error("AGUI_RUN handler was not registered");

    await handler({
      sender: { isDestroyed: () => false, send: () => {} },
    }, {
      messages: [{ role: "user", content: "修改项目文件" }],
      sessionId: "work-chat",
      executionMode: "chat",
    });

    expect(buildOptions).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "work-chat",
      executionMode: "work",
    }));
    expect(mocks.runCyreneAgent).toHaveBeenCalledOnce();
    expect(mocks.runCyreneAgent).toHaveBeenCalledWith(expect.objectContaining({
      executionMode: "work",
      agentRuntime: "langgraph",
    }));
    expect(mocks.runCodeRequest).not.toHaveBeenCalled();
  });

  it("dispatches Daily sessions to the legacy TwoPhaseFC runtime", async () => {
    vi.resetModules();
    mocks.handlers.clear();
    mocks.runCyreneAgent.mockClear();
    mocks.getSession.mockReturnValue({
      id: "daily-chat",
      mode: "daily",
      workspaceBinding: { workspaceRoot: "C:\\daily", displayName: "daily", boundAt: 1 },
    });
    const { registerAgUiIpc } = await import("./agui-bridge");
    const buildOptions = vi.fn(async () => ({
      options: {
        settings: { provider: "test", baseUrl: "", model: "", apiKey: "", contextWindowTokens: 256000 },
        messages: [],
        timeoutMs: 1000,
        toolSystemContent: "TOOL",
        soulSystemBaseContent: "SOUL",
      },
      latestUserText: "整理今天的项目记录",
    }));
    registerAgUiIpc(buildOptions, async () => {}, () => null);
    const handler = mocks.handlers.get(IPC.AGUI_RUN);
    if (!handler) throw new Error("AGUI_RUN handler was not registered");

    await handler({
      sender: { isDestroyed: () => false, send: () => {} },
    }, {
      messages: [{ role: "user", content: "整理今天的项目记录" }],
      sessionId: "daily-chat",
      executionMode: "chat",
    });

    expect(buildOptions).toHaveBeenCalledWith(expect.objectContaining({ executionMode: "work" }));
    expect(mocks.runCyreneAgent).toHaveBeenCalledWith(expect.objectContaining({
      executionMode: "work",
      agentRuntime: "legacy",
      optimizeFirstRound: true,
    }));
  });

  it("rejects project modes without a trusted workspace binding", async () => {
    vi.resetModules();
    mocks.handlers.clear();
    mocks.runCyreneAgent.mockClear();
    mocks.getSession.mockReturnValue({ id: "daily-no-workspace", mode: "daily" });
    const { registerAgUiIpc } = await import("./agui-bridge");
    registerAgUiIpc(vi.fn(), async () => {}, () => null);
    const handler = mocks.handlers.get(IPC.AGUI_RUN);
    if (!handler) throw new Error("AGUI_RUN handler was not registered");

    await expect(handler({
      sender: { isDestroyed: () => false, send: () => {} },
    }, {
      messages: [{ role: "user", content: "开始" }],
      sessionId: "daily-no-workspace",
    })).rejects.toThrow("需要先绑定项目工作区");
    expect(mocks.runCyreneAgent).not.toHaveBeenCalled();
  });

  it("Code verification event send failure does not stop the background run", async () => {
    vi.resetModules();
    mocks.handlers.clear();
    mocks.runCodeRequest.mockClear();
    mocks.runCyreneAgent.mockClear();
    mocks.getSession.mockReturnValue({
      id: "code-chat",
      mode: "code",
      workspaceBinding: { workspaceRoot: "C:\\code", displayName: "code", boundAt: 1 },
    });
    let continuedAfterEvent = false;
    mocks.runCodeRequest.mockImplementation(async (_input, _session, context) => {
      context.emitEvent({
        type: "code_verification_card",
        payload: { status: "completed_verified" },
      });
      continuedAfterEvent = true;
    });

    const { registerAgUiIpc } = await import("./agui-bridge");
    registerAgUiIpc(
      vi.fn(),
      vi.fn(),
      () => null,
    );
    const handler = mocks.handlers.get(IPC.AGUI_RUN);
    if (!handler) throw new Error("AGUI_RUN handler was not registered");

    const ack = await handler({
      sender: {
        isDestroyed: () => false,
        send: () => { throw new Error("webContents destroyed during send"); },
      },
    }, {
      messages: [{ role: "user", content: "修复代码" }],
      sessionId: "code-chat",
      styleId: "default",
      executionMode: "work",
    });

    expect(ack).toMatchObject({ success: true });
    await expect.poll(() => mocks.runCodeRequest).toHaveBeenCalledOnce();
    expect(mocks.runCyreneAgent).not.toHaveBeenCalled();
    expect(continuedAfterEvent).toBe(true);
  });

  it("starts a Code AG-UI run before forwarding deterministic Code cards", async () => {
    vi.resetModules();
    mocks.handlers.clear();
    mocks.runCodeRequest.mockReset();
    mocks.getSession.mockReturnValue({
      id: "code-react",
      mode: "code",
      workspaceBinding: { workspaceRoot: "C:\\code", displayName: "code", boundAt: 1 },
    });
    mocks.runCodeRequest.mockImplementation(async (_input, _session, context) => {
      context.emitEvent({
        type: "code_verification_card",
        payload: { runId: context.runId, status: "completed_verified" },
      });
    });
    const sent: unknown[] = [];

    const { registerAgUiIpc } = await import("./agui-bridge");
    registerAgUiIpc(vi.fn(), vi.fn(), () => null);
    const handler = mocks.handlers.get(IPC.AGUI_RUN);
    if (!handler) throw new Error("AGUI_RUN handler was not registered");

    const ack = await handler({
      sender: { isDestroyed: () => false, send: (_channel: string, event: unknown) => sent.push(event) },
    }, {
      messages: [{ role: "user", content: "修复代码" }],
      sessionId: "code-react",
    }) as { runId: string };

    await expect.poll(() => sent.length).toBeGreaterThanOrEqual(2);
    expect(sent[0]).toMatchObject({ type: "RUN_STARTED", runId: ack.runId, threadId: "code-react" });
    expect(sent[1]).toMatchObject({
      type: "CUSTOM",
      name: "code_verification_card",
      value: { runId: ack.runId, status: "completed_verified" },
    });
  });
});
