import { randomUUID } from "crypto";
import type { ContextEvent } from "../../cita";
import type { MusicService } from "../../music/music-service";
import type {
  MusicCandidateRefPayload,
  MusicSelectionSet,
  MusicSetRefPayload,
  MusicTrack,
} from "../../music/types";
import { ContextRefRegistry } from "../context-ref-registry";
import { contextRefRegistry, type ToolContext } from "../tool-context";
import type { ToolDefinition } from "../tool-registry";

export interface MusicToolHooks {
  contextRefs?: ContextRefRegistry;
  ingestContextEvent?: (event: ContextEvent) => void;
  sendCard?: (card: {
    setId: string;
    source: string;
    tracks: MusicTrack[];
  }) => boolean;
}

interface SafeMusicContext {
  setRef: string;
  source: MusicSelectionSet["source"];
  candidates: Array<{
    candidateRef: string;
    position: number;
    name: string;
    artists: string[];
    album?: string;
  }>;
}

function conversationIdOf(ctx?: ToolContext): string {
  return ctx?.conversationId || "default";
}

function refsOf(ctx: ToolContext | undefined, hooks: MusicToolHooks): ContextRefRegistry {
  return ctx?.contextRefs ?? hooks.contextRefs ?? contextRefRegistry;
}

function publishEvent(hooks: MusicToolHooks, event: ContextEvent): void {
  hooks.ingestContextEvent?.(event);
}

function issueSelectionContext(
  set: MusicSelectionSet,
  refs: ContextRefRegistry,
  hooks: MusicToolHooks,
): SafeMusicContext {
  const setRef = refs.issue<MusicSetRefPayload>({
    conversationId: set.conversationId,
    domain: "music",
    kind: "selection_set",
    expiresAt: set.expiresAt,
    value: { provider: set.provider, setId: set.setId, conversationId: set.conversationId },
  });
  publishEvent(hooks, {
    type: "context_upserted",
    eventId: randomUUID(),
    conversationId: set.conversationId,
    occurredAt: Date.now(),
    source: "music-tools",
    context: {
      contextRef: setRef,
      conversationId: set.conversationId,
      domain: "music",
      kind: "selection_set",
      label: set.source === "daily_recommendation" ? "网易云今日推荐" : `歌曲搜索：${set.query ?? ""}`,
      attributes: { source: [set.source] },
      lifecycle: "active",
      expiresAt: set.expiresAt,
      source: "tool_result",
    },
  });

  const candidates = set.tracks.map((track, index) => {
    const candidateRef = refs.issue<MusicCandidateRefPayload>({
      conversationId: set.conversationId,
      domain: "music",
      kind: "candidate",
      expiresAt: set.expiresAt,
      value: {
        provider: set.provider,
        setId: set.setId,
        trackId: track.id,
        conversationId: set.conversationId,
      },
    });
    publishEvent(hooks, {
      type: "context_upserted",
      eventId: randomUUID(),
      conversationId: set.conversationId,
      occurredAt: Date.now(),
      source: "music-tools",
      context: {
        contextRef: candidateRef,
        conversationId: set.conversationId,
        domain: "music",
        kind: "candidate",
        label: track.name,
        attributes: {
          artists: track.artists,
          ...(track.album ? { album: [track.album] } : {}),
          source: [set.source],
        },
        position: index + 1,
        presented: false,
        lifecycle: "active",
        expiresAt: set.expiresAt,
        source: "tool_result",
      },
    });
    return {
      candidateRef,
      position: index + 1,
      name: track.name,
      artists: track.artists,
      ...(track.album ? { album: track.album } : {}),
    };
  });
  console.log(
    `[MusicContext/Trace] projected conversation=${set.conversationId} source=${set.source} setRef=${setRef} candidates=${candidates.length}`,
  );
  return { setRef, source: set.source, candidates };
}

