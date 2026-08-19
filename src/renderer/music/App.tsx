import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Minus, X } from "lucide-react";
import MusicPlayer from "./components/MusicPlayer";
import LoadingScreen from "./components/LoadingScreen";
import type { PlaybackState as MpvPlaybackState } from "../../shared/music-types";
import type {
  Playlist,
  PlaybackActions,
  PlaybackState,
  RepeatMode,
  Track,
} from "./types";

// ── window.music API 形状（与 preload/music.ts 对齐，局部声明避免跨层 import）──
interface MusicIpcResult<T> {
  ok: boolean;
  data?: T;
  errorCode?: string;
}
interface MusicApi {
  getStatus: () => Promise<MusicIpcResult<unknown>>;
  getMyPlaylists: () => Promise<MusicIpcResult<unknown>>;
  getPlaylistDetail: (playlistId: string) => Promise<MusicIpcResult<unknown>>;
  search: (keyword: string, limit?: number) => Promise<MusicIpcResult<unknown>>;
  playTrack: (encryptedId: string) => Promise<MusicIpcResult<unknown>>;
  playbackToggle: () => Promise<MusicIpcResult<unknown>>;
  playbackSeek: (seconds: number) => Promise<MusicIpcResult<unknown>>;
  playbackVolume: (vol: number) => Promise<MusicIpcResult<unknown>>;
  getLyrics: (encryptedId: string) => Promise<MusicIpcResult<unknown>>;
  toggleFavorite: (encryptedId: string, favorite: boolean) => Promise<MusicIpcResult<unknown>>;
  minimizeWindow: () => void;
  closeWindow: () => void;
  openSettings: (section?: string) => Promise<unknown>;
  onPlaybackState: (h: (s: unknown) => void) => (() => void) | void;
  onStateChanged: (h: (s: unknown) => void) => (() => void) | void;
}

// 后端返回类型（与 src/main/music/types.ts 的 MusicPlaylist/MusicTrack 对齐）
interface BackendTrack {
  id: string;
  encryptedId?: string;
  originalId?: number;
  name: string;
  artists?: string[];
  album?: string;
  durationMs?: number;
  coverUrl?: string;
}
interface BackendPlaylist {
  id: string;
  originalId?: number | string;
  name: string;
  coverUrl?: string;
  trackCount: number;
  tracks?: BackendTrack[];
}

function normalizeTrack(t: BackendTrack): Track {
  return {
    encryptedId: t.encryptedId ?? t.id,
    originalId: String(t.originalId ?? t.id),
    name: t.name,
    artists: t.artists ?? [],
    album: t.album,
    coverImgUrl: t.coverUrl,
    durationMs: t.durationMs,
    visible: true,
  };
}

function normalizePlaylist(p: BackendPlaylist): Playlist {
  return {
    id: p.id,
    originalId: String(p.originalId ?? ""),
    name: p.name,
    coverImgUrl: p.coverUrl,
    trackCount: p.trackCount,
    tracks: [],
  };
}

function getMusicApi(): MusicApi | null {
  const w = window as unknown as { music?: MusicApi };
  return w.music ?? null;
}

const INITIAL_STATE: PlaybackState = {
  currentTrack: null,
  isPlaying: false,
  positionMs: 0,
  durationMs: 0,
  volume: 70,
  isMuted: false,
  queue: [],
  queueIndex: -1,
  repeatMode: "off",
  isShuffled: false,
  isLoading: false,
};

const REPEAT_ORDER: RepeatMode[] = ["off", "all", "one"];
const LS_KEY = "cyrene:music:playback-mode";

interface PersistedMode {
  repeatMode: RepeatMode;
  isShuffled: boolean;
}

function loadPersistedMode(): Partial<Pick<PlaybackState, "repeatMode" | "isShuffled">> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<PersistedMode>;
    const out: Partial<Pick<PlaybackState, "repeatMode" | "isShuffled">> = {};
    if (parsed?.repeatMode && REPEAT_ORDER.includes(parsed.repeatMode)) {
      out.repeatMode = parsed.repeatMode;
    }
    if (typeof parsed?.isShuffled === "boolean") {
      out.isShuffled = parsed.isShuffled;
    }
    return out;
  } catch {
    return {};
  }
}

