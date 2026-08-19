import { ipcMain, BrowserWindow } from "electron";
import { IPC } from "../../shared/ipc-channels";
import { MusicInputError, type MusicBackendState, type MusicAccountState, type MusicPlayerState } from "./types";
import type { MusicService } from "./music-service";
import { sanitizeLogLine } from "./log-sanitizer";
import { parseLrc } from "./lyrics-parser";
import { LyricsCache } from "./lyrics-cache";

export type MusicIpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; errorCode: string; backendState?: MusicBackendState;
      accountState?: MusicAccountState; playerState?: MusicPlayerState };

function wrap<T>(
  fn: () => Promise<T>,
  service: MusicService,
): Promise<MusicIpcResult<T>> {
  return fn().then(
    (data) => ({ ok: true as const, data }),
    (err: unknown) => {
      if (err instanceof MusicInputError) {
        return {
          ok: false as const,
          errorCode: err.code,
          backendState: service.getBackendState(),
          accountState: service.getAccountState(),
          playerState: service.getPlayerState(),
        };
      }
      console.error("[music] IPC handler failed", sanitizeLogLine(String(err)));
      return { ok: false as const, errorCode: "E_INTERNAL_ERROR" };
    },
  );
}

export function registerMusicIpcHandlers(service: MusicService): () => void {
  const channels: string[] = [];

  ipcMain.handle(IPC.MUSIC_GET_STATUS, () =>
    wrap(async () => {
      const flow = service.getLoginFlowState();
      if (flow === "creating_qr" || flow === "waiting_scan" || flow === "waiting_confirm") {
        await service.pollOnce();
      }
      return {
        backend: service.getBackendState(),
        account: service.getAccountState(),
        player: service.getPlayerState(),
        flow: service.getLoginFlowState(),
      };
    }, service),
  );
  channels.push(IPC.MUSIC_GET_STATUS);

  ipcMain.handle(IPC.MUSIC_BEGIN_LOGIN, () => wrap(() => service.beginLogin(), service));
  channels.push(IPC.MUSIC_BEGIN_LOGIN);

  ipcMain.handle(IPC.MUSIC_CANCEL_LOGIN, () => wrap(() => service.cancelLogin(), service));
  channels.push(IPC.MUSIC_CANCEL_LOGIN);

  ipcMain.handle(IPC.MUSIC_LOGOUT, () => wrap(() => service.logout(), service));
  channels.push(IPC.MUSIC_LOGOUT);

  ipcMain.handle(IPC.MUSIC_GET_DAILY, () =>
    wrap(() => service.getDailyRecommendations("default"), service),
  );
  channels.push(IPC.MUSIC_GET_DAILY);

  ipcMain.handle(IPC.MUSIC_SEARCH, (_e, payload: { keyword: string; limit?: number }) =>
    wrap(() => service.searchTracks(payload.keyword, "default", payload.limit), service),
  );
  channels.push(IPC.MUSIC_SEARCH);

  ipcMain.handle(IPC.MUSIC_PRESENT_TRACKS, (_e, args) =>
    wrap(() => service.presentTracks(args as Parameters<typeof service.presentTracks>[0]), service),
  );
  channels.push(IPC.MUSIC_PRESENT_TRACKS);

  ipcMain.handle(IPC.MUSIC_PLAY_TRACK, (_e, trackId: string) =>
    wrap(() => service.playTrackFromUi(trackId), service),
  );
  channels.push(IPC.MUSIC_PLAY_TRACK);

  ipcMain.handle(IPC.MUSIC_PLAY_PLAYLIST, (_e, playlistId: string) =>
    wrap(() => service.playPlaylist(playlistId), service),
  );
  channels.push(IPC.MUSIC_PLAY_PLAYLIST);

  // 用户歌单（播放器窗口顶部 chips + loadPlaylist 用）
  ipcMain.handle(IPC.MUSIC_GET_MY_PLAYLISTS, () =>
    wrap(() => service.getMyPlaylists(), service),
  );
  channels.push(IPC.MUSIC_GET_MY_PLAYLISTS);

  ipcMain.handle(IPC.MUSIC_GET_PLAYLIST_DETAIL, (_e, playlistId: string) =>
    wrap(() => service.getPlaylistDetail(playlistId), service),
  );
  channels.push(IPC.MUSIC_GET_PLAYLIST_DETAIL);

  ipcMain.handle(IPC.MUSIC_DETECT_PLAYER, () =>
    wrap(async () => service.getPlayerState(), service),
  );
  channels.push(IPC.MUSIC_DETECT_PLAYER);

  // OpenAPI credential config (appId + privateKey).  These do NOT go through
  // wrap() — saveOpenapiConfig is the prerequisite for backend readiness, so
  // it must succeed even when the backend is currently "incompatible".
  ipcMain.handle(IPC.MUSIC_GET_OPENAPI_CONFIG, async () => {
    try {
      const config = await service.getOpenapiConfig();
      // Mask privateKey in the returned payload — renderer only needs to
      // know whether config exists + the appId for display.
      return config
        ? { ok: true as const, data: { appId: config.appId, privateKey: "" } }
        : { ok: true as const, data: null };
    } catch (err: unknown) {
      console.error("[music] getOpenapiConfig failed", sanitizeLogLine(String(err)));
      return { ok: false as const, errorCode: "E_INTERNAL_ERROR" };
    }
  });
  channels.push(IPC.MUSIC_GET_OPENAPI_CONFIG);

  ipcMain.handle(
    IPC.MUSIC_SAVE_OPENAPI_CONFIG,
    (_e, config: { appId: string; privateKey: string }) =>
      service.applyOpenapiConfig(config).then(
        () => ({ ok: true as const, data: { backend: service.getBackendState() } }),
        (err: unknown) => {
          if (err instanceof MusicInputError) {
            return { ok: false as const, errorCode: err.code };
          }
          console.error("[music] saveOpenapiConfig failed", sanitizeLogLine(String(err)));
          return { ok: false as const, errorCode: "E_INTERNAL_ERROR" };
        },
      ),
  );
  channels.push(IPC.MUSIC_SAVE_OPENAPI_CONFIG);

  // ── mpv 播放控制 ───────────────────────────────────────────
  ipcMain.handle(IPC.MUSIC_PLAYBACK_PLAY, () => wrap(() => service.playbackPlay(), service));
  channels.push(IPC.MUSIC_PLAYBACK_PLAY);

  ipcMain.handle(IPC.MUSIC_PLAYBACK_PAUSE, () => wrap(() => service.playbackPause(), service));
  channels.push(IPC.MUSIC_PLAYBACK_PAUSE);

  ipcMain.handle(IPC.MUSIC_PLAYBACK_TOGGLE, () => wrap(() => service.playbackToggle(), service));
  channels.push(IPC.MUSIC_PLAYBACK_TOGGLE);

  ipcMain.handle(IPC.MUSIC_PLAYBACK_SEEK, (_e, seconds: number) =>
    wrap(() => service.playbackSeek(seconds), service),
  );
  channels.push(IPC.MUSIC_PLAYBACK_SEEK);

  ipcMain.handle(IPC.MUSIC_PLAYBACK_VOLUME, (_e, vol: number) =>
    wrap(() => service.playbackSetVolume(vol), service),
  );
  channels.push(IPC.MUSIC_PLAYBACK_VOLUME);

  ipcMain.handle(IPC.MUSIC_PLAYBACK_STOP, () => wrap(() => service.playbackStop(), service));
  channels.push(IPC.MUSIC_PLAYBACK_STOP);

  ipcMain.handle(IPC.MUSIC_PLAYBACK_NEXT, () => wrap(() => service.playbackNext(), service));
  channels.push(IPC.MUSIC_PLAYBACK_NEXT);

  ipcMain.handle(IPC.MUSIC_PLAYBACK_PREV, () => wrap(() => service.playbackPrev(), service));
  channels.push(IPC.MUSIC_PLAYBACK_PREV);

  // ── UI 直连：歌词（不经 AI 工具层） ─────────────────────────
  const lyricsCache = new LyricsCache(service.getLyricsCacheDir());
  ipcMain.handle(IPC.MUSIC_GET_LYRICS, (_e, payload: { encryptedId: string }) =>
    wrap(async () => {
      const cached = await lyricsCache.get(payload.encryptedId);
      if (cached) return cached;
      const raw = await service.getLyrics(payload.encryptedId);
      const lines = parseLrc(raw);
      await lyricsCache.set(payload.encryptedId, lines);
      return lines;
    }, service),
  );
  channels.push(IPC.MUSIC_GET_LYRICS);

  // ── UI 直连：收藏切换 ──────────────────────────────────────
  ipcMain.handle(IPC.MUSIC_TOGGLE_FAVORITE, (_e, payload: { encryptedId: string; favorite: boolean }) =>
    wrap(async () => {
      return service.toggleFavorite(payload.encryptedId, payload.favorite);
    }, service),
  );
  channels.push(IPC.MUSIC_TOGGLE_FAVORITE);

  // ── 状态变更推送：任何 state 轴变化都广播到所有窗口 ──────────
  const unsubState = service.onStateChange((snapshot) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC.MUSIC_STATE_CHANGED, snapshot);
    }
  });
  // Playback state 推送：mpv 状态变化时广播到所有窗口
  const unsubPlayback = service.onPlaybackStateChange((playback) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC.MUSIC_PLAYBACK_STATE, playback);
    }
  });

  return function dispose() {
    for (const ch of channels) ipcMain.removeHandler(ch);
    unsubState();
    unsubPlayback();
  };
}
