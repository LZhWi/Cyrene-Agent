import type { ToolDefinition } from "../tool-registry";
import type { MusicService } from "../../music/music-service";
import type { MusicTrack } from "../../music/types";

export interface MusicToolHooks {
  onPresented?: (set: {
    conversationId: string;
    setId: string;
    expiresAt: number;
    tracks: Array<{ provider: string; trackId: string; name: string; artists: string[]; album?: string; coverUrl?: string }>;
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

function searchPurposeOf(userQuery = ""): "discover" | "play" {
  return /^(?:帮我)?(?:播放|放个|放一下)(?!点音乐)/.test(userQuery.trim())
    ? "play"
    : "discover";
}

export function buildMusicTools(service: MusicService, hooks: MusicToolHooks = {}): ToolDefinition[] {
  const presentAndPublish = async (
    setId: string,
    conversationId: string,
    trackIds: string[],
    reasons?: string[],
  ): Promise<{ cardRef: string }> => {
    const result = await service.presentTracks({ setId, conversationId, trackIds, reasons });
    const set = service.getSelectionSet(setId, conversationId);
    if (set) {
      const byId = new Map(set.tracks.map((track) => [track.id, track]));
      const displayed = trackIds.map((id) => byId.get(id)).filter((track): track is MusicTrack => Boolean(track));
      hooks.onPresented?.({
        conversationId,
        setId: set.setId,
        expiresAt: set.expiresAt,
        tracks: displayed.map((track) => ({
          provider: set.provider,
          trackId: track.id,
          name: track.name,
          artists: track.artists,
          album: track.album,
          coverUrl: track.coverUrl,
        })),
      });
      hooks.sendCard?.({ setId: set.setId, source: set.source, tracks: displayed });
    }
    return result;
  };

  return [
    {
      id: "music_get_daily_recommendations",
      name: "获取今日推荐歌曲",
      description: "获取网易云音乐今日推荐并将前 5 首展示为卡片。需要用户已登录。返回带 setId 的真实集合与 presentation。",
      enabled: true,
      risk: "safe",
      inputSchema: { type: "object", properties: {}, required: [] },
      needsContext: true,
      execute: async (_args, ctx) => {
        const conversationId = conversationIdOf(ctx);
        const set = await service.getDailyRecommendations(conversationId, {
          resolutionRunId: ctx?.runId,
        });
        const trackIds = set.tracks.slice(0, 5).map((track) => track.id);
        const presentation = trackIds.length > 0
          ? await presentAndPublish(set.setId, conversationId, trackIds)
          : undefined;
        return JSON.stringify({ kind: "recommendations", set, presentation });
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
        const purpose = searchPurposeOf(ctx?.userQuery);
        const set = await service.searchTracks(
          String(args.keyword ?? ""), conversationIdOf(ctx), args.limit as number | undefined,
          {
            resolutionRunId: ctx?.runId,
            purpose,
          },
        );
        const presentation = set.tracks.length > 0
          && (purpose === "discover" || set.tracks.length > 1)
          ? await presentAndPublish(
            set.setId,
            conversationIdOf(ctx),
            set.tracks.slice(0, 5).map((track) => track.id),
          )
          : undefined;
        return JSON.stringify({ kind: "search", set, presentation });
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
        const r = await presentAndPublish(
          String(args.setId ?? ""),
          conversationId,
          trackIds,
          Array.isArray(args.reasons) ? (args.reasons as string[]) : undefined,
        );
        return JSON.stringify({ kind: "presentation", cardRef: r.cardRef });
      },
    },
    {
      id: "music_play_track",
      name: "播放网易云歌曲",
      description: "向默认音乐来源发送播放请求。仅接受真实候选返回的 provider、setId、trackId；dispatched 不等于已开始播放。",
      enabled: true,
      risk: "input-control",
      inputSchema: {
        type: "object",
        properties: {
          provider: { type: "string" },
          setId: { type: "string" },
          trackId: { type: "string" },
        },
        required: ["provider", "setId", "trackId"],
      },
      needsContext: true,
      execute: async (args, ctx) => {
        const dispatch = await service.playTrack({
          provider: String(args.provider ?? ""),
          setId: String(args.setId ?? ""),
          trackId: String(args.trackId ?? ""),
          conversationId: conversationIdOf(ctx),
          runId: ctx?.runId,
        });
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
