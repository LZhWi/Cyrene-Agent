// ============================================================
// 对接契约：UI 组件只消费这些类型，播放逻辑由 mpv 后端实现
// ============================================================

export interface LyricLine {
  timeMs: number;
  text: string;
}

export interface Track {
  encryptedId: string;
  originalId: string;
  name: string;
  artists: string[];
  album?: string;
  coverImgUrl?: string;
  durationMs?: number;
  visible: boolean;
  isFavorite?: boolean;
  lyrics?: LyricLine[];
}

export interface Playlist {
  originalId: string;
  name: string;
  coverImgUrl?: string;
  trackCount: number;
  tracks: Track[];
}

export type RepeatMode = "off" | "all" | "one";

export interface PlaybackState {
  currentTrack: Track | null;
  isPlaying: boolean;
  positionMs: number;
  durationMs: number;
  volume: number;
  isMuted: boolean;
  queue: Track[];
  queueIndex: number;
  repeatMode: RepeatMode;
  isShuffled: boolean;
  isLoading: boolean;
  error?: string;
}

export interface PlaybackActions {
  playTrack(track: Track): void;
  togglePlayPause(): void;
  next(): void;
  prev(): void;
  seek(positionMs: number): void;
  setVolume(volume: number): void;
  toggleMute(): void;
  addToQueue(track: Track): void;
  removeFromQueue(index: number): void;
  loadPlaylist(playlist: Playlist): void;
  toggleRepeat(): void;
  toggleShuffle(): void;
  toggleFavorite(track: Track): void;
}

export interface MusicPlayerProps {
  state: PlaybackState;
  actions: PlaybackActions;
  /** 用户歌单列表，顶部 chips + 侧栏下拉共用 */
  playlists: Playlist[];
  activePlaylistId: string;
  onSelectPlaylist(playlist: Playlist): void;
  /** 搜索：query 变化时调 onSearch，结果通过 searchResults 回传 */
  searchResults: Track[];
  isSearching: boolean;
  onSearch(query: string): void;
  className?: string;
  variant?: "full" | "mini" | "bar";
}

export function formatTime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  if (h > 0) return `${h}:${mm}:${ss}`;
  return `${mm}:${ss}`;
}
