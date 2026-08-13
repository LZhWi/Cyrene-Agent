import { beforeEach, describe, expect, it, vi } from "vitest";
import { Observable } from "rxjs";
import { IPC } from "../shared/ipc-channels";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => unknown>(),
  getSession: vi.fn(),
  runCyreneAgent: vi.fn(),
  requestUserClarification: vi.fn(),
  agentEvents: [] as unknown[],
  // Task 2 / C1：可定制的终态行为
  runFinishedResult: undefined as unknown,
  emitDuplicateRunFinished: false,
  errorAfterRunFinished: null as string | null,
  skipDefaultRunFinished: false,
  // Task 3 / C2：模拟正在运行的 Observable（不自动 complete）
  neverComplete: false,
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
      // 忠实模拟真实 CyreneAgent：读 options.runId 并 stamp 到 RUN_STARTED / RUN_FINISHED，
      // 保证 bridge 的 canonical runId 全链路一致（ack.runId === RUN_STARTED.runId === RUN_FINISHED.runId）。
      const runId = (options as { runId?: string } | null | undefined)?.runId;
      return new Observable((subscriber) => {
        this.lastResult = { reply: "抱抱你", toolResults: [] };
        subscriber.next({ type: "RUN_STARTED", runId });
        for (const event of mocks.agentEvents) subscriber.next(event);
        if (!mocks.skipDefaultRunFinished) {
          const finishedEvent: { type: string; runId?: string; result?: unknown } = { type: "RUN_FINISHED", runId };
          if (mocks.runFinishedResult !== undefined) {
            finishedEvent.result = mocks.runFinishedResult;
          }
          subscriber.next(finishedEvent);
          if (mocks.emitDuplicateRunFinished) {
            subscriber.next({ type: "RUN_FINISHED", runId, result: mocks.runFinishedResult });
          }
          if (mocks.errorAfterRunFinished) {
            subscriber.error(new Error(mocks.errorAfterRunFinished));
            return;
          }
        }
        // Task 3 / C2：neverComplete 模拟正在运行的 Observable，不自动 complete
        if (!mocks.neverComplete) {
          subscriber.complete();
        }
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


vi.mock("./user-choice", () => ({
  requestUserClarification: mocks.requestUserClarification,
  cancelPendingChoicesForRun: vi.fn(),
}));

vi.mock("./permission", () => ({
  cancelPendingApprovalsForRun: vi.fn(),
  checkPermission: vi.fn(),
}));

describe("agui-bridge sticker event ordering", () => {
  // Task 2 / C1：每个测试前重置可定制的终态行为字段，
  // 避免上一个测试的副作用泄漏到下一个测试。
  beforeEach(() => {
    mocks.runFinishedResult = undefined;
    mocks.emitDuplicateRunFinished = false;
    mocks.errorAfterRunFinished = null;
    mocks.skipDefaultRunFinished = false;
    mocks.neverComplete = false;
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
    const sent: Array<{ type?: string; delta?: string; runId?: string }> = [];
    const sender = {
      isDestroyed: () => false,
      send: (_channel: string, event: { type?: string; delta?: string; runId?: string }) => sent.push(event),
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
    const runId = sent.find((event) => event.type === "RUN_STARTED")?.runId;
    expect(runId).toEqual(expect.any(String));
    expect(sent.filter((event) => event.type?.startsWith("TEXT_MESSAGE")).every((event) => event.runId === runId)).toBe(true);
    mocks.agentEvents = [];
  });

  it.each(["chat", "work", "code"] as const)("removes repeated leading time metadata for %s replies", async (mode) => {
    vi.resetModules();
    mocks.handlers.clear();
    mocks.agentEvents = [
      { type: "TEXT_MESSAGE_START", messageId: "m-time", role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "m-time", delta: "[2026-08-10 18:18, Asia/Shanghai]\n" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "m-time", delta: "[2026-08-10 18:18, Asia/Shanghai]真正回复" },
      { type: "TEXT_MESSAGE_END", messageId: "m-time" },
    ];
    mocks.getSession.mockReturnValue({
      id: `${mode}-time`,
      mode,
      ...(mode === "chat" ? {} : { workspaceBinding: { workspaceRoot: "C:\\workspace", displayName: "workspace", boundAt: 1 } }),
    });
    const { registerAgUiIpc } = await import("./agui-bridge");
    const sent: Array<{ type?: string; delta?: string }> = [];
    registerAgUiIpc(async () => ({
      options: { settings: { provider: "test", baseUrl: "", model: "", apiKey: "", contextWindowTokens: 256000 }, messages: [], timeoutMs: 1000, toolSystemContent: "TOOL", soulSystemBaseContent: "SOUL" },
      latestUserText: "测试",
    }), async () => {}, () => null);
    const handler = mocks.handlers.get(IPC.AGUI_RUN);
    if (!handler) throw new Error("AGUI_RUN handler was not registered");
    await handler({ sender: { isDestroyed: () => false, send: (_channel: string, event: { type?: string; delta?: string }) => sent.push(event) } }, { messages: [{ role: "user", content: "测试" }], sessionId: `${mode}-time` });

    expect(sent.filter((event) => event.type === "TEXT_MESSAGE_CONTENT").map((event) => event.delta).join("")).toBe("真正回复");
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
  });

  it("keeps Work requests on CyreneAgent and never dispatches the Code runtime", async () => {
    vi.resetModules();
    mocks.handlers.clear();
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
    }));
  });

  it("rejects project modes without a trusted workspace binding", async () => {
    vi.resetModules();
    mocks.handlers.clear();
    mocks.runCyreneAgent.mockClear();
    mocks.getSession.mockReturnValue({ id: "work-no-workspace", mode: "work" });
    const { registerAgUiIpc } = await import("./agui-bridge");
    registerAgUiIpc(vi.fn(), async () => {}, () => null);
    const handler = mocks.handlers.get(IPC.AGUI_RUN);
    if (!handler) throw new Error("AGUI_RUN handler was not registered");

    await expect(handler({
      sender: { isDestroyed: () => false, send: () => {} },
    }, {
      messages: [{ role: "user", content: "开始" }],
      sessionId: "work-no-workspace",
    })).rejects.toThrow("需要先绑定项目工作区");
    expect(mocks.runCyreneAgent).not.toHaveBeenCalled();
  });

  // ── Task 2 / C1：canonical runId 与 exactly-once settlement ────────────

  it("propagates the canonical runId through ack, RUN_STARTED, options, and RUN_FINISHED", async () => {
    vi.resetModules();
    mocks.handlers.clear();
    mocks.runCyreneAgent.mockClear();
    mocks.getSession.mockReturnValue({ id: "chat-identity", mode: "chat" });
    const { registerAgUiIpc } = await import("./agui-bridge");
    const sent: Array<{ type?: string; runId?: string }> = [];
    const sender = {
      isDestroyed: () => false,
      send: (_channel: string, event: { type?: string; runId?: string }) => sent.push(event),
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
        latestUserText: "hi",
      }),
      async () => {},
      () => null,
    );

    const handler = mocks.handlers.get(IPC.AGUI_RUN);
    if (!handler) throw new Error("AGUI_RUN handler was not registered");
    const ack = await handler(
      { sender },
      { messages: [{ role: "user", content: "hi" }], sessionId: "chat-identity" },
    ) as { runId: string };

    await expect.poll(() => sent.some((event) => event.type === "RUN_FINISHED")).toBe(true);

    // ack.runId 必须存在
    expect(ack.runId).toBeTruthy();

    // CyreneAgent.runWithEvents 必须收到 options.runId === ack.runId
    expect(mocks.runCyreneAgent).toHaveBeenCalledWith(expect.objectContaining({
      runId: ack.runId,
    }));

    // RUN_STARTED 与 RUN_FINISHED 的 runId 必须与 ack.runId 一致
    const runStarted = sent.find((event) => event.type === "RUN_STARTED");
    const runFinished = sent.find((event) => event.type === "RUN_FINISHED");
    expect(runStarted?.runId).toBe(ack.runId);
    expect(runFinished?.runId).toBe(ack.runId);
  });

  it("drops duplicate RUN_FINISHED events so the renderer only sees one terminal", async () => {
    vi.resetModules();
    mocks.handlers.clear();
    mocks.runCyreneAgent.mockClear();
    mocks.getSession.mockReturnValue({ id: "chat-dup", mode: "chat" });
    mocks.emitDuplicateRunFinished = true;
    const { registerAgUiIpc } = await import("./agui-bridge");
    const sent: Array<{ type?: string }> = [];
    const sender = {
      isDestroyed: () => false,
      send: (_channel: string, event: { type?: string }) => sent.push(event),
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
        latestUserText: "hi",
      }),
      async () => {},
      () => null,
    );

    const handler = mocks.handlers.get(IPC.AGUI_RUN);
    if (!handler) throw new Error("AGUI_RUN handler was not registered");
    await handler(
      { sender },
      { messages: [{ role: "user", content: "hi" }], sessionId: "chat-dup" },
    );

    await expect.poll(() => sent.some((event) => event.type === "RUN_FINISHED")).toBe(true);

    // 即便 upstream 连发两个 RUN_FINISHED，渲染端只应收到一个
    const runFinishedCount = sent.filter((event) => event.type === "RUN_FINISHED").length;
    expect(runFinishedCount).toBe(1);
  });

  it("suppresses RUN_ERROR after RUN_FINISHED has already settled (success-then-error)", async () => {
    vi.resetModules();
    mocks.handlers.clear();
    mocks.runCyreneAgent.mockClear();
    mocks.getSession.mockReturnValue({ id: "chat-err-after", mode: "chat" });
    mocks.errorAfterRunFinished = "boom";
    const { registerAgUiIpc } = await import("./agui-bridge");
    const sent: Array<{ type?: string }> = [];
    const sender = {
      isDestroyed: () => false,
      send: (_channel: string, event: { type?: string }) => sent.push(event),
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
        latestUserText: "hi",
      }),
      async () => {},
      () => null,
    );

    const handler = mocks.handlers.get(IPC.AGUI_RUN);
    if (!handler) throw new Error("AGUI_RUN handler was not registered");
    await handler(
      { sender },
      { messages: [{ role: "user", content: "hi" }], sessionId: "chat-err-after" },
    );

    await expect.poll(() => sent.some((event) => event.type === "RUN_FINISHED")).toBe(true);

    // RUN_FINISHED 必须到达（settlement gate 第一次进入的是 finished）
    expect(sent.some((event) => event.type === "RUN_FINISHED")).toBe(true);
    // RUN_ERROR 必须被 gate 丢弃（已结算为 success/finished）
    expect(sent.some((event) => event.type === "RUN_ERROR")).toBe(false);
  });

  it("skips onRunFinished side effects when RUN_FINISHED.result.status is cancelled", async () => {
    vi.resetModules();
    mocks.handlers.clear();
    mocks.runCyreneAgent.mockClear();
    mocks.getSession.mockReturnValue({ id: "chat-cancelled", mode: "chat" });
    mocks.runFinishedResult = { status: "cancelled", reason: "user_cancelled", externalEffectsMayContinue: true };
    const { registerAgUiIpc } = await import("./agui-bridge");
    const sent: Array<{ type?: string; name?: string }> = [];
    const sender = {
      isDestroyed: () => false,
      send: (_channel: string, event: { type?: string; name?: string }) => sent.push(event),
    };
    const onFinished = vi.fn(async () => ({ sticker: "should-not-fire" }));

    registerAgUiIpc(
      async () => ({
        options: {
          settings: { provider: "test", baseUrl: "", model: "", apiKey: "", contextWindowTokens: 256000 },
          messages: [],
          timeoutMs: 1000,
          toolSystemContent: "TOOL",
          soulSystemBaseContent: "SOUL",
        },
        latestUserText: "hi",
      }),
      onFinished,
      () => null,
    );

    const handler = mocks.handlers.get(IPC.AGUI_RUN);
    if (!handler) throw new Error("AGUI_RUN handler was not registered");
    await handler(
      { sender },
      { messages: [{ role: "user", content: "hi" }], sessionId: "chat-cancelled" },
    );

    await expect.poll(() => sent.some((event) => event.type === "RUN_FINISHED")).toBe(true);

    // cancelled 路径不应触发 onRunFinished 成功副作用
    expect(onFinished).not.toHaveBeenCalled();
    // 也不应发出 sticker CUSTOM 事件
    expect(sent.some((event) => event.type === "CUSTOM" && event.name === "cyrene.sticker")).toBe(false);
    // 但 RUN_FINISHED 本身必须发出
    expect(sent.some((event) => event.type === "RUN_FINISHED")).toBe(true);
  });

  // ── Issue 4：裸 complete（upstream 未发 RUN_FINISHED）必须补发一个合成 RUN_FINISHED ──

  it("synthesizes exactly one RUN_FINISHED when upstream completes without emitting one", async () => {
    vi.resetModules();
    mocks.handlers.clear();
    mocks.runCyreneAgent.mockClear();
    mocks.getSession.mockReturnValue({ id: "chat-bare-complete", mode: "chat" });
    // upstream 直接 complete，不发 RUN_FINISHED
    mocks.skipDefaultRunFinished = true;
    const { registerAgUiIpc } = await import("./agui-bridge");
    const sent: Array<{ type?: string; runId?: string }> = [];
    const sender = {
      isDestroyed: () => false,
      send: (_channel: string, event: { type?: string; runId?: string }) => sent.push(event),
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
        latestUserText: "hi",
      }),
      async () => {},
      () => null,
    );

    const handler = mocks.handlers.get(IPC.AGUI_RUN);
    if (!handler) throw new Error("AGUI_RUN handler was not registered");
    const ack = await handler(
      { sender },
      { messages: [{ role: "user", content: "hi" }], sessionId: "chat-bare-complete" },
    ) as { runId: string };

    await expect.poll(() => sent.some((event) => event.type === "RUN_FINISHED")).toBe(true);

    // 恰好一个 RUN_FINISHED（合成的），不是零个也不是两个
    const runFinishedCount = sent.filter((event) => event.type === "RUN_FINISHED").length;
    expect(runFinishedCount).toBe(1);
    // 合成的 RUN_FINISHED 必须带 canonical runId + success 终态
    const runFinished = sent.find((event) => event.type === "RUN_FINISHED");
    expect(runFinished?.runId).toBe(ack.runId);
    expect(runFinished).toMatchObject({ result: { status: "success", externalEffectsMayContinue: false } });
    // 不能误发 RUN_ERROR
    expect(sent.some((event) => event.type === "RUN_ERROR")).toBe(false);
  });

  // ── Issue 7：同步 complete 不留幽灵 active run ──

  it("does not register a ghost active run when the Observable completes synchronously", async () => {
    vi.resetModules();
    mocks.handlers.clear();
    mocks.runCyreneAgent.mockClear();
    mocks.getSession.mockReturnValue({ id: "chat-sync-complete", mode: "chat" });
    const { registerAgUiIpc, __hasActiveRunForTest } = await import("./agui-bridge");
    const sender = {
      isDestroyed: () => false,
      send: () => {},
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
        latestUserText: "hi",
      }),
      async () => {},
      () => null,
    );

    const handler = mocks.handlers.get(IPC.AGUI_RUN);
    if (!handler) throw new Error("AGUI_RUN handler was not registered");
    const ack = await handler(
      { sender },
      { messages: [{ role: "user", content: "hi" }], sessionId: "chat-sync-complete" },
    ) as { runId: string };

    // 让 microtask 跑完（mock Observable 是同步的，subscribe 返回时已 complete）
    await new Promise((resolve) => setTimeout(resolve, 0));

    // 关键不变量：run 已结算，绝不能留在 activeRuns 里（否则 Task 3 重构会带上幽灵 run）
    expect(__hasActiveRunForTest(ack.runId)).toBe(false);
  });

  // ── Issue 2：harness 返回 terminateReason="error" → runtime_error → RUN_ERROR ──

  it("routes harness runtime_error terminal to RUN_ERROR and skips success side effects", async () => {
    vi.resetModules();
    mocks.handlers.clear();
    mocks.runCyreneAgent.mockClear();
    mocks.getSession.mockReturnValue({ id: "chat-runtime-error", mode: "chat" });
    // upstream 发 RUN_FINISHED 但 result.status = "runtime_error"
    mocks.runFinishedResult = { status: "runtime_error", reason: "E_HARNESS_FAILURE", externalEffectsMayContinue: true };
    const { registerAgUiIpc } = await import("./agui-bridge");
    const sent: Array<{ type?: string; name?: string }> = [];
    const sender = {
      isDestroyed: () => false,
      send: (_channel: string, event: { type?: string; name?: string }) => sent.push(event),
    };
    const onFinished = vi.fn(async () => ({ sticker: "should-not-fire" }));

    registerAgUiIpc(
      async () => ({
        options: {
          settings: { provider: "test", baseUrl: "", model: "", apiKey: "", contextWindowTokens: 256000 },
          messages: [],
          timeoutMs: 1000,
          toolSystemContent: "TOOL",
          soulSystemBaseContent: "SOUL",
        },
        latestUserText: "hi",
      }),
      onFinished,
      () => null,
    );

    const handler = mocks.handlers.get(IPC.AGUI_RUN);
    if (!handler) throw new Error("AGUI_RUN handler was not registered");
    await handler(
      { sender },
      { messages: [{ role: "user", content: "hi" }], sessionId: "chat-runtime-error" },
    );

    await expect.poll(() => sent.some((event) => event.type === "RUN_ERROR")).toBe(true);

    // runtime_error 必须走 RUN_ERROR，绝不走 RUN_FINISHED
    expect(sent.some((event) => event.type === "RUN_ERROR")).toBe(true);
    expect(sent.some((event) => event.type === "RUN_FINISHED")).toBe(false);
    // 不能触发成功收尾副作用
    expect(onFinished).not.toHaveBeenCalled();
    expect(sent.some((event) => event.type === "CUSTOM" && event.name === "cyrene.sticker")).toBe(false);
  });

  // ── Task 3 / C2：cancellation propagation ───────────────────────────────

  it("AGUI_CANCEL aborts the run's AbortController (not just unsubscribe)", async () => {
    vi.resetModules();
    mocks.handlers.clear();
    mocks.runCyreneAgent.mockClear();
    mocks.getSession.mockReturnValue({ id: "chat-cancel-1", mode: "chat" });
    // upstream 永不自动 complete（模拟正在运行）：不发 RUN_FINISHED + 不 complete
    mocks.skipDefaultRunFinished = true;
    mocks.neverComplete = true;
    const { registerAgUiIpc } = await import("./agui-bridge");
    const sender = {
      isDestroyed: () => false,
      send: () => {},
    };

    registerAgUiIpc(
      async () => ({
        options: {
          settings: { provider: "test", baseUrl: "", model: "", apiKey: "", contextWindowTokens: 256000 },
          messages: [],
          timeoutMs: 60000,
          toolSystemContent: "TOOL",
          soulSystemBaseContent: "SOUL",
        },
        latestUserText: "hi",
      }),
      async () => {},
      () => null,
    );

    const runHandler = mocks.handlers.get(IPC.AGUI_RUN);
    const cancelHandler = mocks.handlers.get(IPC.AGUI_CANCEL);
    if (!runHandler || !cancelHandler) throw new Error("handlers not registered");

    const ack = await runHandler(
      { sender },
      { messages: [{ role: "user", content: "hi" }], sessionId: "chat-cancel-1" },
    ) as { runId: string };

    // 等 CyreneAgent.runWithEvents 被调用
    await vi.waitFor(() => expect(mocks.runCyreneAgent).toHaveBeenCalledOnce());

    // bridge 必须通过 options.signal 传入 AbortController.signal
    const passedOptions = mocks.runCyreneAgent.mock.calls[0]?.[0] as { signal?: AbortSignal };
    expect(passedOptions.signal).toBeDefined();
    expect(passedOptions.signal!.aborted).toBe(false);

    // 调用 AGUI_CANCEL —— 必须 abort signal，不是 unsubscribe Observable
    await cancelHandler({}, ack.runId);

    // signal 必须被 abort
    expect(passedOptions.signal!.aborted).toBe(true);
  });

  it("cancel one runId does not abort another run's signal", async () => {
    vi.resetModules();
    mocks.handlers.clear();
    mocks.runCyreneAgent.mockClear();
    mocks.getSession.mockReturnValue({ id: "chat-isolation", mode: "chat" });
    mocks.skipDefaultRunFinished = true;
    mocks.neverComplete = true;
    const { registerAgUiIpc } = await import("./agui-bridge");
    const sender = {
      isDestroyed: () => false,
      send: () => {},
    };

    registerAgUiIpc(
      async () => ({
        options: {
          settings: { provider: "test", baseUrl: "", model: "", apiKey: "", contextWindowTokens: 256000 },
          messages: [],
          timeoutMs: 60000,
          toolSystemContent: "TOOL",
          soulSystemBaseContent: "SOUL",
        },
        latestUserText: "hi",
      }),
      async () => {},
      () => null,
    );

    const runHandler = mocks.handlers.get(IPC.AGUI_RUN);
    const cancelHandler = mocks.handlers.get(IPC.AGUI_CANCEL);
    if (!runHandler || !cancelHandler) throw new Error("handlers not registered");

    // 启动两个 run
    const ack1 = await runHandler(
      { sender },
      { messages: [{ role: "user", content: "run1" }], sessionId: "chat-isolation" },
    ) as { runId: string };
    const ack2 = await runHandler(
      { sender },
      { messages: [{ role: "user", content: "run2" }], sessionId: "chat-isolation" },
    ) as { runId: string };

    await vi.waitFor(() => expect(mocks.runCyreneAgent).toHaveBeenCalledTimes(2));

    const signal1 = (mocks.runCyreneAgent.mock.calls[0]?.[0] as { signal?: AbortSignal }).signal;
    const signal2 = (mocks.runCyreneAgent.mock.calls[1]?.[0] as { signal?: AbortSignal }).signal;
    expect(signal1).toBeDefined();
    expect(signal2).toBeDefined();
    expect(signal1).not.toBe(signal2);

    // cancel run1 —— 绝不能影响 run2
    await cancelHandler({}, ack1.runId);

    expect(signal1!.aborted).toBe(true);
    expect(signal2!.aborted).toBe(false);
  });

  it("AGUI_CANCEL with no runId aborts all active runs", async () => {
    vi.resetModules();
    mocks.handlers.clear();
    mocks.runCyreneAgent.mockClear();
    mocks.getSession.mockReturnValue({ id: "chat-cancel-all", mode: "chat" });
    mocks.skipDefaultRunFinished = true;
    mocks.neverComplete = true;
    const { registerAgUiIpc } = await import("./agui-bridge");
    const sender = {
      isDestroyed: () => false,
      send: () => {},
    };

    registerAgUiIpc(
      async () => ({
        options: {
          settings: { provider: "test", baseUrl: "", model: "", apiKey: "", contextWindowTokens: 256000 },
          messages: [],
          timeoutMs: 60000,
          toolSystemContent: "TOOL",
          soulSystemBaseContent: "SOUL",
        },
        latestUserText: "hi",
      }),
      async () => {},
      () => null,
    );

    const runHandler = mocks.handlers.get(IPC.AGUI_RUN);
    const cancelHandler = mocks.handlers.get(IPC.AGUI_CANCEL);
    if (!runHandler || !cancelHandler) throw new Error("handlers not registered");

    await runHandler(
      { sender },
      { messages: [{ role: "user", content: "run1" }], sessionId: "chat-cancel-all" },
    );
    await runHandler(
      { sender },
      { messages: [{ role: "user", content: "run2" }], sessionId: "chat-cancel-all" },
    );

    await vi.waitFor(() => expect(mocks.runCyreneAgent).toHaveBeenCalledTimes(2));

    const signal1 = (mocks.runCyreneAgent.mock.calls[0]?.[0] as { signal?: AbortSignal }).signal;
    const signal2 = (mocks.runCyreneAgent.mock.calls[1]?.[0] as { signal?: AbortSignal }).signal;

    // 无 runId → abort 全部
    await cancelHandler({}, undefined);

    expect(signal1!.aborted).toBe(true);
    expect(signal2!.aborted).toBe(true);
  });
});