function savePersistedMode(mode: PersistedMode): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(mode));
  } catch {
    /* localStorage 不可用时静默忽略 */
  }
}

export function App() {
  const persisted = useMemo(loadPersistedMode, []);
  const [state, setState] = useState<PlaybackState>({ ...INITIAL_STATE, ...persisted });
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [activePlaylistId, setActivePlaylistId] = useState("");
  const [searchResults, setSearchResults] = useState<Track[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [loginReady, setLoginReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const searchTimer = useRef<number | null>(null);
  // 记住静音前的音量，用于取消静音时恢复
  const volumeBeforeMute = useRef<number>(70);
  // 换歌 loading 超时兜底（mpv 没在 3s 内回 duration 就强制解锁）
  const loadingTimer = useRef<number | null>(null);

  const api = getMusicApi();

  const patch = useCallback((p: Partial<PlaybackState>) => {
    setState((s) => ({ ...s, ...p }));
  }, []);

  // ── 启动探测：搜索请求 + 3秒最低等待 ──────────────────────
  useEffect(() => {
    if (!api) {
      // 没有 preload API（浏览器预览等）→ 直接跳过 loading
      setLoading(false);
      return;
    }
    let cancelled = false;
    const MIN_WAIT = 4000;
    const timer = new Promise((r) => window.setTimeout(r, MIN_WAIT));
    // 用一次轻量搜索探测网易云连接是否正常
    const probe = api.search("test", 1).then(
      () => true,
      () => false,
    );
    Promise.all([timer, probe]).then(([, ok]) => {
      if (cancelled) return;
      if (ok) {
        setLoading(false);
      } else {
        // 探测失败 → 打开设置页网易云配置 + 关闭播放器窗口
        void api.openSettings("music");
        api.closeWindow();
      }
    });
    return () => {
      cancelled = true;
    };
  }, [api]);

  // ── 订阅 mpv 播放状态推送 ──────────────────────────────────
  useEffect(() => {
    if (!api) return;
    const unsub = api.onPlaybackState?.((raw) => {
      const mpv = raw as Partial<MpvPlaybackState>;
      setState((s) => {
        const next: Partial<PlaybackState> = {};
        if (typeof mpv.position === "number") next.positionMs = Math.round(mpv.position * 1000);
        if (typeof mpv.duration === "number") {
          next.durationMs = Math.round(mpv.duration * 1000);
          // 收到 duration → 换歌 loading 结束
          if (mpv.duration > 0 && s.isLoading) {
            next.isLoading = false;
            if (loadingTimer.current) {
              window.clearTimeout(loadingTimer.current);
              loadingTimer.current = null;
            }
          }
        }
        if (typeof mpv.volume === "number") {
          next.volume = Math.round(mpv.volume);
          if (mpv.volume > 0) next.isMuted = false;
        }
        if (typeof mpv.paused === "boolean") next.isPlaying = !mpv.paused;
        // track 变化 → 同步 currentTrack（优先用本地 queue 里的完整信息）
        if (mpv.track && typeof mpv.track.encryptedId === "string") {
          const inQueue = s.queue.find((t) => t.encryptedId === mpv.track!.encryptedId);
          if (inQueue) {
            next.currentTrack = inQueue;
            const idx = s.queue.indexOf(inQueue);
            if (idx >= 0) next.queueIndex = idx;
          } else if (s.currentTrack?.encryptedId !== mpv.track.encryptedId) {
            // 不在 queue（比如 AI 工具直接播的）→ 构造最小 Track
            next.currentTrack = {
              encryptedId: mpv.track.encryptedId,
              originalId: mpv.track.encryptedId,
              name: mpv.track.name ?? "未知歌曲",
              artists: mpv.track.artists ?? [],
              coverImgUrl: mpv.track.coverUrl,
              visible: true,
            };
          }
        } else if (mpv.loaded === false && s.currentTrack) {
          // 停止播放
          next.currentTrack = null;
          next.queueIndex = -1;
          next.isPlaying = false;
          next.positionMs = 0;
        }
        return { ...s, ...next };
      });
    });
    return () => {
      if (typeof unsub === "function") unsub();
    };
  }, [api]);

  // ── 订阅 music 状态（检测登录态） ──────────────────────────
  useEffect(() => {
    if (!api) return;
    const checkLogin = async () => {
      try {
        const r = await api.getStatus();
        const snap = r.data as { account?: string; backend?: string };
        if (snap?.account === "signed_in") {
          setLoginReady(true);
          loadPlaylists();
        } else {
          setLoginReady(false);
        }
      } catch {
        /* ignore */
      }
    };
    void checkLogin();
    const unsub = api.onStateChanged?.((raw) => {
      const snap = raw as { account?: string };
      if (snap?.account === "signed_in") {
        setLoginReady(true);
        if (playlists.length === 0) void loadPlaylists();
      } else {
        setLoginReady(false);
      }
    });
    return () => {
      if (typeof unsub === "function") unsub();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  // ── 拉取用户歌单 ──────────────────────────────────────────
  const loadPlaylists = useCallback(async () => {
    if (!api) return;
    try {
      const r = await api.getMyPlaylists();
      if (r.ok && r.data) {
        const pls = (r.data as BackendPlaylist[]).map(normalizePlaylist);
        setPlaylists(pls);
        if (pls.length > 0 && !activePlaylistId) {
          setActivePlaylistId(pls[0].originalId);
          // 自动加载第一个歌单的 tracks 作为初始 queue
          void loadPlaylistTracks(pls[0]);
        }
      }
    } catch (err) {
      console.warn("[music] getMyPlaylists failed", err);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, activePlaylistId]);

  const loadPlaylistTracks = useCallback(
    async (playlist: Playlist) => {
      if (!api) return;
      try {
        const r = await api.getPlaylistDetail(playlist.originalId);
        if (r.ok && r.data) {
          const detail = r.data as BackendPlaylist;
          const tracks = (detail.tracks ?? []).map(normalizeTrack);
          setState((s) => ({
            ...s,
            queue: tracks,
            queueIndex: tracks.length > 0 ? 0 : -1,
            currentTrack: tracks[0] ?? null,
            durationMs: tracks[0]?.durationMs ?? 0,
            positionMs: 0,
            isPlaying: false,
            error: undefined,
          }));
        }
      } catch (err) {
        console.warn("[music] getPlaylistDetail failed", err);
      }
    },
    [api],
  );

  // ── 播放指定歌曲（本地 queue 管理 + IPC 派发） ──────────────
  const playTrack = useCallback(
    (track: Track) => {
      if (!track.visible) {
        patch({ error: `「${track.name}」暂时无法播放` });
        return;
      }
      if (!api) {
        patch({ error: "音乐服务未就绪" });
        return;
      }
      // 换歌 loading：等 mpv 回 duration（或 3s 超时兜底）
      if (loadingTimer.current) window.clearTimeout(loadingTimer.current);
      patch({ isLoading: true, error: undefined, positionMs: 0 });
      loadingTimer.current = window.setTimeout(() => {
        patch({ isLoading: false });
        loadingTimer.current = null;
      }, 3000);

      setState((s) => {
        const idx = s.queue.findIndex((t) => t.encryptedId === track.encryptedId);
        if (idx >= 0) {
          return { ...s, currentTrack: s.queue[idx], queueIndex: idx, durationMs: s.queue[idx].durationMs ?? 0 };
        }
        // 不在 queue → 追加队尾
        const queue = [...s.queue, { ...track }];
        return { ...s, queue, currentTrack: track, queueIndex: queue.length - 1, durationMs: track.durationMs ?? 0 };
      });

      void api.playTrack(track.encryptedId).catch((err) => {
        patch({ isLoading: false, error: "播放失败：" + (err instanceof Error ? err.message : String(err)) });
      });

      // 异步补歌词
      void api.getLyrics(track.encryptedId).then((r) => {
        if (r.ok && r.data) {
          const lyrics = r.data as { timeMs: number; text: string }[];
          setState((s) => ({
            ...s,
            currentTrack: s.currentTrack ? { ...s.currentTrack, lyrics } : s.currentTrack,
            queue: s.queue.map((t) =>
              t.encryptedId === track.encryptedId ? { ...t, lyrics } : t,
            ),
          }));
        }
      }).catch(() => { /* 歌词可选，失败不提示 */ });
    },
    [api, patch],
  );

  // ── 计算下一首/上一首索引 ──────────────────────────────────
  const computeNextIndex = useCallback((s: PlaybackState): number => {
    if (s.queue.length === 0) return -1;
    if (s.isShuffled && s.queue.length > 1) {
      let ni: number;
      do {
        ni = Math.floor(Math.random() * s.queue.length);
      } while (ni === s.queueIndex);
      return ni;
    }
    const atEnd = s.queueIndex >= s.queue.length - 1;
    if (atEnd) return s.repeatMode === "all" ? 0 : -1;
    return s.queueIndex + 1;
  }, []);

  const computePrevIndex = useCallback((s: PlaybackState): number => {
    if (s.queue.length === 0) return -1;
    if (s.queueIndex <= 0) return s.repeatMode === "all" ? s.queue.length - 1 : 0;
    return s.queueIndex - 1;
  }, []);

  // ── actions（MusicPlayer 组件消费） ──────────────────────────
  const actions: PlaybackActions = useMemo(
    () => ({
      playTrack,
      togglePlayPause() {
        if (!api || !state.currentTrack) return;
        void api.playbackToggle().catch(() => { /* ignore */ });
      },
      next() {
        const ni = computeNextIndex(state);
        if (ni < 0) return;
        const t = state.queue[ni];
        if (t) playTrack(t);
      },
      prev() {
        if (state.positionMs > 3000) {
          if (api) void api.playbackSeek(0).catch(() => { /* ignore */ });
          patch({ positionMs: 0 });
          return;
        }
        const ni = computePrevIndex(state);
        if (ni < 0) return;
        const t = state.queue[ni];
        if (t) playTrack(t);
      },
      seek(positionMs) {
        const clamped = Math.max(0, Math.min(positionMs, state.durationMs));
        patch({ positionMs: clamped });
        if (api) void api.playbackSeek(Math.round(clamped / 1000)).catch(() => { /* ignore */ });
      },
      setVolume(volume) {
        const clamped = Math.max(0, Math.min(100, Math.round(volume)));
        patch({ volume: clamped, isMuted: clamped === 0 });
        if (api) void api.playbackVolume(clamped).catch(() => { /* ignore */ });
      },
      toggleMute() {
        if (state.isMuted) {
          patch({ isMuted: false, volume: volumeBeforeMute.current || 70 });
          if (api) void api.playbackVolume(volumeBeforeMute.current || 70).catch(() => { /* ignore */ });
        } else {
          volumeBeforeMute.current = state.volume;
          patch({ isMuted: true });
          if (api) void api.playbackVolume(0).catch(() => { /* ignore */ });
        }
      },
      addToQueue(track) {
        setState((s) =>
          s.queue.some((t) => t.encryptedId === track.encryptedId)
            ? s
            : { ...s, queue: [...s.queue, { ...track }] },
        );
      },
      removeFromQueue(index) {
        setState((s) => {
          const queue = s.queue.filter((_, i) => i !== index);
          let queueIndex = s.queueIndex;
          let currentTrack = s.currentTrack;
          let isPlaying = s.isPlaying;
          let positionMs = s.positionMs;
          if (index < s.queueIndex) queueIndex -= 1;
          if (index === s.queueIndex) {
            // 删的是当前播放项 → 停止播放
            currentTrack = null;
            isPlaying = false;
            positionMs = 0;
            queueIndex = Math.min(queueIndex, queue.length - 1);
          }
          return { ...s, queue, queueIndex, currentTrack, isPlaying, positionMs };
        });
      },
      loadPlaylist(playlist) {
        setActivePlaylistId(playlist.originalId);
        void loadPlaylistTracks(playlist);
      },
      toggleRepeat() {
        const next = REPEAT_ORDER[(REPEAT_ORDER.indexOf(state.repeatMode) + 1) % REPEAT_ORDER.length];
        patch({ repeatMode: next });
        savePersistedMode({ repeatMode: next, isShuffled: state.isShuffled });
      },
      toggleShuffle() {
        const next = !state.isShuffled;
        patch({ isShuffled: next });
        savePersistedMode({ repeatMode: state.repeatMode, isShuffled: next });
      },
      toggleFavorite(track) {
        if (!api) return;
        const newFav = !track.isFavorite;
        setState((s) => ({
          ...s,
          queue: s.queue.map((t) =>
            t.encryptedId === track.encryptedId ? { ...t, isFavorite: newFav } : t,
          ),
          currentTrack:
            s.currentTrack?.encryptedId === track.encryptedId
              ? { ...s.currentTrack, isFavorite: newFav }
              : s.currentTrack,
        }));
        void api.toggleFavorite(track.encryptedId, newFav).catch(() => { /* ignore */ });
      },
    }),
    [api, state, patch, playTrack, computeNextIndex, computePrevIndex, loadPlaylistTracks],
  );

  // ── 搜索（250ms 防抖） ──────────────────────────────────────
  const handleSearch = useCallback((query: string) => {
    if (searchTimer.current) window.clearTimeout(searchTimer.current);
    if (!query.trim()) {
      setSearchResults([]);
      setIsSearching(false);
      return;
    }
    setIsSearching(true);
    searchTimer.current = window.setTimeout(async () => {
      if (!api) return;
      try {
        const r = await api.search(query, 20);
        if (r.ok && r.data) {
          const data = r.data as { tracks?: BackendTrack[] };
          setSearchResults((data.tracks ?? []).map(normalizeTrack));
        } else {
          setSearchResults([]);
        }
      } catch (err) {
        console.warn("[music] search failed", err);
        setSearchResults([]);
      } finally {
        setIsSearching(false);
      }
    }, 250);
  }, [api]);

  const handleSelectPlaylist = useCallback((playlist: Playlist) => {
    actions.loadPlaylist(playlist);
  }, [actions]);

  // ── 窗口控制（无框窗口，通过 preload 暴露的 IPC 派发） ────
  const minimizeWindow = useCallback(() => {
    api?.minimizeWindow();
  }, [api]);

  const closeWindow = useCallback(() => {
    api?.closeWindow();
  }, [api]);

  // ── loading 阶段：只显示加载动画，无窗口按钮 ─────────────
  if (loading) {
    return <LoadingScreen />;
  }

  if (!loginReady) {
    return (
      <div className="mp-shell">
        <div className="mp-window-chrome">
          <button type="button" className="win-btn" onClick={minimizeWindow} title="最小化"><Minus size={14} /></button>
          <button type="button" className="win-btn win-btn--close" onClick={closeWindow} title="关闭"><X size={14} /></button>
        </div>
        <div className="mp-not-ready">
          <p>音乐服务未就绪</p>
          <p className="mp-not-ready-hint">请先在「设置 → 音乐」中扫码登录网易云</p>
        </div>
      </div>
    );
  }

  return (
    <div className="mp-shell">
      <div className="mp-window-chrome">
        <button type="button" className="win-btn" onClick={minimizeWindow} title="最小化"><Minus size={14} /></button>
        <button type="button" className="win-btn" onClick={closeWindow} title="关闭"><X size={14} /></button>
      </div>
      <MusicPlayer
        state={state}
        actions={actions}
        playlists={playlists}
        activePlaylistId={activePlaylistId}
        onSelectPlaylist={handleSelectPlaylist}
        searchResults={searchResults}
        isSearching={isSearching}
        onSearch={handleSearch}
      />
    </div>
  );
}

export default App;
