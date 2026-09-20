import { randomUUID } from "node:crypto";
import type { PluginContext, PluginConversationMessage, PluginConversationSummary } from "@playa0v0/cyrene-plugin-sdk";
import type { Entry } from "./entries";
import { matchTrigger, type SourceCandidate, type SourceSession } from "./source-matcher";
import { locateAndVerifySource } from "./source-review";
import { stripAssistantHiddenText } from "./derived-text";

const MAX_CONVERSATIONS = 20;
const MAX_LISTED_CONVERSATIONS = 500;
const MAX_MESSAGES = 20_000;
const MAX_DISPLAYED_CANDIDATES = 12;
const MAX_MEMORY_RESULTS = 500;

interface HistoricalMemory {
  view(): { revision: number; entries: Entry[] };
  bindHistoricalSources(raw: unknown): { revision: number };
}

interface PreviewResult {
  entryId: string;
  content: string;
  trigger: string;
  method: ReturnType<typeof matchTrigger>["method"];
  candidates: SourceCandidate[];
  recommendation?: { conversationId: string; messageId: string; locateConfidence: number; verifyConfidence: number };
}

interface CurrentPreview {
  id: string;
  revision: number;
  conversationIds: string[];
  totalEligible: number;
  results: PreviewResult[];
}

function parseConversationIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_CONVERSATIONS
    || value.some((id) => typeof id !== "string" || !id || id.length > 500)) throw new Error(`请选择 1-${MAX_CONVERSATIONS} 个会话`);
  const ids = [...new Set(value as string[])];
  if (ids.length !== value.length) throw new Error("会话选择包含重复项");
  return ids;
}

function toSourceMessage(message: PluginConversationMessage) {
  const at = Date.parse(message.at);
  if (!Number.isFinite(at) || at < 0 || !message.id || !message.text) throw new Error("历史消息结构无效");
  return { id: message.id, role: message.role, content: message.role === "assistant" ? stripAssistantHiddenText(message.text) : message.text, at };
}

function clip(value: string, length: number) { return value.slice(0, length); }

