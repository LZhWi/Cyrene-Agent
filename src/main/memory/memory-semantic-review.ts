/** Lexical signals request model review; they are not semantic verdicts. */
export interface SemanticCandidate {
  content?: string;
  summary?: string;
  evidenceQuotes?: string[];
  reason?: string;
  forbiddenOverclaims?: string[];
  shouldWrite?: boolean;
  memoryAction?: string;
  targetMemoryId?: string;
  replaceText?: string;
  layer?: string;
  field?: string;
}

function signals(text: string): string[] {
  // Count words and degree phrases are not universal claims.
  const value = text.replace(/[一二三四五六七八九十两几数多半]只/gu, "")
    .replace(/有一定(?:的)?/gu, "");
  return [...new Set(value.match(/只(?:是)?|永远|从不|一定|完全|绝对|以后都|不再|所有|总是|从来|不一定|未必|可能|也许|没有|不是|并非|不|没|未|无/gu) ?? [])];
}

export function semanticRisk(candidate: SemanticCandidate): string | undefined {
  const summary = candidate.summary ?? candidate.content ?? "";
  const quotes = candidate.evidenceQuotes ?? [];
  if (candidate.shouldWrite === false || candidate.memoryAction === "keep") return;
  if (candidate.forbiddenOverclaims?.length) return "模型标记了可能过度概括的内容";
  // Verbatim claims do not acquire new scope or lose a negation through paraphrase.
  if (quotes.some(quote => quote === summary) && summary) return;
  const summarySignals = signals(summary), evidenceSignals = signals(quotes.join("\n"));
  const strong = /只|永远|从不|一定|完全|绝对|以后都|不再|所有|总是|从来/u;
  if (summarySignals.some(term => strong.test(term))) return "摘要包含范围、程度或确定性措辞，需核对其语义是否被原文支持";
  if (evidenceSignals.some(term => !summarySignals.includes(term))) return "原文的否定、条件或不确定性可能在摘要中丢失";
}

function key(candidate: SemanticCandidate): string {
  return JSON.stringify([candidate.memoryAction ?? "add", candidate.targetMemoryId ?? "",
    candidate.replaceText, candidate.layer, candidate.field, candidate.summary ?? candidate.content, candidate.evidenceQuotes]);
}

/** Only the bounded follow-up may confirm the exact summary/evidence pair it was asked to review. */
export function requireSemanticReview(candidates: SemanticCandidate[], requested: Set<string>, followUp: boolean): void {
  const risks = candidates.flatMap(candidate => {
    const issue = semanticRisk(candidate);
    if (!issue) return [];
    if (followUp && requested.has(key(candidate)) && /^语义复核通过：\s*\S.{5,}/u.test(candidate.reason ?? "")
      && !candidate.forbiddenOverclaims?.length) return [];
    if (!followUp) requested.add(key(candidate));
    return [{ summary: candidate.summary ?? candidate.content, evidenceQuotes: candidate.evidenceQuotes, issue }];
  });
  if (risks.length) throw new Error("需要语义复核（词语命中不代表错误）：" + JSON.stringify(risks)
    + "。核对否定、条件、时间、范围和确定性；有依据的同义转述允许保留，reason 用「语义复核通过：」开头并具体说明原文如何支持摘要。"
    + "无依据则改写；无法判断的新候选可省略，旧记忆用 keep。重新输出完整结果，不要丢失其他候选。不要为通过检查机械删除词语。");
}
