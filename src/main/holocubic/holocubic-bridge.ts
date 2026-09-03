import { EventEmitter } from "events";
import { createConnection, type Socket } from "net";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type {
  HoloCubicDeviceMessage,
  HoloCubicInputEvent,
  HoloCubicStatus,
} from "../../shared/holocubic-types";

const SOCKET_CONNECTING = 0;
const SOCKET_OPEN = 1;
const MAX_CONTROL_BUFFER_BYTES = 64 * 1024;

export function encodeHoloCubicFrame(frame: Buffer): Buffer {
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(frame.length, 0);
  return Buffer.concat([header, frame]);
}

export function extractHoloCubicControlLines(buffer: string): { lines: string[]; remainder: string } {
  const parts = buffer.split("\n");
  const remainder = parts.pop() ?? "";
  return {
    lines: parts.map((line) => line.endsWith("\r") ? line.slice(0, -1) : line).filter(Boolean),
    remainder,
  };
}

class HoloCubicRawSocket extends EventEmitter implements HoloCubicSocket {
  private readonly socket: Socket;
  private controlBuffer = "";

  constructor(url: string) {
    super();
    const endpoint = new URL(url);
    const port = Number(endpoint.port);
    if (!endpoint.hostname || !Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error(`Invalid HoloCubic endpoint: ${url}`);
    }
    this.socket = createConnection({ host: endpoint.hostname, port });
    this.socket.on("connect", () => this.emit("open"));
    this.socket.on("close", () => this.emit("close"));
    this.socket.on("error", (error) => this.emit("error", error));
    this.socket.on("data", (chunk) => {
      this.controlBuffer += chunk.toString("utf8");
      if (Buffer.byteLength(this.controlBuffer, "utf8") > MAX_CONTROL_BUFFER_BYTES) {
        this.controlBuffer = "";
        this.socket.destroy(new Error("HoloCubic control buffer exceeded 64 KiB"));
        return;
      }
      const parsed = extractHoloCubicControlLines(this.controlBuffer);
      this.controlBuffer = parsed.remainder;
      for (const line of parsed.lines) this.emit("message", Buffer.from(line, "utf8"), false);
    });
  }

  get readyState(): number {
    if (this.socket.destroyed) return 3;
    return this.socket.connecting ? SOCKET_CONNECTING : SOCKET_OPEN;
  }

  get bufferedAmount(): number {
    return this.socket.writableLength;
  }

  send(data: Buffer, _options: { binary: true }, callback: (error?: Error) => void): void {
    if (this.readyState !== SOCKET_OPEN) {
      callback(new Error("HoloCubic TCP socket is not open"));
      return;
    }
    this.socket.write(encodeHoloCubicFrame(data), (error) => callback(error ?? undefined));
  }

  close(): void {
    this.socket.end();
  }

  terminate(): void {
    this.socket.destroy();
  }
}

function websocketDataToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

class HoloCubicWebSocketListener extends EventEmitter implements HoloCubicSocket {
  private readonly server: WebSocketServer;
  private peer: WebSocket | null = null;
  private closed = false;
  private closeEmitted = false;

  constructor(url: string) {
    super();
    const endpoint = new URL(url);
    const port = Number(endpoint.port);
    if (!endpoint.hostname || !Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error(`Invalid HoloCubic listener endpoint: ${url}`);
    }
    this.server = new WebSocketServer({
      host: endpoint.hostname,
      port,
      maxPayload: 64 * 1024,
      perMessageDeflate: false,
    });
    this.server.on("connection", (peer) => {
      if (this.closed || this.peer) {
        peer.close(1013, "HoloCubic device already connected");
        return;
      }
      this.peer = peer;
      peer.on("message", (data, isBinary) => {
        const payload = websocketDataToBuffer(data);
        if (isBinary) {
          this.emit("message", payload, true);
          return;
        }
        for (const line of payload.toString("utf8").split(/\r?\n/).filter(Boolean)) {
          this.emit("message", Buffer.from(line, "utf8"), false);
        }
      });
      peer.on("error", (error) => this.emit("error", error));
      peer.on("close", () => this.shutdown(true));
      this.emit("open");
    });
    this.server.on("error", (error) => {
      this.emit("error", error);
      this.shutdown(true);
    });
  }

