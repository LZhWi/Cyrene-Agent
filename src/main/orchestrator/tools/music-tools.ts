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
  }) => void;
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

function searchPurposeOf(userQuery = ""): "discover" | "play" {
  return /^(?:帮我)?(?:播放|放个|放一下)(?!点音乐)/.test(userQuery.trim())
    ? "play"
    : "discover";
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
  return { setRef, source: set.source, candidates };
}

export function buildMusicTools(service: MusicService, hooks: MusicToolHooks = {}): ToolDefinition[] {
  const presentAndPublish = async (
    setId: string,
    conversationId: string,
    trackIds: string[],
    candidateRefs: string[],
    reasons?: string[],
  ): Promise<{ presented: boolean }> => {
    await service.presentTracks({ setId, conversationId, trackIds, reasons });
    const set = service.getSelectionSet(setId, conversationId);
    if (!set || !hooks.sendCard) return { presented: false };
    const byId = new Map(set.tracks.map((track) => [track.id, track]));
    const displayed = trackIds.map((id) => byId.get(id)).filter((track): track is MusicTrack => Boolean(track));
    hooks.sendCard({ setId: set.setId, source: set.source, tracks: displayed });
    service.markTracksPresented(setId, conversationId, trackIds);
    publishEvent(hooks, {
      type: "context_presented",
      eventId: randomUUID(),
      conversationId,
      occurredAt: Date.now(),
      source: "music-tools",
      contextRefs: candidateRefs,
    });
    return { presented: true };
  };

  return [
    {
      id: "music_get_daily_recommendations",
      name: "获取今日推荐歌曲",
      description: "获取网易云音乐今日推荐并将前 5 首展示为卡片。需要用户已登录。返回可信候选引用。",
      enabled: true,
      risk: "safe",
      inputSchema: { type: "object", properties: {}, required: [] },
      needsContext: true,
      execute: async (_args, ctx) => {
        const conversationId = conversationIdOf(ctx);
        const set = await service.getDailyRecommendations(conversationId, { resolutionRunId: ctx?.runId });
        const safeContext = issueSelectionContext(set, refsOf(ctx, hooks), hooks);
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
      name: "搜索网易云歌曲",
      description: "按关键词搜索网易云音乐。返回最多 20 首真实歌曲的可信候选引用。",
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
        const conversationId = conversationIdOf(ctx);
        const purpose = searchPurposeOf(ctx?.userQuery);
        const set = await service.searchTracks(
          String(args.keyword ?? ""),
          conversationId,
          args.limit as number | undefined,
          { resolutionRunId: ctx?.runId, purpose },
        );
        const safeContext = issueSelectionContext(set, refsOf(ctx, hooks), hooks);
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
      name: "呈现已选歌曲为卡片",
      description: "将可信歌曲候选引用渲染为 AG-UI 卡片。候选必须属于同一个集合，最多 5 首。",
      enabled: true,
      risk: "safe",
      inputSchema: {
        type: "object",
        properties: {
          candidateRefs: { type: "array", items: { type: "string" } },
          reasons: { type: "array", items: { type: "string" } },
        },
        required: ["candidateRefs"],
      },
      needsContext: true,
      execute: async (args, ctx) => {
        const conversationId = conversationIdOf(ctx);
        const candidateRefs = Array.isArray(args.candidateRefs) ? args.candidateRefs.map(String) : [];
        const refs = refsOf(ctx, hooks);
        const payloads = candidateRefs.map((ref) => refs.resolve<MusicCandidateRefPayload>(ref, conversationId));
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
      name: "播放网易云歌曲",
      description: "向默认音乐来源发送播放请求。仅接受 CITA 提供的可信歌曲候选引用；dispatched 不等于已开始播放。",
      enabled: true,
      risk: "input-control",
      inputSchema: {
        type: "object",
        properties: {
          candidateRef: { type: "string", description: "CITA 提供的可信歌曲候选引用" },
        },
        required: ["candidateRef"],
      },
      needsContext: true,
      execute: async (args, ctx) => {
        const conversationId = conversationIdOf(ctx);
        const payload = refsOf(ctx, hooks).resolve<MusicCandidateRefPayload>(String(args.candidateRef ?? ""), conversationId);
        if (payload.conversationId !== conversationId) throw new Error("E_CONTEXT_REF_CONVERSATION_MISMATCH");
        const dispatch = await service.playTrack({ ...payload, conversationId, runId: ctx?.runId });
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
