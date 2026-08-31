import { ipcMain, BrowserWindow, dialog } from "electron";
import { IPC } from "../../shared/ipc-channels";
import { MusicInputError, type MusicBackendState, type MusicAccountState, type MusicPlayerState } from "./types";
import type { MusicService } from "./music-service";
import { sanitizeLogLine } from "./log-sanitizer";
import { parseLrc, mergeTranslation } from "./lyrics-parser";
import { LyricsCache } from "./lyrics-cache";
import { QQ_MUSIC_APP_ID, SmtcController, SmtcError, type SmtcCommand } from "./smtc-controller";
import { detectQQMusic } from "./qqmusic-detector";

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

export function registerMusicIpcHandlers(
  service: MusicService,
  // 注入点：测试里塞假的 controller，不去碰真的 SMTC。
  smtc: SmtcController = new SmtcController(),
): () => void {
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

  // ── QQ 音乐（外部播放器 / SMTC）────────────────────────────
  // 不走 wrap()：这条链路与 MusicService 后端就绪状态完全无关，
  // 网易云没配置好的时候 QQ 音乐照样该能用。
  ipcMain.handle(IPC.MUSIC_QQ_DETECT, async () => {
    try {
      return { ok: true as const, data: await detectQQMusic(smtc) };
    } catch (err: unknown) {
      console.error("[music] qq detect failed", sanitizeLogLine(String(err)));
      return { ok: false as const, errorCode: "E_INTERNAL_ERROR" };
    }
  });
  channels.push(IPC.MUSIC_QQ_DETECT);

  ipcMain.handle(IPC.MUSIC_QQ_CONTROL, async (_e, command: string) => {
    const allowed: SmtcCommand[] = ["next", "prev", "play", "pause", "toggle"];
    if (!allowed.includes(command as SmtcCommand)) {
      return { ok: false as const, errorCode: "E_INVALID_COMMAND" };
    }
    try {
      await smtc.control(command as SmtcCommand, QQ_MUSIC_APP_ID);
      return { ok: true as const, data: { applied: command } };
    } catch (err: unknown) {
      // SmtcError 的 code 是给 UI 分型用的（没装 helper / 播放器没开 / 被拒）
      const code = err instanceof SmtcError ? err.code : "E_INTERNAL_ERROR";
      if (code === "E_INTERNAL_ERROR") console.error("[music] qq control failed", sanitizeLogLine(String(err)));
      return { ok: false as const, errorCode: code };
    }
  });
  channels.push(IPC.MUSIC_QQ_CONTROL);

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

  ipcMain.handle(IPC.MUSIC_GET_PLAYBACK_SESSION, () =>
    wrap(async () => service.getPlaybackSession(), service),
  );
  channels.push(IPC.MUSIC_GET_PLAYBACK_SESSION);

  ipcMain.handle(IPC.MUSIC_PLAY_SESSION_TRACK, (_e, payload) =>
    wrap(() => service.playSessionTrack(payload), service),
  );
  channels.push(IPC.MUSIC_PLAY_SESSION_TRACK);

  ipcMain.handle(IPC.MUSIC_SYNC_PLAYBACK_SESSION, (_e, payload) =>
    wrap(async () => service.syncPlaybackSession(payload), service),
  );
  channels.push(IPC.MUSIC_SYNC_PLAYBACK_SESSION);

  // ── UI 直连：歌词（不经 AI 工具层） ─────────────────────────
  const lyricsCache = new LyricsCache(service.getLyricsCacheDir());
  ipcMain.handle(IPC.MUSIC_GET_LYRICS, (_e, payload: { encryptedId: string }) =>
    wrap(async () => {
      const cached = await lyricsCache.get(payload.encryptedId);
      if (cached) return cached;
      const { lrc, transLrc } = await service.getLyrics(payload.encryptedId);
      // 原文优先带时间戳 LRC；无 LRC 时不做纯文本 fallback（无时间轴无法滚动）
      const lines = mergeTranslation(parseLrc(lrc), transLrc);
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

  // ── 本地缓存歌单（边播边存 + 用户导入） ─────────────────────
  ipcMain.handle(IPC.MUSIC_GET_CACHED_TRACKS, () =>
    wrap(() => service.getCachedTracks(), service),
  );
  channels.push(IPC.MUSIC_GET_CACHED_TRACKS);

  ipcMain.handle(IPC.MUSIC_REMOVE_CACHED_TRACK, (_e, trackId: string) =>
    wrap(() => service.removeCachedTrack(trackId), service),
  );
  channels.push(IPC.MUSIC_REMOVE_CACHED_TRACK);

  // 主进程弹系统文件选择框（多选，限音频格式）→ 导入缓存池
  ipcMain.handle(IPC.MUSIC_IMPORT_LOCAL_TRACKS, () =>
    wrap(async () => {
      const picked = await dialog.showOpenDialog({
        title: "导入本地音乐",
        properties: ["openFile", "multiSelections"],
        filters: [{ name: "音频文件", extensions: ["mp3", "flac", "wav", "ogg", "m4a", "aac"] }],
      });
      if (picked.canceled || picked.filePaths.length === 0) {
        return { imported: 0, skipped: 0, cancelled: true };
      }
      const result = await service.importLocalFiles(picked.filePaths);
      return { ...result, cancelled: false };
    }, service),
  );
  channels.push(IPC.MUSIC_IMPORT_LOCAL_TRACKS);

  // 选一个文件夹递归导入。和上面按文件选是两个入口——Windows 的文件框
  // 没法同时选文件和目录，硬合成一个只会让两边都难用。
  ipcMain.handle(IPC.MUSIC_IMPORT_LOCAL_FOLDER, () =>
    wrap(async () => {
      const picked = await dialog.showOpenDialog({
        title: "导入本地音乐文件夹",
        properties: ["openDirectory"],
      });
      if (picked.canceled || picked.filePaths.length === 0) {
        return { imported: 0, skipped: 0, truncated: false, cancelled: true };
      }
      const result = await service.importLocalFolder(picked.filePaths[0]);
      return { ...result, cancelled: false };
    }, service),
  );
  channels.push(IPC.MUSIC_IMPORT_LOCAL_FOLDER);

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
  const unsubPlaybackSession = service.onPlaybackSessionChange((session) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC.MUSIC_PLAYBACK_SESSION_CHANGED, session);
    }
  });
  // 缓存索引变化（下载完成/删除/导入）→ 广播，渲染进程刷新缓存歌单
  const unsubCache = service.onCacheUpdated(() => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC.MUSIC_CACHE_UPDATED);
    }
  });

  return function dispose() {
    for (const ch of channels) ipcMain.removeHandler(ch);
    unsubState();
    unsubPlayback();
    unsubPlaybackSession();
    unsubCache();
  };
}
