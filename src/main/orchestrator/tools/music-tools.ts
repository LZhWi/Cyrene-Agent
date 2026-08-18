// music-tools.ts — M4 rewrite: CITA removed, 9 tools, encryptedId direct.
//
// Changes from M3:
// - Removed: ContextRefRegistry, issueSelectionContext, presentAndPublish,
//   MusicCandidateRefPayload, MusicSetRefPayload, music_present_tracks
// - music_search: no purpose param, returns tracks with encryptedId + originalId
// - music_play_track: accepts encryptedId (32-hex), calls playTrackFromUi
// - music_get_daily_recommendations / music_search: directly call sendCard
import type { MusicService } from "../../music/music-service";
import type { MusicTrack } from "../../music/types";
import type { ToolDefinition } from "../tool-registry";
import type { ToolContext } from "../tool-context";

export interface MusicToolHooks {
  /** Renderer card delivery. Returns true if the renderer accepted the card. */
  sendCard?: (card: {
    source: string;
    tracks: MusicTrack[];
  }) => boolean;
}

const HEX32 = /^[0-9A-Fa-f]{32}$/;

function conversationIdOf(ctx?: ToolContext): string {
  return ctx?.conversationId || "default";
}

/** Pick the top N tracks and deliver them as a card if a recipient exists. */
function deliverCard(
  hooks: MusicToolHooks,
  source: string,
  tracks: MusicTrack[],
  maxCards = 5,
): { delivered: boolean; displayed: MusicTrack[] } {
  const displayed = tracks.slice(0, maxCards);
  if (!hooks.sendCard) return { delivered: false, displayed };
  const delivered = hooks.sendCard({ source, tracks: displayed });
  return { delivered, displayed };
}

