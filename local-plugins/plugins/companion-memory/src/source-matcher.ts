export interface SourceMessage {
  id: string;
  /** model 为旧只读评测投影；宿主 Conversations 服务使用 assistant。 */
  role: "user" | "assistant" | "model";
  content: string;
  at: number;
}

export interface SourceSession { id: string; messages: SourceMessage[] }
export interface SourceCandidate { sessionId: string; message: SourceMessage; previous?: SourceMessage; next?: SourceMessage }
export interface TriggerMatch {
  method: "exact" | "normalized-exact" | "ambiguous" | "no-match" | "empty-trigger" | "no-history";
  candidates: SourceCandidate[];
}

const normalize = (text: string) => text.normalize("NFC").replace(/\r\n?/gu, "\n").trim();
const loose = (text: string) => normalize(text).replace(/[\s\p{P}\p{S}]/gu, "");

/** 只匹配用户消息。多条逐字命中必须全部保留，不能按时间擅自选一个。 */
export function matchTrigger(triggerText: string, sessions: SourceSession[]): TriggerMatch {
  const trigger = normalize(triggerText);
  if (!trigger) return { method: "empty-trigger", candidates: [] };
  const users = sessions.flatMap((session) => session.messages.flatMap((message, index) => message.role === "user"
    ? [{ sessionId: session.id, message, ...(index > 0 ? { previous: session.messages[index - 1] } : {}), ...(index + 1 < session.messages.length ? { next: session.messages[index + 1] } : {}) }]
    : []));
  if (!users.length) return { method: "no-history", candidates: [] };
  const exact = users.filter((candidate) => normalize(candidate.message.content).includes(trigger));
  if (exact.length === 1) return { method: "exact", candidates: structuredClone(exact) };
  if (exact.length > 1) return { method: "ambiguous", candidates: structuredClone(exact) };
  const normalized = loose(trigger);
  const matches = normalized.length >= 4 ? users.filter((candidate) => loose(candidate.message.content).includes(normalized)) : [];
  return { method: matches.length === 1 ? "normalized-exact" : matches.length > 1 ? "ambiguous" : "no-match", candidates: structuredClone(matches) };
}

/** 时间邻近只产生待复核候选，不代表来源已经成立。 */
export function nearbyCandidates(createdAt: number, sessions: SourceSession[], limit = 4): SourceCandidate[] {
  if (!Number.isFinite(createdAt)) return [];
  const all = sessions.flatMap((session) => session.messages.flatMap((message, index) => message.role === "user"
    ? [{ sessionId: session.id, message, ...(index > 0 ? { previous: session.messages[index - 1] } : {}), ...(index + 1 < session.messages.length ? { next: session.messages[index + 1] } : {}) }]
    : []));
  return structuredClone(all.sort((a, b) => Math.abs(a.message.at - createdAt) - Math.abs(b.message.at - createdAt)).slice(0, limit));
}
