import type { Entry } from "./entries";

export type ConflictEvidenceLevel = "none" | "one_side" | "both";
export type ConflictResolverPriority = "none" | "idle" | "normal" | "high";

export interface ConflictScoreResult {
  conflictScore: number;
  resolverPriority: ConflictResolverPriority;
  scoringSignals: {
    correctionIntent: boolean;
    ragCandidate: boolean;
    recentInjection: boolean;
    evidenceAvailable: boolean;
    localContradiction: boolean;
    impactScope: "low" | "medium" | "high";
    penalties: string[];
  };
}

const CONTRADICTION_PAIRS: Array<[string, string[]]> = [
  ["喜欢", ["不喜欢", "讨厌", "反感", "厌恶", "不再喜欢"]],
  ["爱", ["不爱", "讨厌", "恨"]],
  ["想", ["不想", "别想", "不愿"]],
  ["要", ["不要", "别要"]],
  ["是", ["不是", "并非"]],
  ["可以", ["不可以", "不行", "不能"]],
  ["会", ["不会"]],
  ["有", ["没有", "没了", "无"]],
  ["忙", ["不忙", "闲"]],
];
const STOP_TERMS = new Set(["用户", "一个", "一种", "这个", "那个", "自己", "因为", "所以", "但是", "没有", "不是", "不会", "不能", "不喜", "喜欢", "讨厌", "反感", "厌恶", "不爱", "不想", "不要", "不行", "没了", "不忙"]);
const CORRECTION_PHRASES = ["不是这样", "你记错了", "记错了", "我现在不这样", "现在不这样", "我说错了", "之前说错了", "纠正一下", "更正一下"];

function topicTerms(text: string) {
  const terms = new Set<string>();
  for (const raw of text.match(/[\u4e00-\u9fff]{2,}|[a-zA-Z0-9]{3,}/g) ?? []) {
    const term = raw.toLowerCase();
    if (STOP_TERMS.has(term)) continue;
    terms.add(term);
    if (/^[\u4e00-\u9fff]+$/.test(term) && term.length > 2) for (let i = 0; i <= term.length - 2; i++) {
      const gram = term.slice(i, i + 2);
      if (!STOP_TERMS.has(gram)) terms.add(gram);
    }
  }
  return terms;
}

export function findPossibleConflictCandidate(fresh: string, existing: string) {
  const left = topicTerms(fresh), right = topicTerms(existing);
  if (![...left].some((term) => right.has(term))) return { isCandidate: false, confidence: 0 };
  const a = fresh.toLowerCase(), b = existing.toLowerCase();
  for (const [positive, negatives] of CONTRADICTION_PAIRS) {
    if ((a.includes(positive) && negatives.some((value) => b.includes(value))) || (b.includes(positive) && negatives.some((value) => a.includes(value)))) {
      return { isCandidate: true, reason: `possible shared-topic lexical contradiction: ${positive}`, confidence: 0.35 };
    }
  }
  return { isCandidate: false, confidence: 0 };
}

export const hasCorrectionIntent = (text: string) => CORRECTION_PHRASES.some((phrase) => text.includes(phrase));
export function isExplicitGoalCompletion(content: string, triggerText: string, kind: string | undefined): boolean {
  if (kind !== "experience" && kind !== "fact") return false;
  return /(?:已经|终于|刚刚|顺利|成功|目前已|现在已).{0,12}(?:完成|做完|实现|达成|学会|结束|通过|毕业)|(?:完成了|做完了|实现了|达成了|学会了|结束了|通过了|毕业了)/u.test(`${content} ${triggerText}`);
}
export const impactScope = (entry: Entry): "low" | "medium" | "high" => entry.pinned ? "high" : entry.status === "active" ? "medium" : "low";

export function scoreMemoryConflict(input: {
  ragScore?: number; correctionIntent?: boolean; recentInjection?: boolean; localContradiction?: boolean;
  evidence: ConflictEvidenceLevel; activeTarget: boolean; impactScope?: "low" | "medium" | "high"; recentlyResolvedSamePair?: boolean;
}): ConflictScoreResult {
  const penalties: string[] = [];
  let score = 0;
  if (input.correctionIntent) score += 20;
  if (input.ragScore !== undefined) score += input.ragScore >= 0.75 ? 25 : input.ragScore >= 0.45 ? 18 : 10;
  if (input.recentInjection) score += 20;
  score += input.evidence === "both" ? 15 : input.evidence === "one_side" ? 8 : 0;
  if (input.localContradiction) score += 10;
  score += input.impactScope === "high" ? 10 : input.impactScope === "medium" ? 6 : input.impactScope === "low" ? 3 : 0;
  if (!input.activeTarget) { score -= 25; penalties.push("archived_only_target"); }
  if (input.evidence === "none") { score -= 20; penalties.push("missing_evidence"); }
  if (input.recentlyResolvedSamePair) { score -= 25; penalties.push("recently_resolved_same_pair"); }
  const conflictScore = Math.max(0, Math.min(100, Math.round(score)));
  let resolverPriority: ConflictResolverPriority = conflictScore >= 75 ? "high" : conflictScore >= 55 ? "normal" : conflictScore >= 35 ? "idle" : "none";
  if (!input.activeTarget || input.evidence === "none") resolverPriority = "none";
  return { conflictScore, resolverPriority, scoringSignals: { correctionIntent: input.correctionIntent === true, ragCandidate: input.ragScore !== undefined, recentInjection: input.recentInjection === true, evidenceAvailable: input.evidence !== "none", localContradiction: input.localContradiction === true, impactScope: input.impactScope ?? "low", penalties } };
}
