export interface HoloCubicSettings {
  enabled: boolean;
  connectionMode: "direct" | "listen";
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
  framesDisplayed: number;
  framesDropped: number;
  actualFrameRate: number;
  lastCaptureMs: number;
  lastAckMs: number;
  lastFrameBytes: number;
  reconnectAttempt: number;
  bufferedBytes: number;
  lastFrameAt: number | null;
  lastError: string;
  inputEvents: number;
  lastInput: HoloCubicInputEvent | null;
}

export type HoloCubicInputEvent =
  | { version: 1; type: "key"; key: "left" | "right" | "up" | "down" | "home"; event: string; at: number }
  | { version: 1; type: "imu"; roll: number; pitch: number; gx: number; gy: number; gz: number; at: number };

export interface HoloCubicFrameAck {
  version: 1;
  type: "frame_ack";
  displayed: boolean;
  at: number;
}

export type HoloCubicDeviceMessage = HoloCubicInputEvent | HoloCubicFrameAck;