  get readyState(): number {
    if (this.closed) return 3;
    return this.peer?.readyState === WebSocket.OPEN ? SOCKET_OPEN : SOCKET_CONNECTING;
  }

  get bufferedAmount(): number {
    return this.peer?.bufferedAmount ?? 0;
  }

  send(data: Buffer, _options: { binary: true }, callback: (error?: Error) => void): void {
    if (!this.peer || this.peer.readyState !== WebSocket.OPEN) {
      callback(new Error("HoloCubic WebSocket peer is not open"));
      return;
    }
    this.peer.send(data, { binary: true }, (error) => callback(error ?? undefined));
  }

  close(): void {
    this.shutdown(false);
  }

  terminate(): void {
    this.shutdown(false, true);
  }

  private shutdown(emitClose: boolean, terminatePeer = false): void {
    if (this.closed) return;
    this.closed = true;
    const peer = this.peer;
    this.peer = null;
    try {
      if (peer) {
        if (terminatePeer) peer.terminate();
        else peer.close(1000, "Cyrene bridge stopped");
      }
    } catch {
      peer?.terminate();
    }
    try {
      this.server.close();
    } catch {
      // The listener may already be closing after a startup error.
    }
    if (emitClose && !this.closeEmitted) {
      this.closeEmitted = true;
      this.emit("close");
    }
  }
}

export interface HoloCubicBridgeConfig {
  url: string;
  frameRate: number;
  maxBufferedBytes?: number;
  connectTimeoutMs?: number;
  frameAckTimeoutMs?: number;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
}

export type HoloCubicBridgeStatus = HoloCubicStatus;

export interface HoloCubicSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  on(event: "open", listener: () => void): this;
  on(event: "close", listener: () => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "message", listener: (data: unknown, isBinary: boolean) => void): this;
  send(data: Buffer, options: { binary: true }, callback: (error?: Error) => void): void;
  close(code?: number, reason?: string): void;
  terminate?(): void;
}

export interface HoloCubicBridgeDependencies {
  captureFrame: () => Promise<Buffer | null>;
  createSocket?: (url: string) => HoloCubicSocket;
  onStatusChanged?: (status: HoloCubicBridgeStatus) => void;
  onInputEvent?: (event: HoloCubicInputEvent) => void;
}

const DEFAULT_MAX_BUFFERED_BYTES = 512 * 1024;
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_FRAME_ACK_TIMEOUT_MS = 2_000;
const DEFAULT_RECONNECT_MIN_MS = 500;
const DEFAULT_RECONNECT_MAX_MS = 10_000;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeConfig(config: HoloCubicBridgeConfig): Required<HoloCubicBridgeConfig> {
  return {
    url: config.url,
    frameRate: Math.max(1, Math.min(30, Math.round(config.frameRate))),
    maxBufferedBytes: Math.max(1, Math.round(config.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES)),
    connectTimeoutMs: config.connectTimeoutMs === 0
      ? 0
      : Math.max(250, Math.round(config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS)),
    frameAckTimeoutMs: Math.max(250, Math.round(config.frameAckTimeoutMs ?? DEFAULT_FRAME_ACK_TIMEOUT_MS)),
    reconnectMinMs: Math.max(50, Math.round(config.reconnectMinMs ?? DEFAULT_RECONNECT_MIN_MS)),
    reconnectMaxMs: Math.max(50, Math.round(config.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS)),
  };
}

