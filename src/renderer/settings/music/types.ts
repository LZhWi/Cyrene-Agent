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
  beginLogin: () => Promise<MusicIpcResult<{ loginSessionId?: string; qrContent?: string; expiresAt?: number; pollIntervalMs?: number }>>;
  cancelLogin: () => Promise<MusicIpcResult<unknown>>;
  logout: () => Promise<MusicIpcResult<unknown>>;
  search: (keyword: string, limit?: number) => Promise<MusicIpcResult<MusicSelectionResult>>;
  playTrack: (trackId: string) => Promise<MusicIpcResult<{ state: "dispatched" | "web_fallback" | "client_unavailable" | "launch_failed" }>>;
  getOpenapiConfig: () => Promise<MusicIpcResult<{ appId: string; privateKey: string } | null>>;
  saveOpenapiConfig: (config: { appId: string; privateKey: string }) => Promise<MusicIpcResult<{ backend: string }>>;
  openPlayer: () => Promise<unknown>;
  onStateChanged: (h: (s: MusicStatusSnapshot) => void) => (() => void) | void;
  // ── QQ 音乐（外部播放器，SMTC）──
  // 与上面网易云那套无关：不需要登录，也没有搜索/歌单，只有检测 + 传输控制。
  qqDetect: () => Promise<MusicIpcResult<QQMusicDetection>>;
  qqControl: (command: QQCommand) => Promise<MusicIpcResult<{ applied: string }>>;
}

export type QQCommand = "next" | "prev" | "play" | "pause" | "toggle";

export interface QQMusicDetection {
  installed: boolean;
  installPath: string | null;
  version: string | null;
  running: boolean;
  helperAvailable: boolean;
  controllable: boolean;
  nowPlaying: { title: string; artist: string; album: string; status: string } | null;
}
