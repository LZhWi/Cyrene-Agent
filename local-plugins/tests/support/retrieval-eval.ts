export interface RetrievalEvalCase {
  name: string;
  relevantIds: string[];
  result: string;
}

export function memoryOrder(result: string): string[] {
  return [...result.matchAll(/^\[记忆 ([^；\]]+)/gm)].map((match) => match[1]);
}

export function evaluateRetrieval(cases: RetrievalEvalCase[], k = 3) {
  if (!cases.length || !Number.isSafeInteger(k) || k < 1) throw new Error("评测参数无效");
  let hitAt1 = 0, recallAtK = 0, reciprocalRank = 0;
  const details = cases.map((item) => {
    const order = memoryOrder(item.result), relevant = new Set(item.relevantIds);
    const rank = order.findIndex((id) => relevant.has(id)) + 1;
    if (rank === 1) hitAt1++;
    if (rank > 0 && rank <= k) recallAtK++;
    if (rank > 0) reciprocalRank += 1 / rank;
    return { name: item.name, order, firstRelevantRank: rank || undefined };
  });
  return {
    cases: cases.length,
    hitAt1: hitAt1 / cases.length,
    recallAtK: recallAtK / cases.length,
    mrr: reciprocalRank / cases.length,
    details,
  };
}
