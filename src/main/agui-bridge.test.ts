import { beforeEach, describe, expect, it, vi } from "vitest";
import { Observable } from "rxjs";
import { IPC } from "../shared/ipc-channels";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => unknown>(),
  holdOpen: false,
  controls: [] as any[],
  teardown: vi.fn(),
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

    runWithEvents(_options: unknown, control: any) {
      mocks.controls.push(control);
      return new Observable((subscriber) => {
        if (mocks.holdOpen) {
          subscriber.next({ type: "RUN_STARTED", runId: control.runId });
          return mocks.teardown;
        }
        this.lastResult = { reply: "抱抱你", toolResults: [] };
        subscriber.next({ type: "RUN_STARTED", runId: control.runId });
        subscriber.next({ type: "RUN_FINISHED", runId: control.runId });
        subscriber.complete();
      });
    }
  },
}));

vi.mock("./orchestrator/history-tools", () => ({
  indexConversationTurn: vi.fn(),
}));

describe("agui-bridge sticker event ordering", () => {
  beforeEach(() => {
    mocks.handlers.clear();
    mocks.holdOpen = false;
    mocks.controls.length = 0;
    mocks.teardown.mockClear();
  });

  it("delivers sticker side effects before RUN_FINISHED so renderer keeps listening", async () => {
    vi.resetModules();
    const { registerAgUiIpc } = await import("./agui-bridge");
    const sent: unknown[] = [];
    const sender = {
      id: 7,
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

  it("uses the acknowledged runId for the agent and cancels only that sender's run", async () => {
    mocks.holdOpen = true;
    vi.resetModules();
    const { registerAgUiIpc } = await import("./agui-bridge");
    const sent: unknown[] = [];
    const sender = { id: 11, isDestroyed: () => false, send: (_channel: string, value: unknown) => sent.push(value) };
    const onFinished = vi.fn();

    registerAgUiIpc(
      async () => ({
        options: {
          settings: { provider: "test", baseUrl: "", model: "", apiKey: "" },
          messages: [],
          timeoutMs: 1000,
          toolSystemContent: "TOOL",
          soulSystemBaseContent: "SOUL",
        },
        latestUserText: "stop",
      }),
      onFinished,
      () => null,
    );

    const run = mocks.handlers.get(IPC.AGUI_RUN)!;
    const cancel = mocks.handlers.get(IPC.AGUI_CANCEL)!;
    const requestedRunId = "run-client-12345678";
    const ack = await run({ sender }, { runId: requestedRunId, messages: [], style: "01_default.md" }) as { runId: string };

    expect(ack.runId).toBe(requestedRunId);
    expect(mocks.controls[0].runId).toBe(requestedRunId);
    expect(sent[0]).toMatchObject({ type: "RUN_STARTED", runId: requestedRunId });
    await expect(run({ sender }, { runId: requestedRunId, messages: [], style: "01_default.md" }))
      .rejects.toThrow(/E_RUN_ID_CONFLICT/);
    expect(await cancel({ sender: { id: 12 } }, { runId: ack.runId })).toBe(false);
    expect(await cancel({ sender }, {})).toBe(false);
    expect(await cancel({ sender }, { runId: ack.runId })).toBe(true);
    expect(mocks.controls[0].signal.aborted).toBe(true);
    expect(mocks.teardown).toHaveBeenCalledOnce();
    expect(onFinished).not.toHaveBeenCalled();
    expect(sent).toContainEqual(expect.objectContaining({
      type: "RUN_ERROR",
      code: "E_RUN_CANCELLED",
      runId: ack.runId,
    }));
  });
});
