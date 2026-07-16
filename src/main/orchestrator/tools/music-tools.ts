import type { ToolDefinition } from "../tool-registry";
import type { MusicService } from "../../music/music-service";
import type { MusicTrack } from "../../music/types";

export interface MusicToolHooks {
  onPresented?: (set: {
    conversationId: string;
    setId: string;
    expiresAt: number;
    tracks: Array<{ trackId: string; name: string; artists: string[]; album?: string; coverUrl?: string }>;
  }) => void;
  sendCard?: (card: {
    setId: string;
    source: string;
    tracks: MusicTrack[];
  }) => void;
}

function conversationIdOf(ctx?: { conversationId?: string }): string {
  return ctx?.conversationId || "default";
}

export function buildMusicTools(service: MusicService, hooks: MusicToolHooks = {}): ToolDefinition[] {
  return [
    {
      id: "music_get_daily_recommendations",
      name: "获取今日推荐歌曲",
      description: "获取网易云音乐今日推荐（最多 10 首）。需要用户已登录。返回带 setId 的集合。",
      enabled: true,
      risk: "safe",
      inputSchema: { type: "object", properties: {}, required: [] },
      needsContext: true,
      execute: async (_args, ctx) => {
        const set = await service.getDailyRecommendations(conversationIdOf(ctx));
        return JSON.stringify({ kind: "recommendations", set });
      },
    },
    {
      id: "music_search",
      name: "搜索网易云歌曲",
      description: "按关键词搜索网易云音乐。返回最多 20 首歌曲及 ID（带 setId）。",
      enabled: true,
      risk: "safe",
      inputSchema: {
        type: "object",
        properties: {
          keyword: { type: "string", description: "搜索关键词 (1-100 字)" },
          limit: { type: "number", description: "返回数量 (1-20)" },
        },
        required: ["keyword"],
      },
      needsContext: true,
      execute: async (args, ctx) => {
        const set = await service.searchTracks(
          String(args.keyword ?? ""), conversationIdOf(ctx), args.limit as number | undefined,
        );
        return JSON.stringify({ kind: "search", set });
      },
    },
    {
      id: "music_present_tracks",
      name: "呈现已选歌曲为卡片",
      description: "将已选 trackIds 渲染为可播放的 AG-UI 卡片。trackIds 必须来自之前返回的 setId 集合。最多 5 首。",
      enabled: true,
      risk: "safe",
      inputSchema: {
        type: "object",
        properties: {
          setId: { type: "string" },
          trackIds: { type: "array", items: { type: "string" } },
          reasons: { type: "array", items: { type: "string" } },
        },
        required: ["setId", "trackIds"],
      },
      needsContext: true,
      execute: async (args, ctx) => {
        const conversationId = conversationIdOf(ctx);
        const trackIds = Array.isArray(args.trackIds) ? (args.trackIds as string[]) : [];
        const r = await service.presentTracks({
          setId: String(args.setId ?? ""),
          conversationId,
          trackIds,
          reasons: Array.isArray(args.reasons) ? (args.reasons as string[]) : undefined,
        });
        const set = service.getSelectionSet(String(args.setId ?? ""), conversationId);
        if (set) {
          const byId = new Map(set.tracks.map((track) => [track.id, track]));
          const displayed = trackIds.map((id) => byId.get(id)).filter((track): track is MusicTrack => Boolean(track));
          hooks.onPresented?.({
            conversationId,
            setId: set.setId,
            expiresAt: set.expiresAt,
            tracks: displayed.map((track) => ({
              trackId: track.id,
              name: track.name,
              artists: track.artists,
              album: track.album,
              coverUrl: track.coverUrl,
            })),
          });
          hooks.sendCard?.({ setId: set.setId, source: set.source, tracks: displayed });
        }
        return JSON.stringify({ kind: "presentation", cardRef: r.cardRef });
      },
    },
    {
      id: "music_play_track",
      name: "播放网易云歌曲",
      description: "通过本地网易云客户端播放指定歌曲 ID。",
      enabled: true,
      risk: "input-control",
      inputSchema: {
        type: "object",
        properties: { trackId: { type: "string" } },
        required: ["trackId"],
      },
      execute: async (args) => {
        const dispatch = await service.playTrack(String(args.trackId));
        return JSON.stringify({ kind: "playback", dispatch });
      },
    },
    {
      id: "music_play_playlist",
      name: "播放网易云歌单",
      description: "通过本地网易云客户端播放指定歌单 ID。",
      enabled: true,
      risk: "input-control",
      inputSchema: {
        type: "object",
        properties: { playlistId: { type: "string" } },
        required: ["playlistId"],
      },
      execute: async (args) => {
        const dispatch = await service.playPlaylist(String(args.playlistId));
        return JSON.stringify({ kind: "playback", dispatch });
      },
    },
  ];
}
