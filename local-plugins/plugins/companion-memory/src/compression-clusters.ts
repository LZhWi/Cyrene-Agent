import type { Entry } from "./entries";
import { isRecallable } from "./entries";

interface SimilarPair { leftId: string; rightId: string; score: number }

/** 复现上游 aging 向量聚类的候选层；只返回分组，不调用模型或修改状态。 */
export function findCompressionClusters(entries: Entry[], pairs: SimilarPair[], maxGroups = 5) {
  if (!Number.isSafeInteger(maxGroups) || maxGroups < 1 || maxGroups > 20) throw new Error("压缩聚类参数无效");
  const eligible = entries.filter((entry) => entry.status === "aging" && !entry.pinned && !entry.isSummary && !entry.supersededBy && !entry.mergedInto && isRecallable(entry, Date.now()));
  const byId = new Map(eligible.map((entry) => [entry.id, entry])), scores = new Map<string, number>();
  for (const pair of pairs) {
    if (!byId.has(pair.leftId) || !byId.has(pair.rightId) || pair.leftId === pair.rightId || !Number.isFinite(pair.score) || pair.score < 0.82 || pair.score > 1) continue;
    scores.set([pair.leftId, pair.rightId].sort().join("\u0000"), pair.score);
  }
  const used = new Set<string>(), groups: Array<{ entryIds: string[]; minimumScore: number }> = [];
  for (const seed of eligible) {
    if (used.has(seed.id)) continue;
    const neighbors = eligible.filter((entry) => !used.has(entry.id) && entry.id !== seed.id && scores.has([seed.id, entry.id].sort().join("\u0000"))).sort((a, b) => (scores.get([seed.id, b.id].sort().join("\u0000")) ?? 0) - (scores.get([seed.id, a.id].sort().join("\u0000")) ?? 0)).slice(0, 4);
    if (neighbors.length < 2) continue;
    const entryIds = [seed.id, ...neighbors.map((entry) => entry.id)], minimumScore = Math.min(...neighbors.map((entry) => scores.get([seed.id, entry.id].sort().join("\u0000"))!));
    entryIds.forEach((id) => used.add(id)); groups.push({ entryIds, minimumScore });
    if (groups.length >= maxGroups) break;
  }
  return groups;
}
