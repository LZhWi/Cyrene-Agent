import { WebSocket } from "ws";

const WS_CONNECTING = 0;
const WS_OPEN = 1;

export type HoloCubicConnectionState = "stopped" | "connecting" | "connected" | "reconnecting";

export interface HoloCubicBridgeConfig {
  url: string;
  frameRate: number;
  maxBufferedBytes?: number;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
}

export interface HoloCubicBridgeStatus {
  state: HoloCubicConnectionState;
  connected: boolean;
  framesCaptured: number;
  framesSent: number;
  framesDropped: number;
  reconnectAttempt: number;
  bufferedBytes: number;
  lastFrameAt: number | null;
  lastError: string;
}

export interface HoloCubicSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  on(event: "open", listener: () => void): this;
  on(event: "close", listener: () => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  send(data: Buffer, options: { binary: true }, callback: (error?: Error) => void): void;
  close(code?: number, reason?: string): void;
  terminate?(): void;
}

export interface HoloCubicBridgeDependencies {
  captureFrame: () => Promise<Buffer | null>;
  createSocket?: (url: string) => HoloCubicSocket;
  onStatusChanged?: (status: HoloCubicBridgeStatus) => void;
}

const DEFAULT_MAX_BUFFERED_BYTES = 512 * 1024;
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
    reconnectMinMs: Math.max(50, Math.round(config.reconnectMinMs ?? DEFAULT_RECONNECT_MIN_MS)),
    reconnectMaxMs: Math.max(50, Math.round(config.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS)),
  };
}

export class HoloCubicBridge {
  private readonly createSocket: (url: string) => HoloCubicSocket;
  private config: Required<HoloCubicBridgeConfig> | null = null;
  private socket: HoloCubicSocket | null = null;
  private frameTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private captureInFlight = false;
  private running = false;
  private generation = 0;
  private status: HoloCubicBridgeStatus = {
    state: "stopped",
    connected: false,
    framesCaptured: 0,
    framesSent: 0,
    framesDropped: 0,
    reconnectAttempt: 0,
    bufferedBytes: 0,
    lastFrameAt: null,
    lastError: "",
  };

  constructor(private readonly dependencies: HoloCubicBridgeDependencies) {
    this.createSocket = dependencies.createSocket ?? ((url) => new WebSocket(url) as HoloCubicSocket);
  }

  start(config: HoloCubicBridgeConfig): void {
    this.stop();
    this.config = normalizeConfig(config);
    this.running = true;
    this.status = {
      state: "connecting",
      connected: false,
      framesCaptured: 0,
      framesSent: 0,
      framesDropped: 0,
      reconnectAttempt: 0,
      bufferedBytes: 0,
      lastFrameAt: null,
      lastError: "",
    };
    this.emitStatus();
    this.connect();
  }

  stop(): void {
    this.running = false;
    this.generation += 1;
    this.clearFrameTimer();
    this.clearReconnectTimer();
    const socket = this.socket;
    this.socket = null;
    if (socket && (socket.readyState === WS_CONNECTING || socket.readyState === WS_OPEN)) {
      try {
        socket.close(1000, "Cyrene bridge stopped");
      } catch {
        socket.terminate?.();
      }
    }
    this.captureInFlight = false;
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

    socket.on("open", () => {
      if (!this.isCurrent(socket, generation)) return;
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
    socket.on("close", () => {
      if (!this.isCurrent(socket, generation)) return;
      this.socket = null;
      this.clearFrameTimer();
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
    this.frameTimer = setInterval(() => {
      void this.sendNextFrame();
    }, intervalMs);
  }

  private async sendNextFrame(): Promise<void> {
    const socket = this.socket;
    const config = this.config;
    if (!this.running || !socket || !config || socket.readyState !== WS_OPEN) return;
    if (this.captureInFlight || socket.bufferedAmount > config.maxBufferedBytes) {
      this.patchStatus({
        framesDropped: this.status.framesDropped + 1,
        bufferedBytes: socket.bufferedAmount,
      });
      return;
    }

    this.captureInFlight = true;
    try {
      const frame = await this.dependencies.captureFrame();
      if (!frame || !frame.length) return;
      this.patchStatus({ framesCaptured: this.status.framesCaptured + 1 });
      if (!this.running || this.socket !== socket || socket.readyState !== WS_OPEN
          || socket.bufferedAmount > config.maxBufferedBytes) {
        this.patchStatus({
          framesDropped: this.status.framesDropped + 1,
          bufferedBytes: socket.bufferedAmount,
        });
        return;
      }
      socket.send(frame, { binary: true }, (error) => {
        if (this.socket !== socket) return;
        if (error) {
          this.patchStatus({ lastError: errorText(error), bufferedBytes: socket.bufferedAmount });
          return;
        }
        this.patchStatus({
          framesSent: this.status.framesSent + 1,
          bufferedBytes: socket.bufferedAmount,
          lastFrameAt: Date.now(),
        });
      });
    } catch (error) {
      this.patchStatus({ lastError: errorText(error) });
    } finally {
      this.captureInFlight = false;
    }
  }

  private isCurrent(socket: HoloCubicSocket, generation: number): boolean {
    return this.running && this.socket === socket && this.generation === generation;
  }

  private clearFrameTimer(): void {
    if (!this.frameTimer) return;
    clearInterval(this.frameTimer);
    this.frameTimer = null;
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
