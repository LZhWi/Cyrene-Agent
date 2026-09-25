import { normalizeStoredFacets, type MemoryFacets } from "./facets";
export const ENTRY_STATUSES = ["active", "aging", "archived", "superseded", "merged"] as const;
export interface Entry {
  id: string; content: string; quote: string; sourceAt: number; turnId: string; sessionId: string;
  pinned: boolean; status: typeof ENTRY_STATUSES[number]; editedAt?: number;
  validFrom?: number; validTo?: number; supersededBy?: string; mergedInto?: string;
  /** 与本条存在待裁决冲突的另一条插件记忆 ID。 */
  conflictWith?: string[];
  sourceEndAt?: number; isSummary?: boolean; subEntryIds?: string[];
  provenance?: "verified" | "legacy-unverified" | "legacy-user-attested" | "derived-source-verified" | "derived-reviewed";
  /** 旧系统没有消息 ID 时用于只读查找原始用户消息；匹配成功前不代表已核验来源。 */
  triggerText?: string;
  sourceQuote?: string;
  importance?: "low" | "medium" | "high";
  stability?: "one_off" | "situational" | "stable";
  certainty?: "explicit" | "inferred" | "uncertain";
  attribution?: "user_explicit" | "assistant_inferred" | "mixed";
  evidenceQuotes?: string[];
  contextSummary?: string;
  confidence?: number;
  reason?: string;
  facets?: MemoryFacets;
}
export function validateEntry(e: any): asserts e is Entry {
  if (!e || ![e.id, e.content, e.quote, e.turnId, e.sessionId].every((s) => typeof s === "string") || !e.id || !Number.isFinite(e.sourceAt) || typeof e.pinned !== "boolean" || !ENTRY_STATUSES.includes(e.status)) throw new Error("记忆条目损坏，拒绝覆盖");
  for (const key of ["validFrom", "validTo", "editedAt", "sourceEndAt"]) {
    if (e[key] !== undefined && (!Number.isFinite(e[key]) || e[key] < 0)) throw new Error("记忆时间字段损坏");
  }
  if (e.validFrom !== undefined && e.validTo !== undefined && e.validTo < e.validFrom) throw new Error("记忆有效期倒置");
  if (e.sourceEndAt !== undefined && e.sourceEndAt < e.sourceAt) throw new Error("记忆来源时间范围倒置");
  for (const key of ["supersededBy", "mergedInto"]) {
    if (e[key] !== undefined && (typeof e[key] !== "string" || !e[key] || e[key] === e.id)) throw new Error("记忆关联标识损坏");
  }
  if (e.conflictWith !== undefined && (!Array.isArray(e.conflictWith) || e.conflictWith.length < 1 || e.conflictWith.length > 20 || new Set(e.conflictWith).size !== e.conflictWith.length || e.conflictWith.some((id: unknown) => typeof id !== "string" || !id || id === e.id))) throw new Error("记忆冲突关联损坏");
  if (e.provenance !== undefined && !["verified", "legacy-unverified", "legacy-user-attested", "derived-source-verified", "derived-reviewed"].includes(e.provenance)) throw new Error("记忆来源状态损坏");
  if (e.isSummary !== undefined && typeof e.isSummary !== "boolean") throw new Error("记忆总结标记损坏");
  if (e.subEntryIds !== undefined && (!Array.isArray(e.subEntryIds) || e.subEntryIds.length < 1 || e.subEntryIds.length > 100 || new Set(e.subEntryIds).size !== e.subEntryIds.length || e.subEntryIds.some((id: unknown) => typeof id !== "string" || !id || id === e.id))) throw new Error("记忆总结来源损坏");
  if ((e.isSummary === true) !== (e.subEntryIds !== undefined)) throw new Error("记忆总结来源损坏");
  if (e.triggerText !== undefined && (typeof e.triggerText !== "string" || e.triggerText.length > 100000)) throw new Error("记忆触发片段损坏");
  if (e.sourceQuote !== undefined && (typeof e.sourceQuote !== "string" || e.sourceQuote.length > 500)) throw new Error("记忆原文片段损坏");
  if (e.importance !== undefined && !["low", "medium", "high"].includes(e.importance)) throw new Error("记忆重要性损坏");
  if (e.stability !== undefined && !["one_off", "situational", "stable"].includes(e.stability)) throw new Error("记忆稳定性损坏");
  if (e.certainty !== undefined && !["explicit", "inferred", "uncertain"].includes(e.certainty)) throw new Error("记忆确定性损坏");
  if (e.attribution !== undefined && !["user_explicit", "assistant_inferred", "mixed"].includes(e.attribution)) throw new Error("记忆归因损坏");
  if (e.evidenceQuotes !== undefined && (!Array.isArray(e.evidenceQuotes) || !e.evidenceQuotes.length || e.evidenceQuotes.some((quote: unknown) => typeof quote !== "string" || !quote.trim() || quote.length > 1000))) throw new Error("记忆证据片段损坏");
  if (e.contextSummary !== undefined && (typeof e.contextSummary !== "string" || !e.contextSummary.trim() || e.contextSummary.length > 1500)) throw new Error("记忆上下文摘要损坏");
  if (e.confidence !== undefined && (!Number.isFinite(e.confidence) || e.confidence < 0 || e.confidence > 1)) throw new Error("记忆置信度损坏");
  if (e.reason !== undefined && (typeof e.reason !== "string" || !e.reason.trim() || e.reason.length > 1500)) throw new Error("记忆理由损坏");
  if (e.facets !== undefined) normalizeStoredFacets(e.facets);
}
/** 置顶、恢复归档都不能绕过事实有效期和被取代关系。 */
export function isRecallable(e: Entry, now: number): boolean {
  return (e.status === "active" || e.status === "aging") && !e.supersededBy && !e.mergedInto &&
    (e.validFrom === undefined || e.validFrom <= now) && (e.validTo === undefined || e.validTo > now);
}
export function quoteLabel(e: Entry): string {
  if (e.provenance === "derived-reviewed") return "证据提示：这是用户确认的多来源总结；请结合关联证据核对。";
  if (e.provenance === "derived-source-verified") return "证据提示：子记忆来源时间已核对，但总结语义仍需结合各来源判断。";
  if (e.provenance === "legacy-unverified") return e.quote.trim() ? `旧系统来源片段（未核对原始对话）：${e.quote}` : "证据提示：旧系统未保存可核对的逐字原话。";
  if (e.provenance === "legacy-user-attested") return e.quote.trim() ? `用户确认已核验的旧库来源片段（未保存消息 ID）：${e.quote}` : "证据提示：用户确认旧库已核验，但本条未保存逐字原话或消息 ID。";
  const quote = e.sourceQuote?.trim() || e.triggerText?.trim() || e.quote.trim();
  return quote ? `用户原话：${quote}` : "证据提示：未保存逐字原话，摘要需核对，不能视为用户原话。";
}
