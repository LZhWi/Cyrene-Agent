import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import MusicPlayer from "./components/MusicPlayer";
import { MOCK_PLAYLISTS, searchMockTracks } from "./mock";
import type { PlaybackActions, PlaybackState, Playlist, Track } from "./types";

/**
 * Demo 外壳：用本地状态 + 定时器模拟 mpv 后端的 PlaybackState/PlaybackActions。
 * 施工接入时，这里的实现会被真实的 mpv IPC 订阅/命令替换，MusicPlayer 不用改。
 */
export default function App() {
  const [playlists] = useState<Playlist[]>(MOCK_PLAYLISTS);
  const [activePlaylistId, setActivePlaylistId] = useState(
    MOCK_PLAYLISTS[0].originalId,
  );
  const initialQueue = useMemo(
    () => MOCK_PLAYLISTS[0].tracks.map((t) => ({ ...t })),
    [],
  );

  const [state, setState] = useState<PlaybackState>({
    currentTrack: initialQueue[0] ?? null,
    isPlaying: false,
    positionMs: 0,
    durationMs: initialQueue[0]?.durationMs ?? 0,
    volume: 65,
    isMuted: false,
    queue: initialQueue,
    queueIndex: 0,
    repeatMode: "off",
    isShuffled: false,
    isLoading: false,
  });

  const [searchResults, setSearchResults] = useState<Track[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const searchTimer = useRef<number | null>(null);
  const loadTimer = useRef<number | null>(null);

  const patch = useCallback((p: Partial<PlaybackState>) => {
    setState((s) => ({ ...s, ...p }));
  }, []);

  const startTrack = useCallback(
    (track: Track, index: number) => {
      if (loadTimer.current) window.clearTimeout(loadTimer.current);
      patch({ isLoading: true, error: undefined });
      loadTimer.current = window.setTimeout(() => {
        patch({
          currentTrack: track,
          queueIndex: index,
          durationMs: track.durationMs ?? 0,
          positionMs: 0,
          isPlaying: true,
          isLoading: false,
        });
      }, 450);
    },
    [patch],
  );

  // 模拟播放进度推进
  useEffect(() => {
    if (!state.isPlaying || state.isLoading) return;
    const timer = window.setInterval(() => {
      setState((s) => {
        if (!s.isPlaying || !s.currentTrack) return s;
        const next = s.positionMs + 250;
        if (next < s.durationMs) return { ...s, positionMs: next };
        if (s.repeatMode === "one") return { ...s, positionMs: 0 };
        const atEnd = s.queueIndex >= s.queue.length - 1;
        if (s.repeatMode === "off" && atEnd) {
          return { ...s, positionMs: s.durationMs, isPlaying: false };
        }
        let ni: number;
        if (s.isShuffled && s.queue.length > 1) {
          do {
            ni = Math.floor(Math.random() * s.queue.length);
          } while (ni === s.queueIndex);
        } else {
          ni = atEnd ? 0 : s.queueIndex + 1;
        }
        const nt = s.queue[ni];
        return {
          ...s,
          queueIndex: ni,
          currentTrack: nt,
          durationMs: nt?.durationMs ?? 0,
          positionMs: 0,
        };
      });
    }, 250);
    return () => window.clearInterval(timer);
  }, [state.isPlaying, state.isLoading]);

  const handleSearch = useCallback((query: string) => {
    if (searchTimer.current) window.clearTimeout(searchTimer.current);
    if (!query.trim()) {
      setSearchResults([]);
      setIsSearching(false);
      return;
    }
    setIsSearching(true);
    // 模拟后端搜索延迟；接入时替换为 IPC 搜索请求
    searchTimer.current = window.setTimeout(() => {
      setSearchResults(searchMockTracks(query));
      setIsSearching(false);
    }, 300);
  }, []);

  const handleSelectPlaylist = useCallback(
    (playlist: Playlist) => {
      setActivePlaylistId(playlist.originalId);
      const tracks = playlist.tracks.map((t) => ({ ...t }));
      setState((s) => ({
        ...s,
        queue: tracks,
        queueIndex: 0,
        currentTrack: s.currentTrack ?? tracks[0] ?? null,
        durationMs: s.currentTrack
          ? s.durationMs
          : (tracks[0]?.durationMs ?? 0),
        error: undefined,
      }));
    },
    [],
  );

  const actions: PlaybackActions = useMemo(
    () => ({
      playTrack(track) {
        if (!track.visible) {
          patch({ error: `「${track.name}」暂时无法播放` });
          return;
        }
        const idx = state.queue.findIndex(
          (t) => t.originalId === track.originalId,
        );
        if (idx >= 0) {
          startTrack(state.queue[idx], idx);
        } else {
          // 搜索结果点歌：加入队列尾部并播放
          const queue = [...state.queue, { ...track }];
          setState((s) => ({ ...s, queue }));
          startTrack(track, queue.length - 1);
        }
      },
      togglePlayPause() {
        if (!state.currentTrack) return;
        patch({ isPlaying: !state.isPlaying });
      },
      next() {
        const { queue, queueIndex, isShuffled } = state;
        if (queue.length === 0) return;
        let ni: number;
        if (isShuffled && queue.length > 1) {
          do {
            ni = Math.floor(Math.random() * queue.length);
          } while (ni === queueIndex);
        } else {
          ni = (queueIndex + 1) % queue.length;
        }
        startTrack(queue[ni], ni);
      },
      prev() {
        const { queue, queueIndex, positionMs } = state;
        if (queue.length === 0) return;
        if (positionMs > 3000) {
          patch({ positionMs: 0 });
          return;
        }
        const ni = (queueIndex - 1 + queue.length) % queue.length;
        startTrack(queue[ni], ni);
      },
      seek(positionMs) {
        patch({
          positionMs: Math.max(0, Math.min(positionMs, state.durationMs)),
        });
      },
      setVolume(volume) {
        patch({
          volume: Math.max(0, Math.min(100, Math.round(volume))),
          isMuted: false,
        });
      },
      toggleMute() {
        patch({ isMuted: !state.isMuted });
      },
      addToQueue(track) {
        setState((s) =>
          s.queue.some((t) => t.originalId === track.originalId)
            ? s
            : { ...s, queue: [...s.queue, { ...track }] },
        );
      },
      removeFromQueue(index) {
        setState((s) => {
          const queue = s.queue.filter((_, i) => i !== index);
          let queueIndex = s.queueIndex;
          if (index < s.queueIndex) queueIndex -= 1;
          if (index === s.queueIndex) {
            return {
              ...s,
              queue,
              queueIndex: Math.min(queueIndex, queue.length - 1),
              currentTrack:
                queue[Math.min(queueIndex, queue.length - 1)] ?? null,
              isPlaying: false,
              positionMs: 0,
            };
          }
          return { ...s, queue, queueIndex };
        });
      },
      loadPlaylist(playlist) {
        handleSelectPlaylist(playlist);
      },
      toggleRepeat() {
        const order = ["off", "all", "one"] as const;
        const next =
          order[(order.indexOf(state.repeatMode) + 1) % order.length];
        patch({ repeatMode: next });
      },
      toggleShuffle() {
        patch({ isShuffled: !state.isShuffled });
      },
      toggleFavorite(track) {
        setState((s) => ({
          ...s,
          queue: s.queue.map((t) =>
            t.originalId === track.originalId
              ? { ...t, isFavorite: !t.isFavorite }
              : t,
          ),
          currentTrack:
            s.currentTrack?.originalId === track.originalId
              ? { ...s.currentTrack, isFavorite: !s.currentTrack.isFavorite }
              : s.currentTrack,
        }));
      },
    }),
    [state, patch, startTrack, handleSelectPlaylist],
  );

  return (
    <div className="demo-shell">
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
