import { normalizeStoredFacets, type MemoryFacets } from "./facets";
export const ENTRY_STATUSES = ["active", "aging", "archived", "superseded", "merged"] as const;
export interface Entry {
  id: string; content: string; quote: string; sourceAt: number; turnId: string; sessionId: string;
  pinned: boolean; status: typeof ENTRY_STATUSES[number]; editedAt?: number;
  validFrom?: number; validTo?: number; supersededBy?: string; mergedInto?: string;
  sourceEndAt?: number; isSummary?: boolean; subEntryIds?: string[];
  provenance?: "verified" | "legacy-unverified" | "legacy-user-attested" | "derived-source-verified" | "derived-reviewed";
  /** 旧系统没有消息 ID 时用于只读查找原始用户消息；匹配成功前不代表已核验来源。 */
  triggerText?: string;
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
  if (e.provenance !== undefined && !["verified", "legacy-unverified", "legacy-user-attested", "derived-source-verified", "derived-reviewed"].includes(e.provenance)) throw new Error("记忆来源状态损坏");
  if (e.isSummary !== undefined && typeof e.isSummary !== "boolean") throw new Error("记忆总结标记损坏");
  if (e.subEntryIds !== undefined && (!Array.isArray(e.subEntryIds) || e.subEntryIds.length < 1 || e.subEntryIds.length > 100 || new Set(e.subEntryIds).size !== e.subEntryIds.length || e.subEntryIds.some((id: unknown) => typeof id !== "string" || !id || id === e.id))) throw new Error("记忆总结来源损坏");
  if ((e.isSummary === true) !== (e.subEntryIds !== undefined)) throw new Error("记忆总结来源损坏");
  if (e.triggerText !== undefined && (typeof e.triggerText !== "string" || e.triggerText.length > 100000)) throw new Error("记忆触发片段损坏");
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
  return e.quote.trim() ? `用户原话：${e.quote}` : "证据提示：未保存逐字原话，摘要需核对，不能视为用户原话。";
}
