import type { SemanticCandidate } from "./semantic-candidates";
import type { SourceCandidate } from "./trigger-matcher";
import type { ReviewMessage as ProductionReviewMessage } from "../../plugins/companion-memory/src/source-review";
export { locateAndVerifySource, type GenerateReview, type LocatedSource } from "../../plugins/companion-memory/src/source-review";
export type ReviewMessage = ProductionReviewMessage;

/** Kimi K2.5/2.6 的短结构化复核关闭思考，避免思考内容挤占 JSON 输出预算。 */
export function kimiReviewRequest(model: string, messages: ReviewMessage[]) {
  return { model, messages, stream: false, max_tokens: 4096, response_format: { type: "json_object" }, thinking: { type: "disabled" } };
}

export function mergeReviewCandidates(semantic: SemanticCandidate[], nearby: SourceCandidate[], limit = 12): Array<SourceCandidate & { ref: string; score?: number }> {
  const seen = new Set<string>(), merged: Array<SourceCandidate & { ref: string; score?: number }> = [];
  for (const candidate of [...semantic, ...nearby]) {
    const key = `${candidate.sessionId}:${candidate.message.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const score = (candidate as SourceCandidate & { score?: unknown }).score;
    merged.push({ ...structuredClone(candidate), ref: `C${merged.length + 1}`, ...(typeof score === "number" ? { score } : {}) });
    if (merged.length >= limit) break;
  }
  return merged;
}
