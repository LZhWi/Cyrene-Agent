import type { Entry } from "./entries";
import { isRecallable } from "./entries";

interface SimilarPair { leftId: string; rightId: string; score: number }
export interface CompressionClusterOptions {
  status?: "active" | "aging";
  minimumScore?: number;
  maxGroups?: number;
}

/** 复现本地压缩候选层；只返回分组，不调用模型或修改状态。 */
export function findCompressionClusters(entries: Entry[], pairs: SimilarPair[], options: CompressionClusterOptions = {}) {
  const status = options.status ?? "aging";
  const minimumScore = options.minimumScore ?? (status === "active" ? 0.85 : 0.82);
  const maxGroups = options.maxGroups ?? 5;
  if (!Number.isSafeInteger(maxGroups) || maxGroups < 1 || maxGroups > 20) throw new Error("压缩聚类参数无效");
  if (!Number.isFinite(minimumScore) || minimumScore < 0 || minimumScore > 1) throw new Error("压缩聚类参数无效");
  const eligible = entries.filter((entry) => entry.status === status && !entry.pinned && !entry.isSummary && !entry.supersededBy && !entry.mergedInto && isRecallable(entry, Date.now()));
  const byId = new Map(eligible.map((entry) => [entry.id, entry])), scores = new Map<string, number>();
  for (const pair of pairs) {
    if (!byId.has(pair.leftId) || !byId.has(pair.rightId) || pair.leftId === pair.rightId || !Number.isFinite(pair.score) || pair.score < minimumScore || pair.score > 1) continue;
    scores.set([pair.leftId, pair.rightId].sort().join("\u0000"), pair.score);
  }
  const used = new Set<string>(), groups: Array<{ entryIds: string[]; minimumScore: number }> = [];
  for (const seed of eligible) {
    if (used.has(seed.id)) continue;
    // 本地常规压缩使用全组凝聚约束；梦境压缩则只比较种子记忆。
    const members = [seed];
    for (const candidate of eligible) {
      if (used.has(candidate.id) || candidate.id === seed.id || members.length >= 100) continue;
      const references = status === "active" ? members : [seed];
      const cohesive = references.every((member) => scores.has([member.id, candidate.id].sort().join("\u0000")));
      if (cohesive) members.push(candidate);
    }
    if (members.length < 3) continue;
    const entryIds = members.map((entry) => entry.id);
    const groupScore = Math.min(...members.slice(1).map((entry) => scores.get([seed.id, entry.id].sort().join("\u0000"))!));
    entryIds.forEach((id) => used.add(id)); groups.push({ entryIds, minimumScore: groupScore });
    if (groups.length >= maxGroups) break;
  }
  return groups;
}
