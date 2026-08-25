export interface HoloCubicSettings {
  enabled: boolean;
  host: string;
  port: number;
  frameRate: number;
  jpegQuality: number;
}

export type HoloCubicConnectionState = "stopped" | "connecting" | "connected" | "reconnecting";

export interface HoloCubicStatus {
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