export class HoloCubicBridge {
  private readonly createSocket: (url: string) => HoloCubicSocket;
  private config: Required<HoloCubicBridgeConfig> | null = null;
  private socket: HoloCubicSocket | null = null;
  private frameTimer: NodeJS.Timeout | null = null;
  private connectTimer: NodeJS.Timeout | null = null;
  private frameAckTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private captureInFlight = false;
  private awaitingFrameAck = false;
  private lastFrameSentAt = 0;
  private displayedAt: number[] = [];
  private running = false;
  private generation = 0;
  private status: HoloCubicBridgeStatus = {
    state: "stopped",
    connected: false,
    framesCaptured: 0,
    framesSent: 0,
    framesDisplayed: 0,
    framesDropped: 0,
    actualFrameRate: 0,
    lastCaptureMs: 0,
    lastAckMs: 0,
    lastFrameBytes: 0,
    reconnectAttempt: 0,
    bufferedBytes: 0,
    lastFrameAt: null,
    lastError: "",
    inputEvents: 0,
    lastInput: null,
  };

  constructor(private readonly dependencies: HoloCubicBridgeDependencies) {
    this.createSocket = dependencies.createSocket ?? ((url) => {
      const protocol = new URL(url).protocol;
      return protocol === "ws-listen:"
        ? new HoloCubicWebSocketListener(url)
        : new HoloCubicRawSocket(url);
    });
  }

  start(config: HoloCubicBridgeConfig): void {
    const normalized = normalizeConfig(config);
    if (this.running && this.config?.url === normalized.url && this.socket?.readyState === SOCKET_OPEN) {
      this.config = normalized;
      this.clearFrameTimer();
      if (!this.awaitingFrameAck) this.startFrameTimer();
      return;
    }
    this.stop();
    this.config = normalized;
    this.running = true;
    this.status = {
      state: "connecting",
      connected: false,
      framesCaptured: 0,
      framesSent: 0,
      framesDisplayed: 0,
      framesDropped: 0,
      actualFrameRate: 0,
      lastCaptureMs: 0,
      lastAckMs: 0,
      lastFrameBytes: 0,
      reconnectAttempt: 0,
      bufferedBytes: 0,
      lastFrameAt: null,
      lastError: "",
      inputEvents: 0,
      lastInput: null,
    };
    this.emitStatus();
    this.connect();
  }

  stop(): void {
    this.running = false;
    this.generation += 1;
    this.clearFrameTimer();
    this.clearConnectTimer();
    this.clearFrameAck();
    this.clearReconnectTimer();
    const socket = this.socket;
    this.socket = null;
    if (socket && (socket.readyState === SOCKET_CONNECTING || socket.readyState === SOCKET_OPEN)) {
      try {
        socket.close(1000, "Cyrene bridge stopped");
      } catch {
        socket.terminate?.();
      }
    }
    this.captureInFlight = false;
    this.lastFrameSentAt = 0;
    this.displayedAt = [];
    this.patchStatus({ state: "stopped", connected: false, bufferedBytes: 0 });
  }

  getStatus(): HoloCubicBridgeStatus {
    return { ...this.status };
  }

