import type { SourceCandidate, SourceSession } from "./trigger-matcher";

export interface StoredVector {
  id: string; text: string; source: "chat_history" | "user_memory"; embedding: number[];
  metadata?: { sessionId?: string; role?: string; ts?: number; l2Id?: string };
}
export interface SemanticCandidate extends SourceCandidate { score: number; method: "stored-vector" }

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || !a.length) throw new Error("向量维度不一致");
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) {
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) throw new Error("向量包含非法数值");
    dot += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i];
  }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}

/** 只使用能回查到正式用户消息的预计算向量；不触发 RAG、Embedding 或召回记账。 */
export function storedSemanticCandidates(l2Id: string, vectors: StoredVector[], sessions: SourceSession[], limit = 8): SemanticCandidate[] {
  if (!l2Id || !Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error("候选参数无效");
  const query = vectors.find((v) => v.source === "user_memory" && v.metadata?.l2Id === l2Id);
  if (!query) return [];
  const sessionsById = new Map(sessions.map((s) => [s.id, s]));
  const candidates: SemanticCandidate[] = [];
  for (const vector of vectors) {
    if (vector.source !== "chat_history" || vector.metadata?.role !== "user" || typeof vector.metadata.sessionId !== "string" || !Number.isFinite(vector.metadata.ts)) continue;
    const session = sessionsById.get(vector.metadata.sessionId);
    if (!session) continue;
    const indices = session.messages.flatMap((m, index) => m.role === "user" && m.at === vector.metadata!.ts && m.content === vector.text ? [index] : []);
    // 相同时间和文本仍对应多条消息时不猜，陈旧向量也不使用。
    if (indices.length !== 1) continue;
    const index = indices[0], message = session.messages[index];
    const key = `${session.id}:${message.id}`;
    candidates.push({ sessionId: session.id, message, ...(index ? { previous: session.messages[index - 1] } : {}), ...(index + 1 < session.messages.length ? { next: session.messages[index + 1] } : {}), score: cosine(query.embedding, vector.embedding), method: "stored-vector" });
  }
  const seen = new Set<string>();
  return structuredClone(candidates.sort((a, b) => b.score - a.score || b.message.at - a.message.at).filter((candidate) => {
    const key = `${candidate.sessionId}:${candidate.message.id}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).slice(0, limit));
}
