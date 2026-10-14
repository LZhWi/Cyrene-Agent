import { describe, expect, it } from "vitest"
import { buildShadowSemanticPrompt, validateShadowSemantics } from "./long-term-shadow-semantic"
import { validateLongTermObservations, type LongTermShadowEvidence } from "./long-term-reflection-shadow"

const evidence: LongTermShadowEvidence[] = [0, 15, 30].map((day, i) => ({
  id: `e${i}`, content: "保存角色照片", sourceQuote: `我今天也保存了你好看的照片第${i}张`,
  sourceAt: Date.UTC(2026, 0, 1 + day), sourceEndAt: Date.UTC(2026, 0, 1 + day),
  grounding: "exact", primaryKind: "preference", sourceKeys: [`m${i}`],
}))
const observations = validateLongTermObservations({ observations: [{
  key: "photos", claim: "用户多次保存角色照片", scope: "recurring_pattern", confidence: 0.8,
  evidenceIds: evidence.map((e) => e.id), applicability: "照片话题", reason: "跨日期重复",
}] }, evidence).accepted
const review = { key: "photos", verdict: "supported", atomic: true, reason: "三段原文均支持保存照片",
  support: evidence.map((e) => ({ evidenceId: e.id, quote: e.sourceQuote })) }

describe("Shadow semantic gate", () => {
  it("accepts repeated direct quotations and preserves the original claim", () => {
    const result = validateShadowSemantics({ reviews: [review] }, observations, evidence)
    expect(result.accepted).toEqual(observations)
    expect(result.rejected).toEqual([])
  })
  it("does not promote a rejected compound claim", () => {
    expect(validateShadowSemantics({ reviews: [{ ...review, atomic: false }] }, observations, evidence).accepted).toEqual([])
    expect(validateShadowSemantics({ reviews: [{ ...review, verdict: "reject" }] }, observations, evidence).accepted).toEqual([])
  })
  it("rejects fabricated quotes, unknown ids and repeated support", () => {
    for (const support of [
      [{ evidenceId: "e0", quote: "这些照片每次都帮助我改善心情" }, ...review.support.slice(1)],
      [{ evidenceId: "missing", quote: evidence[0].sourceQuote }, ...review.support.slice(1)],
      [review.support[0], review.support[0], review.support[2]],
    ]) expect(validateShadowSemantics({ reviews: [{ ...review, support }] }, observations, evidence).accepted).toEqual([])
  })
  it("requires repeated evidence even when the model declares supported", () => {
    expect(validateShadowSemantics({ reviews: [{ ...review, support: review.support.slice(0, 1) }] }, observations, evidence).accepted).toEqual([])
  })
  it("fails closed on missing or duplicate reviews", () => {
    for (const reviews of [[], [review, review], [null]]) {
      expect(validateShadowSemantics({ reviews }, observations, evidence).accepted).toEqual([])
    }
  })
  it("asks for direct support for the entire claim rather than assembling subclaims", () => {
    const prompt = buildShadowSemanticPrompt(observations, evidence)
    expect(prompt).toContain("每段引文都直接支持完整 claim")
    expect(prompt).toContain("不得查看留出窗口")
  })
})
