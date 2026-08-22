import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ instances: [] as Array<{
  readyState: number;
  emit: (event: string, ...args: unknown[]) => void;
  terminate: ReturnType<typeof vi.fn>;
}> }));

vi.mock("ws", () => {
  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;
    readyState = FakeWebSocket.CONNECTING;
    private listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    send = vi.fn();
    close = vi.fn(() => {
      this.readyState = FakeWebSocket.CLOSED;
      this.emit("close", 1000);
    });
    terminate = vi.fn(() => {
      this.readyState = FakeWebSocket.CLOSED;
      this.emit("close", 1006);
    });

    constructor() { mocks.instances.push(this); }
    on(event: string, listener: (...args: unknown[]) => void) {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
      return this;
    }
    emit(event: string, ...args: unknown[]) {
      for (const listener of this.listeners.get(event) ?? []) listener(...args);
    }
  }
  return { WebSocket: FakeWebSocket };
});

import { VolcanoAsrStream } from "./volcano-asr-engine";

describe("Aliyun ASR readiness", () => {
  beforeEach(() => {
    mocks.instances.length = 0;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ Token: { Id: "token" } }), { status: 200 })));
  });

  afterEach(() => vi.unstubAllGlobals());

  it("does not report start complete until TranscriptionStarted arrives", async () => {
    const stream = new VolcanoAsrStream(vi.fn(), vi.fn());
    let settled = false;
    const started = stream.start("app", "id", "secret", "zh").then(() => { settled = true; });
    await vi.waitFor(() => expect(mocks.instances).toHaveLength(1));

    const ws = mocks.instances[0];
    ws.readyState = 1;
    ws.emit("open");
    await Promise.resolve();
    expect(settled).toBe(false);

    ws.emit("message", Buffer.from(JSON.stringify({
      header: { status: 20000000, name: "TranscriptionStarted" },
    })));
    await started;
    expect(settled).toBe(true);
  });

  it("propagates token acquisition failure instead of pretending to listen", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("denied", { status: 403 })));
    const stream = new VolcanoAsrStream(vi.fn(), vi.fn());
    await expect(stream.start("app", "id", "secret", "zh")).rejects.toThrow("HTTP 403");
    expect(mocks.instances).toHaveLength(0);
  });
});
