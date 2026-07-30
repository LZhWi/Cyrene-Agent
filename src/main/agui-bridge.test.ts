import { describe, expect, it, vi } from "vitest";
import { Observable } from "rxjs";
import { IPC } from "../shared/ipc-channels";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => unknown>(),
  getSession: vi.fn(),
  runCodeRequest: vi.fn(),
  runCyreneAgent: vi.fn(),
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

    runWithEvents() {
      mocks.runCyreneAgent();
      return new Observable((subscriber) => {
        this.lastResult = { reply: "抱抱你", toolResults: [] };
        subscriber.next({ type: "RUN_STARTED" });
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

describe("agui-bridge sticker event ordering", () => {
  it("delivers sticker side effects before RUN_FINISHED so renderer keeps listening", async () => {
    vi.resetModules();
    mocks.handlers.clear();
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
          settings: { provider: "test", baseUrl: "", model: "", apiKey: "" },
          messages: [],
          timeoutMs: 1000,
          toolSystemContent: "TOOL",
          soulSystemBaseContent: "SOUL",
        },
        latestUserText: "累了",
      }),
      async () => {
        sender.send(IPC.AGUI_EVENT, {
          type: "CUSTOM",
          name: "cyrene.sticker",
          value: "hugtight",
        });
      },
      () => null,
    );

    const handler = mocks.handlers.get(IPC.AGUI_RUN);
    if (!handler) throw new Error("AGUI_RUN handler was not registered");
    await handler({ sender }, { messages: [{ role: "user", content: "累了" }], style: "01_default.md" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const eventTypes = sent.map((event) => (event as { type?: string; name?: string }).name ?? (event as { type?: string }).type);
    expect(eventTypes).toEqual(["RUN_STARTED", "cyrene.sticker", "RUN_FINISHED"]);
  });

  it("passes renderer styleId through to build options", async () => {
    vi.resetModules();
    mocks.handlers.clear();
    const { registerAgUiIpc } = await import("./agui-bridge");
    const buildOptions = vi.fn(async () => ({
      options: {
        settings: { provider: "test", baseUrl: "", model: "", apiKey: "" },
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
      { messages: [{ role: "user", content: "hi" }], styleId: "lively", executionMode: "chat" },
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
    mocks.getSession.mockReturnValue({ id: "work-chat", mode: "work" });
    const { registerAgUiIpc } = await import("./agui-bridge");
    const buildOptions = vi.fn(async () => ({
      options: {
        settings: { provider: "test", baseUrl: "", model: "", apiKey: "" },
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
      executionMode: "work",
    });

    expect(buildOptions).toHaveBeenCalledOnce();
    expect(mocks.runCyreneAgent).toHaveBeenCalledOnce();
    expect(mocks.runCodeRequest).not.toHaveBeenCalled();
  });

  it("Code verification event send failure does not stop the background run", async () => {
    vi.resetModules();
    mocks.handlers.clear();
    mocks.runCodeRequest.mockClear();
    mocks.runCyreneAgent.mockClear();
    mocks.getSession.mockReturnValue({ id: "code-chat", mode: "code" });
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
      executionMode: "code",
    });

    expect(ack).toMatchObject({ success: true });
    await expect.poll(() => mocks.runCodeRequest).toHaveBeenCalledOnce();
    expect(mocks.runCyreneAgent).not.toHaveBeenCalled();
    expect(continuedAfterEvent).toBe(true);
  });
});