export function buildMusicTools(service: MusicService, hooks: MusicToolHooks = {}): ToolDefinition[] {
  const safeContextsBySetId = new Map<string, SafeMusicContext>();
  const contextForSet = (set: MusicSelectionSet, refs: ContextRefRegistry): SafeMusicContext => {
    const existing = safeContextsBySetId.get(set.setId);
    if (existing) return existing;
    const created = issueSelectionContext(set, refs, hooks);
    safeContextsBySetId.set(set.setId, created);
    return created;
  };
  const presentAndPublish = async (
    setId: string,
    conversationId: string,
    trackIds: string[],
    candidateRefs: string[],
    reasons?: string[],
  ): Promise<{ presented: boolean; reused?: boolean }> => {
    await service.presentTracks({ setId, conversationId, trackIds, reasons });
    const set = service.getSelectionSet(setId, conversationId);
    if (!set || !hooks.sendCard) {
      console.log(`[MusicContext/Trace] presentation conversation=${conversationId} delivered=false reason=no_recipient candidates=${candidateRefs.length}`);
      return { presented: false };
    }
    if (
      set.presentedAt !== undefined
      && set.presentedTrackIds?.length === trackIds.length
      && set.presentedTrackIds.every((trackId, index) => trackId === trackIds[index])
    ) {
      publishEvent(hooks, {
        type: "context_presented",
        eventId: randomUUID(),
        conversationId,
        occurredAt: Date.now(),
        source: "music-tools",
        contextRefs: candidateRefs,
      });
      console.log(`[MusicContext/Trace] presentation conversation=${conversationId} delivered=true reused=true candidates=${candidateRefs.length}`);
      return { presented: true, reused: true };
    }
    const byId = new Map(set.tracks.map((track) => [track.id, track]));
    const displayed = trackIds.map((id) => byId.get(id)).filter((track): track is MusicTrack => Boolean(track));
    const delivered = hooks.sendCard({ setId: set.setId, source: set.source, tracks: displayed });
    if (!delivered) {
      console.log(`[MusicContext/Trace] presentation conversation=${conversationId} delivered=false reason=recipient_unavailable candidates=${candidateRefs.length}`);
      return { presented: false };
    }
    service.markTracksPresented(setId, conversationId, trackIds);
    publishEvent(hooks, {
      type: "context_presented",
      eventId: randomUUID(),
      conversationId,
      occurredAt: Date.now(),
      source: "music-tools",
      contextRefs: candidateRefs,
    });
    console.log(
      `[MusicContext/Trace] presentation conversation=${conversationId} delivered=true candidates=${candidateRefs.length} refs=[${candidateRefs.join(",")}]`,
    );
    return { presented: true };
  };

  return [
    {
      id: "music_get_daily_recommendations",
      capability: "music.daily_recommendations",
      name: "获取今日推荐歌曲",
      description: "获取网易云音乐今日推荐并将前 5 首展示为卡片。需要用户已登录。返回可信候选引用。",
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
          ?? await service.getDailyRecommendations(conversationId, { resolutionRunId: ctx?.runId });
        const safeContext = contextForSet(set, refsOf(ctx, hooks));
        const selected = safeContext.candidates.slice(0, 5);
        const presentation = selected.length > 0
          ? await presentAndPublish(
            set.setId,
            conversationId,
            set.tracks.slice(0, 5).map((track) => track.id),
            selected.map((candidate) => candidate.candidateRef),
          )
          : undefined;
        return JSON.stringify({ kind: "recommendations", context: safeContext, presentation });
      },
    },
    {
      id: "music_search",
      capability: "music.search",
      name: "搜索网易云歌曲",
      description: "按关键词搜索网易云音乐。purpose=discover 用于展示候选；purpose=play 用于本轮搜索确认后直接播放唯一结果。返回最多 20 首真实歌曲的可信候选引用。",
      enabled: true,
      modes: ["work"],
      risk: "safe",
      inputSchema: {
        type: "object",
        properties: {
          keyword: { type: "string", description: "搜索关键词 (1-100 字)" },
          limit: { type: "number", description: "返回数量 (1-20)" },
          purpose: {
            type: "string",
            enum: ["discover", "play"],
            description: "本次搜索目的。由工具阶段结合用户请求和 CITA 上下文明确选择，Tool Runtime 不猜测。",
          },
        },
        required: ["keyword", "purpose"],
      },
      needsContext: true,
      effectKind: "read" as const,
      verificationPolicy: "none" as const,
      execute: async (args, ctx) => {
        const conversationId = conversationIdOf(ctx);
        const purpose = args.purpose;
        if (purpose !== "discover" && purpose !== "play") {
          throw new Error("E_MUSIC_SEARCH_PURPOSE_REQUIRED");
        }
        const set = await service.searchTracks(
          String(args.keyword ?? ""),
          conversationId,
          args.limit as number | undefined,
          { resolutionRunId: ctx?.runId, purpose },
        );
        const safeContext = contextForSet(set, refsOf(ctx, hooks));
        const selected = safeContext.candidates.slice(0, 5);
        const shouldPresent = selected.length > 0 && (purpose === "discover" || set.tracks.length > 1);
        const presentation = shouldPresent
          ? await presentAndPublish(
            set.setId,
            conversationId,
            set.tracks.slice(0, 5).map((track) => track.id),
            selected.map((candidate) => candidate.candidateRef),
          )
          : undefined;
        return JSON.stringify({ kind: "search", context: safeContext, presentation });
      },
    },
    {
      id: "music_present_tracks",
      capability: "music.present_tracks",
      name: "呈现已选歌曲为卡片",
      description: "将可信歌曲候选引用渲染为 AG-UI 卡片。候选必须属于同一个集合，最多 5 首。",
      enabled: true,
      modes: ["work"],
      risk: "safe",
      inputSchema: {
        type: "object",
        properties: {
          candidateRefs: { type: "array", items: { type: "string" } },
          reasons: { type: "array", items: { type: "string" } },
        },
        required: ["candidateRefs"],
      },
      controlledInput: { candidateRefs: { type: "context_ref_array", kind: "candidate" } },
      needsContext: true,
      effectKind: "read" as const,
      verificationPolicy: "none" as const,
      execute: async (args, ctx) => {
        const conversationId = conversationIdOf(ctx);
        const candidateRefs = Array.isArray(args.candidateRefs) ? args.candidateRefs.map(String) : [];
        const refs = refsOf(ctx, hooks);
        const payloads = candidateRefs.map((ref) => refs.resolve<MusicCandidateRefPayload>(ref, conversationId, "candidate"));
        const first = payloads[0];
        if (!first || payloads.some((payload) => (
          payload.setId !== first.setId
          || payload.provider !== first.provider
          || payload.conversationId !== conversationId
        ))) throw new Error("E_MUSIC_MIXED_CONTEXT_SET");
        const presentation = await presentAndPublish(
          first.setId,
          conversationId,
          payloads.map((payload) => payload.trackId),
          candidateRefs,
          Array.isArray(args.reasons) ? args.reasons.map(String) : undefined,
        );
        return JSON.stringify({ kind: "presentation", ...presentation });
      },
    },
    {
      id: "music_play_track",
      capability: "music.play_track",
      name: "播放网易云歌曲",
      description: "向默认音乐来源发送播放请求。仅接受 CITA 提供的可信歌曲候选引用；dispatched 不等于已开始播放。",
      enabled: true,
      modes: ["work"],
      risk: "input-control",
      inputSchema: {
        type: "object",
        properties: {
          candidateRef: { type: "string", description: "CITA 提供的可信歌曲候选引用" },
        },
        required: ["candidateRef"],
      },
      controlledInput: { candidateRef: { type: "context_ref", kind: "candidate" } },
      needsContext: true,
      effectKind: "external_side_effect" as const,
      verificationPolicy: "none" as const,
      execute: async (args, ctx) => {
        const conversationId = conversationIdOf(ctx);
        const candidateRef = String(args.candidateRef ?? "");
        console.log(`[MusicContext/Trace] playback-resolve conversation=${conversationId} ref=${candidateRef || "(empty)"}`);
        const payload = refsOf(ctx, hooks).resolve<MusicCandidateRefPayload>(candidateRef, conversationId, "candidate");
        if (payload.conversationId !== conversationId) throw new Error("E_CONTEXT_REF_CONVERSATION_MISMATCH");
        console.log(`[MusicContext/Trace] playback-resolved conversation=${conversationId} ref=${candidateRef}`);
        const dispatch = await service.playTrack({ ...payload, conversationId, runId: ctx?.runId });
        return JSON.stringify({ kind: "playback", dispatch });
      },
    },
    {
      id: "music_play_playlist",
      capability: "music.play_playlist",
      name: "播放网易云歌单",
      description: "通过本地网易云客户端播放指定歌单 ID。",
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
      description: "将一首或多首歌曲添加到指定的网易云音乐歌单。歌曲 ID 必须是纯数字。",
      enabled: true,
      modes: ["work"],
      risk: "input-control",
      inputSchema: {
        type: "object",
        properties: {
          playlistId: { type: "string", description: "目标歌单 ID" },
          trackIds: { type: "array", items: { type: "string" }, description: "要添加的歌曲 ID 列表" },
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
