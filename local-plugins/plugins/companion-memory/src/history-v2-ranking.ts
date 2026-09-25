export interface HistoryV2Candidate {
  id: string;
  text: string;
  role: "user" | "assistant";
  score: number;
  parentId?: string;
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
  rerank(query: string, documents: string[]): Promise<Array<{ text: string; score: number }> | null>;
}): Promise<Array<T & { relevanceScore: number }> | null> {
  const { candidates, cleanUserQuery, expandedQuery, intentQuery, finalK } = input;
  if (!candidates.length) return [];
  const queries = intentQuery && intentQuery !== cleanUserQuery
    ? [{ query: cleanUserQuery, weight: 0.35 }, { query: intentQuery, weight: 0.65 }]
    : [{ query: cleanUserQuery, weight: 1 }];
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
  const evidenceRanked = candidates.map((candidate) => {
    const lexicalMatches = intentTerms.filter((term) => candidate.text.includes(term)).length;
    const baseScore = (fused.get(candidate.text) ?? 0) + Math.min(lexicalMatches, 2) * 0.016;
    const compactText = candidate.text.replace(/\s+/gu, " ").trim();
    let multiplier = 1;
    if (candidate.sentenceWindow) multiplier *= 1.06;
    else if (!candidate.parentId && compactText.length >= 140) multiplier *= 1.03;
    if (candidate.adjacent) multiplier *= 0.9;
    if (candidate.role === "assistant" && compactText.length < 140
      && /[?？]|(?:吗|呢|是不是|有没有|怎么样)[。！…]*$/u.test(compactText)) multiplier *= 0.86;
    let score = baseScore * multiplier;
    if (candidate.semanticEvidenceRank !== undefined) score += 0.4 / (9 + candidate.semanticEvidenceRank);
    if (candidate.rrfEvidenceRank !== undefined) score += 0.5 / (9 + candidate.rrfEvidenceRank);
    return { ...candidate, score, relevanceScore: relevanceScores.get(candidate.text) ?? Number.NEGATIVE_INFINITY };
  }).sort((left, right) => right.score - left.score);

  const originalById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
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
    const replaceIndex = selected.findIndex((item) => item.role === "assistant" && item.text.replace(/\s+/gu, " ").trim().length < 140
      && /[?？]|(?:吗|呢|是不是|有没有|怎么样)[。！…]*$/u.test(item.text.replace(/\s+/gu, " ").trim()));
    const adjacentIndex = replaceIndex >= 0 ? -1 : selected.findIndex((item) => item.adjacent);
    const target = replaceIndex >= 0 ? replaceIndex : adjacentIndex;
    if (target < 0) continue;
    selected[target] = parent;
    break;
  }
  return selected.filter((item) => item.relevanceScore >= -6);
}