export function buildMusicTools(service: MusicService, hooks: MusicToolHooks = {}): ToolDefinition[] {
  return [
    {
      id: "music_get_daily_recommendations",
      capability: "music.daily_recommendations",
      name: "获取今日推荐歌曲",
      description: "获取网易云音乐今日推荐歌曲。返回包含加密 ID 和原始 ID 的歌曲列表，并展示前 5 首为卡片。需要用户已登录。",
      enabled: true,
      modes: ["work"],
      risk: "safe",
      inputSchema: { type: "object", properties: {}, required: [] },
      needsContext: true,
      effectKind: "read" as const,
      verificationPolicy: "none" as const,
      execute: async (_args, ctx) => {
        const conversationId = conversationIdOf(ctx);
        const set = service.getLatestSelectionSet(conversationId, "daily_recommendation")
          ?? await service.getDailyRecommendations(conversationId);
        const card = deliverCard(hooks, "daily_recommendation", set.tracks);
        return JSON.stringify({
          kind: "recommendations",
          tracks: set.tracks.map((t) => ({
            encryptedId: t.encryptedId ?? t.id,
            originalId: t.originalId,
            name: t.name,
            artists: t.artists,
            album: t.album,
            durationMs: t.durationMs,
            coverUrl: t.coverUrl,
          })),
          card: { delivered: card.delivered, count: card.displayed.length },
        });
      },
    },
    {
      id: "music_search",
      capability: "music.search",
      name: "搜索网易云歌曲",
      description: "按关键词搜索网易云音乐。返回包含加密 ID 和原始 ID 的歌曲列表，并展示前 5 首为卡片。用户说「播放某歌」时，先用此工具搜索拿到 encryptedId，再调 music_play_track。",
      enabled: true,
      modes: ["work"],
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
      effectKind: "read" as const,
      verificationPolicy: "none" as const,
      execute: async (args, ctx) => {
        const conversationId = conversationIdOf(ctx);
        const set = await service.searchTracks(
          String(args.keyword ?? ""),
          conversationId,
          args.limit as number | undefined,
        );
        const card = deliverCard(hooks, "search", set.tracks);
        return JSON.stringify({
          kind: "search",
          tracks: set.tracks.map((t) => ({
            encryptedId: t.encryptedId ?? t.id,
            originalId: t.originalId,
            name: t.name,
            artists: t.artists,
            album: t.album,
            durationMs: t.durationMs,
            coverUrl: t.coverUrl,
          })),
          card: { delivered: card.delivered, count: card.displayed.length },
        });
      },
    },
    {
      id: "music_play_track",
      capability: "music.play_track",
      name: "播放网易云歌曲",
      description: "播放一首网易云音乐歌曲。入参 encryptedId 是 32 位十六进制加密歌曲 ID（从 music_search 或 music_get_daily_recommendations 返回结果中获取）。dispatched 表示已向 mpv 发送播放指令。",
      enabled: true,
      modes: ["work"],
      risk: "input-control",
      inputSchema: {
        type: "object",
        properties: {
          encryptedId: { type: "string", description: "32 位十六进制加密歌曲 ID" },
        },
        required: ["encryptedId"],
      },
      controlledInput: { encryptedId: "tool_result" },
      needsContext: false,
      effectKind: "external_side_effect" as const,
      verificationPolicy: "none" as const,
      execute: async (args) => {
        const encryptedId = String(args.encryptedId ?? "");
        if (!HEX32.test(encryptedId)) {
          throw new Error("E_INVALID_ENCRYPTED_ID");
        }
        const dispatch = await service.playTrackFromUi(encryptedId);
        return JSON.stringify({ kind: "playback", dispatch });
      },
    },
    {
      id: "music_play_playlist",
      capability: "music.play_playlist",
      name: "播放网易云歌单",
      description: "播放指定的网易云音乐歌单。入参 playlistId 从 music_my_playlists 或 music_playlist_detail 返回结果中获取。",
      enabled: true,
      modes: ["work"],
      risk: "input-control",
      inputSchema: {
        type: "object",
        properties: { playlistId: { type: "string" } },
        required: ["playlistId"],
      },
      controlledInput: { playlistId: "tool_result" },
      effectKind: "external_side_effect" as const,
      verificationPolicy: "none" as const,
      execute: async (args) => {
        const dispatch = await service.playPlaylist(String(args.playlistId));
        return JSON.stringify({ kind: "playback", dispatch });
      },
    },
    {
      id: "music_my_playlists",
      capability: "music.my_playlists",
      name: "获取我的网易云歌单",
      description: "获取当前登录用户的网易云音乐歌单列表，包括创建的和收藏的歌单。",
      enabled: true,
      modes: ["work"],
      risk: "safe",
      inputSchema: { type: "object", properties: {}, required: [] },
      needsContext: false,
      effectKind: "read" as const,
      verificationPolicy: "none" as const,
      execute: async () => {
        const playlists = await service.getMyPlaylists();
        return JSON.stringify({ kind: "my_playlists", playlists });
      },
    },
    {
      id: "music_playlist_detail",
      capability: "music.playlist_detail",
      name: "获取网易云歌单详情",
      description: "获取指定网易云音乐歌单的详细信息，包括歌单名称和其中的歌曲列表。",
      enabled: true,
      modes: ["work"],
      risk: "safe",
      inputSchema: {
        type: "object",
        properties: {
          playlistId: { type: "string", description: "网易云音乐歌单 ID" },
        },
        required: ["playlistId"],
      },
      controlledInput: { playlistId: "tool_result" },
      needsContext: false,
      effectKind: "read" as const,
      verificationPolicy: "none" as const,
      execute: async (args) => {
        const detail = await service.getPlaylistDetail(String(args.playlistId));
        return JSON.stringify({ kind: "playlist_detail", detail });
      },
    },
    {
      id: "music_create_playlist",
      capability: "music.create_playlist",
      name: "创建网易云歌单",
      description: "为当前登录用户创建一个新的网易云音乐歌单。",
      enabled: true,
      modes: ["work"],
      risk: "input-control",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "新歌单名称 (1-100 字)" },
          privacy: { type: "boolean", description: "是否为隐私歌单，默认否" },
        },
        required: ["name"],
      },
      needsContext: false,
      effectKind: "mutation" as const,
      verificationPolicy: "none" as const,
      execute: async (args) => {
        const playlist = await service.createPlaylist(String(args.name), { privacy: Boolean(args.privacy) });
        return JSON.stringify({ kind: "create_playlist", playlist });
      },
    },
    {
      id: "music_add_to_playlist",
      capability: "music.add_to_playlist",
      name: "添加歌曲到网易云歌单",
      description: "将一首或多首歌曲添加到指定的网易云音乐歌单。trackIds 为 32 位十六进制加密歌曲 ID。",
      enabled: true,
      modes: ["work"],
      risk: "input-control",
      inputSchema: {
        type: "object",
        properties: {
          playlistId: { type: "string", description: "目标歌单 ID" },
          trackIds: { type: "array", items: { type: "string" }, description: "要添加的加密歌曲 ID 列表 (32 位 hex)" },
        },
        required: ["playlistId", "trackIds"],
      },
      controlledInput: { playlistId: "tool_result" },
      needsContext: false,
      effectKind: "mutation" as const,
      verificationPolicy: "none" as const,
      execute: async (args) => {
        const playlistId = String(args.playlistId ?? "");
        const trackIds = Array.isArray(args.trackIds) ? args.trackIds.map(String) : [];
        const result = await service.addToPlaylist(playlistId, trackIds);
        return JSON.stringify({ kind: "add_to_playlist", ...result });
      },
    },
    {
      id: "music_my_subscriptions",
      capability: "music.my_subscriptions",
      name: "获取我的网易云收藏",
      description: "获取当前登录用户收藏的歌手或专辑列表。category 为 'artists' 或 'albums'。",
      enabled: true,
      modes: ["work"],
      risk: "safe",
      inputSchema: {
        type: "object",
        properties: {
          category: {
            type: "string",
            enum: ["artists", "albums"],
            description: "收藏类型：artists 表示歌手，albums 表示专辑",
          },
        },
        required: ["category"],
      },
      needsContext: false,
      effectKind: "read" as const,
      verificationPolicy: "none" as const,
      execute: async (args) => {
        const category = String(args.category ?? "");
        if (category !== "artists" && category !== "albums") {
          throw new Error("E_INVALID_SUBSCRIPTION_CATEGORY");
        }
        const subscriptions = await service.getMySubscriptions(category as "artists" | "albums");
        return JSON.stringify({ kind: "my_subscriptions", category, subscriptions });
      },
    },
  ];
}