  private connect(): void {
    if (!this.running || !this.config) return;
    const generation = ++this.generation;
    let socket: HoloCubicSocket;
    try {
      socket = this.createSocket(this.config.url);
    } catch (error) {
      this.patchStatus({ lastError: errorText(error) });
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    if (this.config.connectTimeoutMs > 0) {
      this.connectTimer = setTimeout(() => {
        if (!this.isCurrent(socket, generation)) return;
        this.abandonSocket(socket, "HoloCubic connection timed out");
      }, this.config.connectTimeoutMs);
    }

    socket.on("open", () => {
      if (!this.isCurrent(socket, generation)) return;
      this.clearConnectTimer();
      this.clearFrameAck();
      this.lastFrameSentAt = 0;
      this.displayedAt = [];
      this.patchStatus({
        state: "connected",
        connected: true,
        reconnectAttempt: 0,
        bufferedBytes: socket.bufferedAmount,
        lastError: "",
      });
      this.startFrameTimer();
    });
    socket.on("error", (error) => {
      if (!this.isCurrent(socket, generation)) return;
      this.patchStatus({ lastError: errorText(error) });
    });
    socket.on("message", (data, isBinary) => {
      if (!this.isCurrent(socket, generation) || isBinary) return;
      const message = parseHoloCubicDeviceMessage(data);
      if (!message) return;
      if (message.type === "frame_ack") {
        if (!this.awaitingFrameAck) return;
        const acknowledgedAt = Date.now();
        const acknowledgementMs = Math.max(0, acknowledgedAt - this.lastFrameSentAt);
        if (message.displayed) {
          this.displayedAt.push(acknowledgedAt);
          const windowStart = acknowledgedAt - 5_000;
          while (this.displayedAt.length > 1 && this.displayedAt[0] < windowStart) {
            this.displayedAt.shift();
          }
        }
        const measuredDurationMs = this.displayedAt.length > 1
          ? this.displayedAt[this.displayedAt.length - 1] - this.displayedAt[0]
          : 0;
        const actualFrameRate = measuredDurationMs > 0
          ? ((this.displayedAt.length - 1) * 1000) / measuredDurationMs
          : 0;
        this.clearFrameAck();
        this.patchStatus({
          framesDisplayed: this.status.framesDisplayed + (message.displayed ? 1 : 0),
          framesDropped: this.status.framesDropped + (message.displayed ? 0 : 1),
          actualFrameRate,
          lastAckMs: acknowledgementMs,
          lastFrameAt: message.displayed ? acknowledgedAt : this.status.lastFrameAt,
        });
        this.startFrameTimer();
        return;
      }
      const event = message;
      this.patchStatus({ inputEvents: this.status.inputEvents + 1, lastInput: event });
      this.dependencies.onInputEvent?.(event);
    });
    socket.on("close", () => {
      if (!this.isCurrent(socket, generation)) return;
      this.socket = null;
      this.clearFrameTimer();
      this.clearConnectTimer();
      this.clearFrameAck();
      this.patchStatus({ connected: false, bufferedBytes: 0 });
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (!this.running || !this.config || this.reconnectTimer) return;
    const attempt = this.status.reconnectAttempt + 1;
    const delay = Math.min(
      this.config.reconnectMaxMs,
      this.config.reconnectMinMs * (2 ** Math.max(0, attempt - 1)),
    );
    this.patchStatus({ state: "reconnecting", connected: false, reconnectAttempt: attempt });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.running) return;
      this.patchStatus({ state: "connecting" });
      this.connect();
    }, delay);
  }

  private startFrameTimer(): void {
    if (!this.config || this.frameTimer) return;
    const intervalMs = Math.max(1, Math.round(1000 / this.config.frameRate));
    const elapsed = this.lastFrameSentAt > 0 ? Date.now() - this.lastFrameSentAt : 0;
    const delayMs = this.lastFrameSentAt > 0 ? Math.max(0, intervalMs - elapsed) : intervalMs;
    this.frameTimer = setTimeout(() => {
      this.frameTimer = null;
      void this.sendNextFrame();
    }, delayMs);
  }

  private async sendNextFrame(): Promise<void> {
    const socket = this.socket;
    const config = this.config;
    if (!this.running || !socket || !config || socket.readyState !== SOCKET_OPEN) return;
    if (this.captureInFlight || this.awaitingFrameAck) return;
    if (socket.bufferedAmount > config.maxBufferedBytes) {
      this.patchStatus({
        framesDropped: this.status.framesDropped + 1,
        bufferedBytes: socket.bufferedAmount,
      });
      this.startFrameTimer();
      return;
    }

    this.captureInFlight = true;
    try {
      const captureStartedAt = Date.now();
      const frame = await this.dependencies.captureFrame();
      if (!frame || !frame.length) return;
      this.patchStatus({
        framesCaptured: this.status.framesCaptured + 1,
        lastCaptureMs: Math.max(0, Date.now() - captureStartedAt),
        lastFrameBytes: frame.length,
      });
      if (!this.running || this.socket !== socket || socket.readyState !== SOCKET_OPEN
          || socket.bufferedAmount > config.maxBufferedBytes) {
        this.patchStatus({
          framesDropped: this.status.framesDropped + 1,
          bufferedBytes: socket.bufferedAmount,
        });
        return;
      }
      this.awaitingFrameAck = true;
      this.lastFrameSentAt = Date.now();
      this.frameAckTimer = setTimeout(() => {
        if (!this.running || this.socket !== socket || !this.awaitingFrameAck) return;
        this.abandonSocket(socket, "Device frame acknowledgement timed out");
      }, config.frameAckTimeoutMs);
      socket.send(frame, { binary: true }, (error) => {
        if (this.socket !== socket) return;
        if (error) {
          this.clearFrameAck();
          this.patchStatus({ lastError: errorText(error), bufferedBytes: socket.bufferedAmount });
          this.startFrameTimer();
          return;
        }
        this.patchStatus({
          framesSent: this.status.framesSent + 1,
          bufferedBytes: socket.bufferedAmount,
        });
      });
    } catch (error) {
      this.clearFrameAck();
      this.patchStatus({ lastError: errorText(error) });
    } finally {
      this.captureInFlight = false;
      if (!this.awaitingFrameAck && this.running && this.socket === socket) this.startFrameTimer();
    }
  }

