import { MusicInputError, type MusicTrack, type MusicPlaylist, type MusicPlaylistDetail, type MusicSubscription } from "./types";

interface UpstreamSong {
  id: string | number;
  name: string;
  artist?: string | string[];
  artists?: string | string[];
  album?: string;
  duration?: number;
  durationMs?: number;
  picUrl?: string;
  coverUrl?: string;
}

interface UpstreamPlaylist {
  id: string | number;
  name: string;
  count?: number;
  trackCount?: number;
  creator?: string;
  coverUrl?: string;
}

const MAX_TRACKS = 30;

// cloud-music-mcp 有时会直接返回自然语言文本而不是 JSON。
// 这里提供轻量级文本降级解析，保证歌单名/歌曲名/收藏名至少能进入 SOUL 投影。
function splitNameList(text: string): string[] {
  const afterColon = text.replace(/^[^：:]*[：:]\s*/, "");
  return afterColon
    .split(/[,，、;；\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function tryParseTextPlaylists(text: string): MusicPlaylist[] {
  return splitNameList(text).map((name) => ({ id: "", name, trackCount: 0 }));
}

function tryParseTextTracks(text: string): MusicTrack[] {
  return splitNameList(text).map((raw) => {
    const parts = raw.split(/\s*[-–—]\s*/);
    return {
      id: "",
      name: parts[0] ?? raw,
      artists: parts[1] ? [parts[1]] : [],
      album: undefined,
    };
  });
}

function tryParseTextSubscriptions(text: string): MusicSubscription[] {
  return splitNameList(text).map((name) => ({ id: "", name }));
}

function artistsOf(s: UpstreamSong): string[] {
  if (Array.isArray(s.artists)) return s.artists;
  if (typeof s.artists === "string") return [s.artists];
  if (Array.isArray(s.artist)) return s.artist;
  if (typeof s.artist === "string") return [s.artist];
  return [];
}

function toTrack(s: UpstreamSong): MusicTrack {
  return {
    id: String(s.id),
    name: s.name,
    artists: artistsOf(s),
    album: s.album,
    durationMs: s.durationMs ?? s.duration,
    coverUrl: s.coverUrl ?? s.picUrl,
  };
}

function toPlaylist(pl: UpstreamPlaylist): MusicPlaylist {
  return {
    id: String(pl.id),
    name: pl.name,
    coverUrl: pl.coverUrl,
    trackCount: pl.count ?? pl.trackCount ?? 0,
    creator: pl.creator,
  };
}

function assertSuccess(payload: unknown, fallbackCode: string): Record<string, unknown> {
  const p = payload as { success?: boolean; error?: unknown };
  if (!p || typeof p !== "object") {
    console.log(`[MusicNormalizer/Trace] assertSuccess failed fallback=${fallbackCode} payload=`, JSON.stringify(payload).slice(0, 2000));
    throw new MusicInputError(fallbackCode);
  }
  if (!p.success) {
    const error = p.error;
    const code = typeof error === "object" && error && "code" in error && typeof error.code === "string"
      ? error.code
      : fallbackCode;
    const message = typeof error === "object" && error && "message" in error
      ? String(error.message)
      : typeof error === "string"
        ? error
        : undefined;
    console.log(`[MusicNormalizer/Trace] assertSuccess failed code=${code} message=${message} payload=`, JSON.stringify(payload).slice(0, 2000));
    throw new MusicInputError(code, message ? `${code}: ${message}` : code);
  }
  return p as Record<string, unknown>;
}

export function normalizeDailyRecommendations(payload: unknown): MusicTrack[] {
  const p = payload as {
    success?: boolean;
    songs?: UpstreamSong[];
    error?: string | { code?: string; message?: string };
  };
  if (!p || typeof p !== "object") {
    throw new MusicInputError("E_DAILY_RECOMMEND_INVALID_RESPONSE");
  }
  if (!p.success) {
    const error = p.error;
    const code = typeof error === "object" && error?.code
      ? error.code
      : "E_DAILY_RECOMMEND_FAILED";
    const message = typeof error === "object" ? error?.message : error;
    throw new MusicInputError(code, `${code}: ${message || "unknown error"}`);
  }
  if (!Array.isArray(p.songs)) {
    throw new MusicInputError("E_DAILY_RECOMMEND_INVALID_RESPONSE");
  }
  return p.songs.slice(0, MAX_TRACKS).map(toTrack);
}

export function normalizeSearchResults(payload: unknown): MusicTrack[] {
  if (Array.isArray(payload)) {
    return (payload as UpstreamSong[]).slice(0, MAX_TRACKS).map(toTrack);
  }
  const p = payload as { success?: boolean; items?: UpstreamSong[]; error?: string };
  if (!p?.success || !Array.isArray(p.items)) return [];
  return p.items.slice(0, MAX_TRACKS).map(toTrack);
}

export function normalizeMyPlaylists(payload: unknown): MusicPlaylist[] {
  if (typeof payload === "string") {
    console.log("[MusicNormalizer/Trace] normalizeMyPlaylists text fallback raw=", payload.slice(0, 1000));
    const parsed = tryParseTextPlaylists(payload);
    console.log(`[MusicNormalizer/Trace] normalizeMyPlaylists text fallback parsed=${parsed.length}`);
    return parsed;
  }
  assertSuccess(payload, "E_MY_PLAYLISTS_FAILED");
  const p = payload as { playlists?: UpstreamPlaylist[] };
  if (!Array.isArray(p.playlists)) {
    console.log("[MusicNormalizer/Trace] normalizeMyPlaylists invalid playlists payload=", JSON.stringify(payload).slice(0, 2000));
    throw new MusicInputError("E_MY_PLAYLISTS_INVALID_RESPONSE");
  }
  console.log(`[MusicNormalizer/Trace] normalizeMyPlaylists ok count=${p.playlists.length}`);
  return p.playlists.map(toPlaylist);
}

export function normalizePlaylistDetail(payload: unknown): MusicPlaylistDetail {
  if (typeof payload === "string") {
    console.log("[MusicNormalizer/Trace] normalizePlaylistDetail text fallback raw=", payload.slice(0, 1000));
    const tracks = tryParseTextTracks(payload);
    console.log(`[MusicNormalizer/Trace] normalizePlaylistDetail text fallback parsed=${tracks.length}`);
    return { id: "", name: "", trackCount: tracks.length, tracks };
  }
  const p = assertSuccess(payload, "E_PLAYLIST_DETAIL_FAILED") as {
    name?: string;
    count?: number;
    trackCount?: number;
    songs?: UpstreamSong[];
  };
  if (!Array.isArray(p.songs)) {
    console.log("[MusicNormalizer/Trace] normalizePlaylistDetail invalid songs payload=", JSON.stringify(payload).slice(0, 2000));
    throw new MusicInputError("E_PLAYLIST_DETAIL_INVALID_RESPONSE");
  }
  console.log(`[MusicNormalizer/Trace] normalizePlaylistDetail ok name=${p.name ?? ""} trackCount=${p.songs.length}`);
  return {
    id: "",
    name: p.name ?? "",
    trackCount: p.count ?? p.trackCount ?? p.songs.length,
    tracks: p.songs.slice(0, MAX_TRACKS).map(toTrack),
  };
}

export function normalizeCreatePlaylistResult(payload: unknown): MusicPlaylist {
  if (typeof payload === "string") {
    console.log("[MusicNormalizer/Trace] normalizeCreatePlaylistResult text fallback raw=", payload.slice(0, 1000));
    const names = splitNameList(payload);
    const name = names[0] ?? payload.trim();
    console.log(`[MusicNormalizer/Trace] normalizeCreatePlaylistResult text fallback name=${name}`);
    return { id: "", name, trackCount: 0 };
  }
  const p = assertSuccess(payload, "E_CREATE_PLAYLIST_FAILED") as {
    playlist_id?: string | number;
    name?: string;
  };
  const id = p.playlist_id;
  if (id === undefined || id === null) {
    console.log("[MusicNormalizer/Trace] normalizeCreatePlaylistResult missing playlist_id payload=", JSON.stringify(payload).slice(0, 2000));
    throw new MusicInputError("E_CREATE_PLAYLIST_INVALID_RESPONSE");
  }
  console.log(`[MusicNormalizer/Trace] normalizeCreatePlaylistResult ok id=${id} name=${p.name ?? ""}`);
  return {
    id: String(id),
    name: p.name ?? "",
    trackCount: 0,
  };
}

export function normalizeAddToPlaylistResult(payload: unknown): { added: number; playlistId: string } {
  if (typeof payload === "string") {
    console.log("[MusicNormalizer/Trace] normalizeAddToPlaylistResult text fallback raw=", payload.slice(0, 1000));
    const match = payload.match(/(\d+)/);
    const added = match ? Number(match[1]) : 1;
    console.log(`[MusicNormalizer/Trace] normalizeAddToPlaylistResult text fallback added=${added}`);
    return { added, playlistId: "" };
  }
  const p = assertSuccess(payload, "E_ADD_TO_PLAYLIST_FAILED") as {
    added_count?: number;
    playlist_id?: string | number;
  };
  console.log(`[MusicNormalizer/Trace] normalizeAddToPlaylistResult ok added=${p.added_count ?? 0} playlistId=${p.playlist_id ?? ""}`);
  return {
    added: p.added_count ?? 0,
    playlistId: p.playlist_id ? String(p.playlist_id) : "",
  };
}

export function normalizeMySubscriptions(payload: unknown): MusicSubscription[] {
  if (typeof payload === "string") {
    console.log("[MusicNormalizer/Trace] normalizeMySubscriptions text fallback raw=", payload.slice(0, 1000));
    const parsed = tryParseTextSubscriptions(payload);
    console.log(`[MusicNormalizer/Trace] normalizeMySubscriptions text fallback parsed=${parsed.length}`);
    return parsed;
  }
  assertSuccess(payload, "E_MY_SUBSCRIPTIONS_FAILED");
  const p = payload as { items?: Array<{ id?: string | number; name?: string; artist?: string; coverUrl?: string }> };
  if (!Array.isArray(p.items)) {
    console.log("[MusicNormalizer/Trace] normalizeMySubscriptions invalid items payload=", JSON.stringify(payload).slice(0, 2000));
    throw new MusicInputError("E_MY_SUBSCRIPTIONS_INVALID_RESPONSE");
  }
  const filtered = p.items
    .filter((item): item is typeof item & { id: string | number; name: string } =>
      item.id !== undefined && item.id !== null && typeof item.name === "string" && item.name.length > 0,
    );
  console.log(`[MusicNormalizer/Trace] normalizeMySubscriptions ok raw=${p.items.length} valid=${filtered.length}`);
  return filtered.map((item) => ({
    id: String(item.id),
    name: item.name,
    coverUrl: item.coverUrl,
  }));
}
