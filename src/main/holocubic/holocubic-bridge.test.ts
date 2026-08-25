import { EventEmitter } from "events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HoloCubicBridge,
  encodeHoloCubicFrame,
  extractHoloCubicControlLines,
  parseHoloCubicDeviceMessage,
  parseHoloCubicInputEvent,
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
      framesDisplayed: 0,
      framesDropped: 0,
    });
  });

  it("accepts validated text input events from the connected device", () => {
    const socket = new FakeSocket();
    const onInputEvent = vi.fn();
    const bridge = new HoloCubicBridge({ captureFrame: async () => null, createSocket: () => socket, onInputEvent });
    bridge.start({ url: "ws://device:8766", frameRate: 5 });
    socket.open();

    socket.emit("message", Buffer.from('{"version":1,"type":"key","key":"left","event":"short","at":12}'), false);
    socket.emit("message", Buffer.from('{"type":"key","key":"left"}'), false);
    socket.emit("message", Buffer.from("jpeg"), true);

    expect(onInputEvent).toHaveBeenCalledOnce();
    expect(bridge.getStatus()).toMatchObject({ inputEvents: 1, lastInput: { type: "key", key: "left" } });
  });

  it("waits for the device frame acknowledgement before sending another frame", async () => {
    const socket = new FakeSocket();
    const captureFrame = vi.fn(async () => Buffer.from("frame"));
    const bridge = new HoloCubicBridge({ captureFrame, createSocket: () => socket });
    bridge.start({ url: "ws://device:8766", frameRate: 10 });
    socket.open();

    await vi.advanceTimersByTimeAsync(300);
    expect(socket.sent).toHaveLength(1);
    expect(captureFrame).toHaveBeenCalledOnce();
    expect(bridge.getStatus()).toMatchObject({ framesSent: 1, framesDisplayed: 0, framesDropped: 0 });

    socket.emit("message", Buffer.from('{"version":1,"type":"frame_ack","displayed":true,"at":12}'), false);
    expect(bridge.getStatus()).toMatchObject({ framesDisplayed: 1, inputEvents: 0 });
    await vi.advanceTimersByTimeAsync(100);
    expect(socket.sent).toHaveLength(2);
  });

  it("reconnects when a submitted frame is never acknowledged", async () => {
    const sockets = [new FakeSocket(), new FakeSocket()];
    const createSocket = vi.fn(() => sockets.shift()!);
    const bridge = new HoloCubicBridge({ captureFrame: async () => Buffer.from("frame"), createSocket });
    bridge.start({
      url: "ws://device:8766",
      frameRate: 10,
      frameAckTimeoutMs: 500,
      reconnectMinMs: 250,
    });
    const first = createSocket.mock.results[0].value as FakeSocket;
    first.open();
    await vi.advanceTimersByTimeAsync(600);

    expect(first.terminate).toHaveBeenCalledOnce();
    expect(bridge.getStatus()).toMatchObject({
      state: "reconnecting",
      connected: false,
      lastError: "Device frame acknowledgement timed out",
    });
    await vi.advanceTimersByTimeAsync(250);
    expect(createSocket).toHaveBeenCalledTimes(2);
  });

  it("updates frame pacing without reconnecting an open socket", async () => {
    const socket = new FakeSocket();
    const createSocket = vi.fn(() => socket);
    const bridge = new HoloCubicBridge({ captureFrame: async () => null, createSocket });
    bridge.start({ url: "ws://device:8766", frameRate: 5 });
    socket.open();

    bridge.start({ url: "ws://device:8766", frameRate: 10 });
    expect(createSocket).toHaveBeenCalledOnce();
    expect(socket.close).not.toHaveBeenCalled();
    expect(bridge.getStatus()).toMatchObject({ state: "connected", connected: true });
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
    expect(bridge.getStatus().framesDropped).toBe(0);

    finishCapture?.(Buffer.from("frame"));
    await Promise.resolve();
    expect(socket.sent).toHaveLength(1);
  });

  it("paces the next frame from the previous send after a delayed acknowledgement", async () => {
    const socket = new FakeSocket();
    const bridge = new HoloCubicBridge({
      captureFrame: async () => Buffer.from("frame"),
      createSocket: () => socket,
    });
    bridge.start({ url: "ws://device:8766", frameRate: 5 });
    socket.open();

    await vi.advanceTimersByTimeAsync(200);
    expect(socket.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(150);
    socket.emit("message", Buffer.from('{"version":1,"type":"frame_ack","displayed":true,"at":12}'), false);
    await vi.advanceTimersByTimeAsync(49);
    expect(socket.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(socket.sent).toHaveLength(2);
  });

  it("reports capture, acknowledgement, frame size, and measured display rate", async () => {
    const socket = new FakeSocket();
    const bridge = new HoloCubicBridge({
      captureFrame: async () => Buffer.from("frame"),
      createSocket: () => socket,
    });
    bridge.start({ url: "ws://device:8766", frameRate: 5 });
    socket.open();

    await vi.advanceTimersByTimeAsync(200);
    socket.emit("message", Buffer.from('{"version":1,"type":"frame_ack","displayed":true,"at":12}'), false);
    await vi.advanceTimersByTimeAsync(200);
    socket.emit("message", Buffer.from('{"version":1,"type":"frame_ack","displayed":true,"at":13}'), false);

    expect(bridge.getStatus()).toMatchObject({
      actualFrameRate: 5,
      lastCaptureMs: 0,
      lastAckMs: 0,
      lastFrameBytes: 5,
    });
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

  it("abandons a stalled TCP connection and reconnects", async () => {
    const sockets = [new FakeSocket(), new FakeSocket()];
    const createSocket = vi.fn(() => sockets.shift()!);
    const bridge = new HoloCubicBridge({ captureFrame: async () => null, createSocket });

    bridge.start({
      url: "ws://device:8766",
      frameRate: 5,
      connectTimeoutMs: 1_000,
      reconnectMinMs: 500,
    });
    const first = createSocket.mock.results[0].value as FakeSocket;

    await vi.advanceTimersByTimeAsync(999);
    expect(first.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(first.terminate).toHaveBeenCalledOnce();
    expect(bridge.getStatus()).toMatchObject({
      state: "reconnecting",
      connected: false,
      reconnectAttempt: 1,
      lastError: "TCP connection timed out",
    });

    await vi.advanceTimersByTimeAsync(500);
    expect(createSocket).toHaveBeenCalledTimes(2);
    const second = createSocket.mock.results[1].value as FakeSocket;
    second.open();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(second.terminate).not.toHaveBeenCalled();
    expect(bridge.getStatus()).toMatchObject({ state: "connected", connected: true });
  });
});

describe("HoloCubic raw TCP framing", () => {
  it("prefixes JPEG frames with a four-byte big-endian length", () => {
    const encoded = encodeHoloCubicFrame(Buffer.from([0xff, 0xd8, 0xff]));
    expect(encoded.subarray(0, 4).readUInt32BE(0)).toBe(3);
    expect(encoded.subarray(4)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  });

  it("extracts complete newline-delimited control messages and keeps a partial tail", () => {
    expect(extractHoloCubicControlLines('{"type":"frame_ack"}\n{"type":"key"')).toEqual({
      lines: ['{"type":"frame_ack"}'],
      remainder: '{"type":"key"',
    });
  });
});

describe("parseHoloCubicInputEvent", () => {
  it("validates IMU payloads and rejects malformed input", () => {
    expect(parseHoloCubicInputEvent('{"version":1,"type":"imu","roll":1,"pitch":2,"gx":3,"gy":4,"gz":5,"at":6}')).toEqual({
      version: 1, type: "imu", roll: 1, pitch: 2, gx: 3, gy: 4, gz: 5, at: 6,
    });
    expect(parseHoloCubicInputEvent('{"version":1,"type":"imu","roll":"bad"}')).toBeNull();
    expect(parseHoloCubicInputEvent("not json")).toBeNull();
  });

  it("parses frame acknowledgements separately from input events", () => {
    const payload = '{"version":1,"type":"frame_ack","displayed":true,"at":6}';
    expect(parseHoloCubicDeviceMessage(payload)).toEqual({
      version: 1, type: "frame_ack", displayed: true, at: 6,
    });
    expect(parseHoloCubicInputEvent(payload)).toBeNull();
    expect(parseHoloCubicDeviceMessage('{"version":1,"type":"frame_ack","displayed":"yes","at":6}')).toBeNull();
  });
});
