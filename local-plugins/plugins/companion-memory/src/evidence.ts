export interface Evidence {
  id: string; memoryId: string; quoteSnippet: string; createdAt: number;
  sourceStatus: "active" | "archived" | "deleted";
  conversationId?: string; messageIds?: string[];
  contextBeforeSnippet?: string; contextAfterSnippet?: string;
  provenance?: "verified" | "legacy-unverified" | "legacy-user-attested";
}
export function validateEvidence(records: unknown): asserts records is Evidence[] {
  if (!Array.isArray(records)) throw new Error("证据记录格式无效");
  const ids = new Set<string>();
  for (const e of records) {
    if (!e || ![e.id, e.memoryId, e.quoteSnippet].every((v) => typeof v === "string") || !e.id || !e.memoryId || ids.has(e.id) || !Number.isFinite(e.createdAt) || !["active", "archived", "deleted"].includes(e.sourceStatus)) throw new Error("证据记录损坏");
    ids.add(e.id);
    for (const key of ["conversationId", "contextBeforeSnippet", "contextAfterSnippet"]) if (e[key] !== undefined && typeof e[key] !== "string") throw new Error("证据来源字段损坏");
    if (e.messageIds !== undefined && (!Array.isArray(e.messageIds) || e.messageIds.some((id: unknown) => typeof id !== "string" || !id))) throw new Error("证据消息引用损坏");
    if (e.provenance !== undefined && !["verified", "legacy-unverified", "legacy-user-attested"].includes(e.provenance)) throw new Error("证据核验状态损坏");
  }
}
/** memoryId 是关联依据；孤立记录保留但不串到其他记忆，deleted 不参与检索或模型复核。 */
export function linkedEvidence(records: Evidence[], memoryId: string): Evidence[] {
  return records.filter((e) => e.memoryId === memoryId && e.sourceStatus !== "deleted" && e.quoteSnippet.trim());
}
export function evidenceContext(records: Evidence[], memoryId: string): string {
  const linked = linkedEvidence(records, memoryId);
  return linked.slice(0, 3).map((e) => `[关联证据片段 ${e.id}；${e.sourceStatus === "archived" ? "来源已归档" : "来源记录有效"}；${e.provenance === "verified" ? "已核对来源" : e.provenance === "legacy-user-attested" ? "用户确认旧库已核验，未保存消息 ID" : "未核对原始对话"}；记录时间 ${new Date(e.createdAt).toISOString()}]\n${e.quoteSnippet.slice(0, 1200)}`).join("\n");
}
