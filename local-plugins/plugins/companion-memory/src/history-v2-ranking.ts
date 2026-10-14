export interface HistoryV2Candidate {
  id: string;
  text: string;
  role: "user" | "assistant";
  score: number;
  parentId?: string;
  sessionId?: string;
  turnId?: string;
  adjacent?: boolean;
  sentenceWindow?: boolean;
  semanticEvidenceRank?: number;
  rrfEvidenceRank?: number;
}

export async function rerankHistoryV2<T extends HistoryV2Candidate>(input: {
  candidates: T[];
  cleanUserQuery: string;
  expandedQuery: string;
  intentQuery: string;
  finalK: number;
  supplementK?: 0 | 3;
  onScored?: (rows: Array<{text: string; score: number; relevanceScore: number}>) => void;
  rerank(query: string, documents: string[]): Promise<Array<{ text: string; score: number }> | null>;
}): Promise<Array<T & { relevanceScore: number }> | null> {
  const { candidates, cleanUserQuery, expandedQuery, finalK } = input;
  if (!candidates.length) return [];
  // Expanded queries retrieve candidates; reranking preserves the user's original question.
  const queries = [{ query: cleanUserQuery, weight: 1 }];
  const documents = candidates.map((candidate) => candidate.text);
  const rankings = await Promise.all(queries.map((item) => input.rerank(item.query, documents)));
  if (rankings.some((ranking) => ranking === null)) return null;
  const fused = new Map<string, number>(), relevanceScores = new Map<string, number>();
  rankings.forEach((ranking, queryIndex) => ranking!.forEach((item, rankIndex) => {
    fused.set(item.text, (fused.get(item.text) ?? 0) + queries[queryIndex].weight / (8 + rankIndex + 1));
    relevanceScores.set(item.text, (relevanceScores.get(item.text) ?? 0) + queries[queryIndex].weight * item.score);
  }));
  const intentTerms = expandedQuery.startsWith(`${cleanUserQuery} `)
    ? expandedQuery.slice(cleanUserQuery.length + 1).split(/\s+/u).filter((term) => term.length >= 2)
    : [];
  const baseScores: Array<{text: string; score: number; relevanceScore: number}> = [];
  const evidenceRanked = candidates.map((candidate) => {
    const lexicalMatches = intentTerms.filter((term) => candidate.text.includes(term)).length;
    const baseScore = (fused.get(candidate.text) ?? 0) + Math.min(lexicalMatches, 2) * 0.016;
    baseScores.push({text: candidate.text, score: baseScore, relevanceScore: relevanceScores.get(candidate.text) ?? Number.NEGATIVE_INFINITY});
    const compactText = candidate.text.replace(/\s+/gu, " ").trim();
    let multiplier = 1;
    if (candidate.sentenceWindow) multiplier *= 1.06;
    else if (!candidate.parentId && compactText.length >= 140) multiplier *= 1.03;
    if (candidate.adjacent) multiplier *= 0.9;
    let score = baseScore * multiplier;
    if (candidate.semanticEvidenceRank !== undefined) score += 0.4 / (9 + candidate.semanticEvidenceRank);
    if (candidate.rrfEvidenceRank !== undefined) score += 0.5 / (9 + candidate.rrfEvidenceRank);
    return { ...candidate, score, relevanceScore: relevanceScores.get(candidate.text) ?? Number.NEGATIVE_INFINITY };
  }).sort((left, right) => right.score - left.score);

  const originalById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  try { input.onScored?.(baseScores); } catch { /* Observation cannot affect ranking. */ }
  const groupKey = (candidate: T) => candidate.parentId ? originalById.get(candidate.parentId)?.text ?? candidate.text : candidate.text;
  const chosen = new Map<string, typeof evidenceRanked[number]>(), deduped: typeof evidenceRanked = [];
  for (const candidate of evidenceRanked) {
    const key = groupKey(candidate);
    const existing = chosen.get(key);
    if (!existing) {
      chosen.set(key, candidate);
      deduped.push(candidate);
    } else if (existing.sentenceWindow && candidate.text === key) {
      deduped[deduped.findIndex((item) => item.id === existing.id)] = candidate;
      chosen.set(key, candidate);
    }
  }
  const selected = deduped.slice(0, finalK), deferred = deduped.slice(finalK);
  const cutoffScore = selected.at(-1)?.score ?? 0;
  for (const role of ["user", "assistant"] as const) {
    if (selected.filter((item) => item.role === role).length >= 2) continue;
    const replacement = deferred.find((item) => item.role === role && item.score >= cutoffScore * 0.8);
    if (!replacement) continue;
    const replaceIndex = [...selected].reverse().findIndex((item) => item.role !== role
      && selected.filter((selectedItem) => selectedItem.role === item.role).length > 2);
    if (replaceIndex >= 0) selected[selected.length - 1 - replaceIndex] = replacement;
  }
  const selectedIdsBeforePromotion = new Set(selected.map((item) => item.id));
  const parentIds = [...new Set(selected.flatMap((item) => item.parentId ? [item.parentId] : []))];
  for (const parentId of parentIds) {
    if (selectedIdsBeforePromotion.has(parentId)) continue;
    const parent = deferred.find((item) => item.id === parentId && item.score >= cutoffScore * 0.75);
    if (!parent) continue;
    const target = selected.findIndex((item) => item.adjacent);
    if (target < 0) continue;
    selected[target] = parent;
    break;
  }
  const baseline = selected.filter((item) => item.relevanceScore >= -6);
  if (!input.supplementK) return baseline;
  // Append only; rejected extra slots are not refilled or used to replace baseline evidence.
  const sourceKey = (item: T) => item.sessionId && item.turnId
    ? JSON.stringify([item.sessionId, item.turnId]) : item.parentId ?? item.id;
  const seen = new Set(baseline.map(sourceKey));
  const extras: typeof evidenceRanked = [];
  for (const item of deduped) {
    const key = sourceKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    extras.push(item);
    if (extras.length === input.supplementK) break;
  }
  return [...baseline, ...extras.filter((item) => item.relevanceScore >= -6)];
}