  private isCurrent(socket: HoloCubicSocket, generation: number): boolean {
    return this.running && this.socket === socket && this.generation === generation;
  }

  private abandonSocket(socket: HoloCubicSocket, message: string): void {
    if (!this.running || this.socket !== socket) return;
    this.socket = null;
    this.clearFrameTimer();
    this.clearConnectTimer();
    this.clearFrameAck();
    this.patchStatus({ connected: false, bufferedBytes: 0, lastError: message });
    try {
      if (socket.terminate) socket.terminate();
      else socket.close();
    } catch {
      // Reconnect below even when the half-open socket cannot close cleanly.
    }
    this.scheduleReconnect();
  }

  private clearFrameTimer(): void {
    if (!this.frameTimer) return;
    clearInterval(this.frameTimer);
    this.frameTimer = null;
  }

  private clearConnectTimer(): void {
    if (!this.connectTimer) return;
    clearTimeout(this.connectTimer);
    this.connectTimer = null;
  }

  private clearFrameAck(): void {
    this.awaitingFrameAck = false;
    if (!this.frameAckTimer) return;
    clearTimeout(this.frameAckTimer);
    this.frameAckTimer = null;
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private patchStatus(patch: Partial<HoloCubicBridgeStatus>): void {
    this.status = { ...this.status, ...patch };
    this.emitStatus();
  }

  private emitStatus(): void {
    this.dependencies.onStatusChanged?.(this.getStatus());
  }
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function parseHoloCubicInputEvent(data: unknown): HoloCubicInputEvent | null {
  const message = parseHoloCubicDeviceMessage(data);
  return message?.type === "frame_ack" ? null : message;
}

export function parseHoloCubicDeviceMessage(data: unknown): HoloCubicDeviceMessage | null {
  let text: string;
  if (typeof data === "string") text = data;
  else if (Buffer.isBuffer(data)) text = data.toString("utf8");
  else if (data instanceof ArrayBuffer) text = Buffer.from(data).toString("utf8");
  else return null;
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    const at = finiteNumber(value.at);
    if (value.version !== 1 || at === null) return null;
    if (value.type === "frame_ack") {
      if (typeof value.displayed !== "boolean") return null;
      return { version: 1, type: "frame_ack", displayed: value.displayed, at };
    }
    if (value.type === "key") {
      const keys = ["left", "right", "up", "down", "home"];
      if (!keys.includes(String(value.key)) || typeof value.event !== "string") return null;
      return {
        version: 1,
        type: "key",
        key: value.key as "left" | "right" | "up" | "down" | "home",
        event: value.event,
        at,
      };
    }
    if (value.type === "imu") {
      const roll = finiteNumber(value.roll);
      const pitch = finiteNumber(value.pitch);
      const gx = finiteNumber(value.gx);
      const gy = finiteNumber(value.gy);
      const gz = finiteNumber(value.gz);
      if (roll === null || pitch === null || gx === null || gy === null || gz === null) return null;
      return { version: 1, type: "imu", roll, pitch, gx, gy, gz, at };
    }
  } catch {
    return null;
  }
  return null;
}
