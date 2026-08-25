import { EventEmitter } from "events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HoloCubicBridge,
  type HoloCubicSocket,
} from "./holocubic-bridge";

class FakeSocket extends EventEmitter implements HoloCubicSocket {
  readyState = 0;
  bufferedAmount = 0;
  sent: Buffer[] = [];
  close = vi.fn(() => {
    this.readyState = 3;
  });
  terminate = vi.fn();

  open(): void {
    this.readyState = 1;
    this.emit("open");
  }

  disconnect(): void {
    this.readyState = 3;
    this.emit("close");
  }

  send(data: Buffer, options: { binary: true }, callback: (error?: Error) => void): void {
    expect(options).toEqual({ binary: true });
    this.sent.push(Buffer.from(data));
    callback();
  }
}

describe("HoloCubicBridge", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("captures and sends binary frames only while connected", async () => {
    const socket = new FakeSocket();
    const captureFrame = vi.fn(async () => Buffer.from("frame"));
    const bridge = new HoloCubicBridge({ captureFrame, createSocket: () => socket });

    bridge.start({ url: "ws://device:8766", frameRate: 10 });
    await vi.advanceTimersByTimeAsync(200);
    expect(captureFrame).not.toHaveBeenCalled();

    socket.open();
    await vi.advanceTimersByTimeAsync(100);
    expect(socket.sent).toEqual([Buffer.from("frame")]);
    expect(bridge.getStatus()).toMatchObject({
      state: "connected",
      connected: true,
      framesCaptured: 1,
      framesSent: 1,
      framesDropped: 0,
    });
  });

  it("drops ticks before capture when the socket is backpressured", async () => {
    const socket = new FakeSocket();
    const captureFrame = vi.fn(async () => Buffer.from("frame"));
    const bridge = new HoloCubicBridge({ captureFrame, createSocket: () => socket });

    bridge.start({ url: "ws://device:8766", frameRate: 10, maxBufferedBytes: 100 });
    socket.open();
    socket.bufferedAmount = 101;
    await vi.advanceTimersByTimeAsync(200);

    expect(captureFrame).not.toHaveBeenCalled();
    expect(bridge.getStatus().framesDropped).toBe(2);
  });

  it("allows only one capture operation in flight", async () => {
    const socket = new FakeSocket();
    let finishCapture: ((frame: Buffer) => void) | undefined;
    const captureFrame = vi.fn(() => new Promise<Buffer>((resolve) => { finishCapture = resolve; }));
    const bridge = new HoloCubicBridge({ captureFrame, createSocket: () => socket });

    bridge.start({ url: "ws://device:8766", frameRate: 10 });
    socket.open();
    await vi.advanceTimersByTimeAsync(300);
    expect(captureFrame).toHaveBeenCalledOnce();
    expect(bridge.getStatus().framesDropped).toBe(2);

    finishCapture?.(Buffer.from("frame"));
    await Promise.resolve();
    expect(socket.sent).toHaveLength(1);
  });

  it("reconnects with backoff after a disconnect and stops cleanly", async () => {
    const sockets = [new FakeSocket(), new FakeSocket()];
    const createSocket = vi.fn(() => sockets.shift()!);
    const bridge = new HoloCubicBridge({
      captureFrame: vi.fn(async () => Buffer.from("frame")),
      createSocket,
    });

    bridge.start({
      url: "ws://device:8766",
      frameRate: 5,
      reconnectMinMs: 500,
      reconnectMaxMs: 2_000,
    });
    const first = createSocket.mock.results[0].value as FakeSocket;
    first.open();
    first.disconnect();
    expect(bridge.getStatus()).toMatchObject({ state: "reconnecting", reconnectAttempt: 1 });

    await vi.advanceTimersByTimeAsync(499);
    expect(createSocket).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(createSocket).toHaveBeenCalledTimes(2);

    bridge.stop();
    expect(bridge.getStatus()).toMatchObject({ state: "stopped", connected: false });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(createSocket).toHaveBeenCalledTimes(2);
  });
});
