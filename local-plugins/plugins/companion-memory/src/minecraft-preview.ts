import type { Turn } from "../../companion-chat/src/chat";
import { isRecallable, type Entry } from "./entries";
import { stripAssistantHiddenText } from "./derived-text";
import type { createMemory } from "./memory";
import type { HostHistoryMessage } from "./host-history-source";
interface PreviewDeps {
 view: ReturnType<typeof createMemory>["view"];
 hostSnapshot(signal: AbortSignal): Promise<HostHistoryMessage[]>;
 sourceEpoch(): number;
 hasPendingInvalidations(): boolean;
 validPrivateTurns?(turns: Turn[], signal: AbortSignal): Promise<string[]>;
 rankExisting?(query: string, entries: Entry[], signal: AbortSignal): Promise<string[]>;
 search(query: string, ids: string[], budget: number): { text: string };
}
const normalize = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[\p{P}\p{S}\s]/gu, "");
function score(query: string, text: string) {
  const q = normalize(query), t = normalize(text);
  if (!q) return 0;
  const terms2 = new Set(q.length < 2 ? [q] : Array.from({ length: q.length - 1 }, (_, i) => q.slice(i, i + 2)));
  return [...terms2].filter((term) => t.includes(term)).length;
}
function sameTurn(a: Turn, b: Turn) {
  return a.id === b.id && a.sessionId === b.sessionId && a.origin === b.origin && a.user === b.user && a.assistant === b.assistant && a.userAt === b.userAt && a.assistantAt === b.assistantAt && a.inputMessageId === b.inputMessageId && a.finalMessageId === b.finalMessageId;
}
function validHost(turn: Turn, messages: HostHistoryMessage[]) {
  if (turn.origin !== "host" || !turn.inputMessageId || !turn.finalMessageId) return false;
  const user = messages.find((m) => m.sessionId === turn.sessionId && m.id === turn.inputMessageId);
  const assistant = messages.find((m) => m.sessionId === turn.sessionId && m.id === turn.finalMessageId);
  return !!user && !!assistant && user.role === "user" && assistant.role === "assistant" && user.text === turn.user && assistant.text === turn.assistant && user.at === turn.userAt && assistant.at === turn.assistantAt;
}
export function createMinecraftMemoryReader(deps: PreviewDeps) {
  return async (method: string, data: unknown, signal: AbortSignal) => {
    signal.throwIfAborted();
    if (method !== "peek-minecraft-memory") throw new Error("不支持的 Minecraft 只读请求");
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Minecraft 请求无效");
    const value = data as Record<string, unknown>;
    if (value.consent !== true || typeof value.query !== "string" || !value.query.trim() || value.query.length > 1e3 || Object.keys(value).some((k) => !["query", "consent"].includes(k))) throw new Error("需要明确的 Minecraft 公开上下文授权");
    const query = value.query, epoch = deps.sourceEpoch();
    const guard = () => {
      signal.throwIfAborted();
      if (deps.hasPendingInvalidations() || epoch !== deps.sourceEpoch()) throw new Error("记忆来源已变更，请重新查询");
    };
    guard();
    const before = deps.view();
    const initialHost = await deps.hostSnapshot(signal);
    guard();
    const privateCandidates = before.turns.filter((t) => t.origin === "companion-chat" || t.origin === void 0).sort((a, b) => score(query, b.user + b.assistant) - score(query, a.user + a.assistant) || b.assistantAt - a.assistantAt).slice(0, 200);
    const privateIds = new Set(deps.validPrivateTurns ? await deps.validPrivateTurns(privateCandidates, signal) : []);
    guard();
    const initiallyValid = new Set(before.turns.filter((t) => t.origin === "host" ? validHost(t, initialHost) : (t.origin === "companion-chat" || t.origin === void 0) && privateIds.has(t.id)).map((t) => t.id));
    let semanticIds: string[] = [];
    if (deps.rankExisting) {
      try {
        semanticIds = await deps.rankExisting(query, before.entries.filter((e) => isRecallable(e, Date.now()) && !e.isSummary && !e.legacySource && initiallyValid.has(e.turnId) && (e.sourceEvidence ?? []).every((source) => initiallyValid.has(source.turnId))).slice(0, 1e3), signal);
      } catch {
        guard();
      }
      guard();
    }
    const currentHost = await deps.hostSnapshot(signal);
    guard();
    await new Promise<void>((resolve) => setImmediate(resolve));
    guard();
    const current = deps.view();
    const validTurns = current.turns.filter((t) => {
      const original = before.turns.find((old) => old.id === t.id);
      if (!original || !sameTurn(original, t)) return false;
      return t.origin === "host" ? validHost(t, currentHost) && validHost(t, initialHost) : (t.origin === "companion-chat" || t.origin === void 0) && privateIds.has(t.id);
    });
    const byId = new Map(validTurns.map((t) => [t.id, t]));
    const ids = current.entries.filter((e) => isRecallable(e, Date.now()) && !e.isSummary && !e.legacySource && e.provenance !== "legacy-unverified" && e.provenance !== "legacy-user-attested" && byId.get(e.turnId)?.sessionId === e.sessionId && (e.sourceEvidence ?? []).every((source) => byId.has(source.turnId))).map((e) => {
      const old = before.entries.find((candidate) => candidate.id === e.id);
      const semanticRank = old?.content === e.content && old?.quote === e.quote ? semanticIds.indexOf(e.id) : -1;
      return { id: e.id, score: score(query, e.content + e.quote) + (semanticRank >= 0 ? 100 - Math.min(semanticRank, 99) : 0) };
    }).filter((e) => e.score > 0).sort((a, b) => b.score - a.score).slice(0, 8).map((e) => e.id);
    const memoryText = deps.search(query, ids, 12e3).text;
    const initialById = new Map(initialHost.map((m) => [`${m.sessionId}\0${m.id}`, m]));
    const history = currentHost.filter((m) => {
      const initial = initialById.get(`${m.sessionId}\0${m.id}`);
      return initial && initial.text === m.text && initial.at === m.at && initial.role === m.role;
    }).map((m) => ({
      key: `host:${m.sessionId}:${m.id}`,
      at: m.at,
      text: `${m.role === "user" ? "用户" : "助手"}：${m.role === "assistant" ? stripAssistantHiddenText(m.text) : m.text}`
    }));
    history.push(...validTurns.filter((t) => t.origin !== "host").map((t) => ({
      key: `private:${t.id}`,
      at: t.userAt,
      text: `用户：${t.user}
助手：${stripAssistantHiddenText(t.assistant)}`
    })));
    const ranked = history.map((h) => ({ ...h, score: score(query, h.text) })).filter((h) => h.score > 0).sort((a, b) => b.score - a.score || b.at - a.at).slice(0, 8);
    let historyText = "";
    for (const item of ranked) {
      const block = `[历史 ${item.key}；${new Date(item.at).toISOString()}，仅代表当时陈述]
${item.text}

`;
      if (historyText.length + block.length <= 12e3) historyText += block;
    }
    guard();
    return { version: 1, source: "companion-memory", memoryText, historyText: historyText.trim() };
  };
}
