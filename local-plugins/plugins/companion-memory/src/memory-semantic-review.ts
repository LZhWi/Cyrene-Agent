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

