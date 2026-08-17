// Music 面板类型定义
// 从 settings.ts 抽离的纯类型。
// 注意：MusicApi 引用了 MusicStatusSnapshot，需从 shared/music-view-state import。

import type { MusicStatusSnapshot } from "../../shared/music-view-state";

export interface MusicSelectionTrack {
  id: string;
  name: string;
  artists: string[];
  album?: string;
  durationMs?: number;
}

export interface MusicSelectionResult {
  setId: string;
  source: string;
  query?: string;
  tracks: MusicSelectionTrack[];
}

export type MusicIpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; errorCode: string; backendState?: string; accountState?: string; playerState?: string };

export interface MusicApi {
  getStatus: () => Promise<MusicIpcResult<MusicStatusSnapshot>>;
  beginLogin: () => Promise<MusicIpcResult<{ loginSessionId: string; qrContent: string; expiresAt: number; pollIntervalMs: number }>>;
  cancelLogin: () => Promise<MusicIpcResult<unknown>>;
  logout: () => Promise<MusicIpcResult<unknown>>;
  search: (keyword: string, limit?: number) => Promise<MusicIpcResult<MusicSelectionResult>>;
  playTrack: (trackId: string) => Promise<MusicIpcResult<{ state: "dispatched" | "web_fallback" | "client_unavailable" | "launch_failed" }>>;
  onStateChanged: (h: (s: MusicStatusSnapshot) => void) => (() => void) | void;
  openComponentDir: () => Promise<{ ok: boolean; errorCode?: string }>;
  recheckComponent: () => Promise<MusicIpcResult<MusicStatusSnapshot>>;
}