export function createNativeHistory(ctx: PluginContext, memory: HistoricalMemory) {
  let current: CurrentPreview | undefined;

  async function listConversations(signal: AbortSignal): Promise<PluginConversationSummary[]> {
    const conversations = ctx.deps.conversations;
    if (!conversations) throw new Error("宿主未提供会话读取能力");
    const result: PluginConversationSummary[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      if (signal.aborted) throw new Error("历史会话读取已取消");
      const page = await conversations.list({ cursor, limit: 100 });
      if (signal.aborted) throw new Error("历史会话读取已取消");
      result.push(...page.items);
      if (result.length >= MAX_LISTED_CONVERSATIONS) return result.slice(0, MAX_LISTED_CONVERSATIONS);
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error("宿主返回了重复会话游标");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return result;
  }

  async function readSessions(conversationIds: string[], signal: AbortSignal): Promise<SourceSession[]> {
    const conversations = ctx.deps.conversations;
    if (!conversations) throw new Error("宿主未提供会话读取能力");
    const sessions: SourceSession[] = [];
    let total = 0;
    for (const conversationId of conversationIds) {
      const messages: PluginConversationMessage[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      let frozenRange: string | undefined;
      do {
        if (signal.aborted) throw new Error("历史会话读取已取消");
        const page = await conversations.getMessages({ conversationId, cursor, limit: 100 });
        if (signal.aborted) throw new Error("历史会话读取已取消");
        const range = JSON.stringify(page.range);
        if (frozenRange !== undefined && range !== frozenRange) throw new Error("历史会话分页边界发生变化");
        frozenRange = range;
        messages.push(...page.items);
        total += page.items.length;
        if (total > MAX_MESSAGES) throw new Error("所选历史消息超过单次只读预检上限");
        cursor = page.nextCursor;
        if (cursor && cursors.has(cursor)) throw new Error("宿主返回了重复消息游标");
        if (cursor) cursors.add(cursor);
      } while (cursor);
      sessions.push({ id: conversationId, messages: messages.map(toSourceMessage) });
    }
    return sessions;
  }

  function buildResults(entries: Entry[], sessions: SourceSession[]): PreviewResult[] {
    return entries
      .filter((entry) => entry.provenance === "legacy-unverified" && !entry.isSummary)
      .slice(0, MAX_MEMORY_RESULTS)
      .map((entry) => {
        const trigger = entry.triggerText?.trim() || entry.quote.trim();
        const match = matchTrigger(trigger, sessions);
        return { entryId: entry.id, content: entry.content, trigger, method: match.method, candidates: match.candidates };
      });
  }

  function publicPreview(preview: CurrentPreview) {
    const counts: Record<string, number> = {};
    for (const result of preview.results) counts[result.method] = (counts[result.method] ?? 0) + 1;
    return {
      id: preview.id,
      revision: preview.revision,
      conversationIds: [...preview.conversationIds],
      totalEligible: preview.totalEligible,
      truncated: preview.totalEligible > preview.results.length,
      counts,
      unique: preview.results.filter((result) => ["exact", "normalized-exact"].includes(result.method) && result.candidates.length === 1).length,
      results: preview.results.map((result) => ({
        entryId: result.entryId,
        content: clip(result.content, 500),
        trigger: clip(result.trigger, 500),
        method: result.method,
        totalCandidates: result.candidates.length,
        candidates: result.candidates.slice(0, MAX_DISPLAYED_CANDIDATES).map((candidate) => ({
          conversationId: candidate.sessionId,
          messageId: candidate.message.id,
          at: candidate.message.at,
          text: clip(candidate.message.content, 900),
          before: candidate.previous ? clip(candidate.previous.content, 500) : "",
          after: candidate.next ? clip(candidate.next.content, 500) : "",
        })),
        recommendation: result.recommendation,
      })),
    };
  }

  async function refreshPreview(preview: CurrentPreview, signal: AbortSignal) {
    if (memory.view().revision !== preview.revision) throw new Error("记忆已变化，请重新预检历史来源");
    const sessions = await readSessions(preview.conversationIds, signal);
    const state = memory.view();
    if (state.revision !== preview.revision) throw new Error("记忆已变化，请重新预检历史来源");
    return { state, sessions, results: buildResults(state.entries, sessions) };
  }

  function binding(entryId: string, candidate: SourceCandidate) {
    return {
      entryId,
      conversationId: candidate.sessionId,
      messageId: candidate.message.id,
      text: candidate.message.content,
      at: candidate.message.at,
      ...(candidate.previous ? { before: candidate.previous.content } : {}),
      ...(candidate.next ? { after: candidate.next.content } : {}),
    };
  }

  function requirePreview(value: unknown): CurrentPreview {
    if (!current || (value as any)?.previewId !== current.id) throw new Error("历史来源预检已失效，请重新预检");
    return current;
  }

  return {
    async list(signal: AbortSignal) {
      return (await listConversations(signal)).map((item) => ({
        id: item.id,
        title: clip(item.title, 200),
        mode: item.mode,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      }));
    },
    async preview(value: unknown, signal: AbortSignal) {
      const conversationIds = parseConversationIds((value as any)?.conversationIds);
      const sessions = await readSessions(conversationIds, signal);
      const state = memory.view();
      current = {
        id: randomUUID(),
        revision: state.revision,
        conversationIds,
        totalEligible: state.entries.filter((entry) => entry.provenance === "legacy-unverified" && !entry.isSummary).length,
        results: buildResults(state.entries, sessions),
      };
      return publicPreview(current);
    },
    async applyUnique(value: unknown, signal: AbortSignal) {
      const preview = requirePreview(value);
      const refreshed = await refreshPreview(preview, signal);
      if (current !== preview) throw new Error("历史来源预检已失效，请重新预检");
      const bindings = refreshed.results
        .filter((result) => ["exact", "normalized-exact"].includes(result.method) && result.candidates.length === 1)
        .slice(0, 100)
        .map((result) => binding(result.entryId, result.candidates[0]));
      if (!bindings.length) throw new Error("没有可自动绑定的唯一来源");
      const next = memory.bindHistoricalSources({ revision: refreshed.state.revision, bindings });
      current = undefined;
      return { bound: bindings.length, revision: next.revision };
    },
    async applySelection(value: unknown, signal: AbortSignal) {
      const preview = requirePreview(value);
      const entryId = (value as any)?.entryId;
      const conversationId = (value as any)?.conversationId;
      const messageId = (value as any)?.messageId;
      if (![entryId, conversationId, messageId].every((item) => typeof item === "string" && item)) throw new Error("来源选择无效");
      const refreshed = await refreshPreview(preview, signal);
      if (current !== preview) throw new Error("历史来源预检已失效，请重新预检");
      const result = refreshed.results.find((item) => item.entryId === entryId);
      const candidate = result?.candidates.find((item) => item.sessionId === conversationId && item.message.id === messageId);
      if (!result || result.method !== "ambiguous" || !candidate) throw new Error("所选消息不再属于当前歧义候选");
      const next = memory.bindHistoricalSources({ revision: refreshed.state.revision, bindings: [binding(entryId, candidate)] });
      current = {
        ...preview,
        revision: next.revision,
        results: refreshed.results.filter((item) => item.entryId !== entryId),
      };
      return { bound: 1, revision: next.revision, preview: publicPreview(current) };
    },
    async reviewAmbiguity(value: unknown, signal: AbortSignal) {
      const preview = requirePreview(value);
      const entryId = (value as any)?.entryId;
      if (typeof entryId !== "string" || !entryId) throw new Error("待判断记忆无效");
      const llm = ctx.deps.llm;
      if (!llm) throw new Error("宿主未提供模型能力");
      const refreshed = await refreshPreview(preview, signal);
      if (current !== preview) throw new Error("历史来源预检已失效，请重新预检");
      const result = refreshed.results.find((item) => item.entryId === entryId);
      if (!result || result.method !== "ambiguous" || result.candidates.length < 2) throw new Error("这条记忆当前没有歧义候选");
      const candidates = result.candidates.slice(0, MAX_DISPLAYED_CANDIDATES).map((candidate, index) => ({ ...candidate, ref: `C${index + 1}` }));
      const reviewed = await locateAndVerifySource({ content: result.content, triggerText: result.trigger, createdAt: refreshed.state.entries.find((entry) => entry.id === entryId)?.sourceAt ?? 0 }, candidates, (messages) => llm.generateText(messages, {
        purpose: "memory-source-review",
        maxTokens: 4096,
        timeoutMs: 120_000,
        signal,
      }));
      if (signal.aborted || current !== preview || memory.view().revision !== preview.revision) throw new Error("来源判断已取消或记忆发生变化");
      const selected = reviewed?.candidates.length === 1 ? reviewed.candidates[0] : undefined;
      const recommendation = selected && reviewed ? {
        conversationId: selected.sessionId,
        messageId: selected.message.id,
        locateConfidence: reviewed.locateConfidence,
        verifyConfidence: reviewed.verifyConfidence,
      } : undefined;
      current = {
        ...preview,
        results: refreshed.results.map((item) => item.entryId === entryId ? { ...item, recommendation } : item),
      };
      return { recommended: Boolean(recommendation), multipleSupported: Boolean(reviewed && reviewed.candidates.length > 1), preview: publicPreview(current) };
    },
    clear() { current = undefined; },
  };
}
