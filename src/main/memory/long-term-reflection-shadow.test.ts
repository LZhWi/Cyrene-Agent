import { describe, expect, it } from "vitest"
import {
  parseJsonObject,
  parseJsonArray,
  buildSemanticCandidateGroups,
  validateLongTermAudits,
  validateLongTermObservations,
  type LongTermShadowEvidence,
} from "./long-term-reflection-shadow"

const day = 24 * 60 * 60 * 1000
const base = Date.UTC(2026, 0, 1)
const evidence: LongTermShadowEvidence[] = [0, 15, 30, 45].map((offset, index) => ({
  id: `l2-${index + 1}`,
  content: `记忆 ${index + 1}`,
  sourceQuote: `原文 ${index + 1}`,
  sourceAt: base + offset * day,
  sourceEndAt: base + offset * day,
  primaryKind: "preference",
  grounding: "exact",
}))

describe("long-term reflection shadow validation", () => {
  it("accepts a grounded multi-date observation and derives its real source range", () => {
    const result = validateLongTermObservations({ observations: [{
      key: "steady",
      claim: "长期规律",
      scope: "recurring_pattern",
      confidence: 0.8,
      evidenceIds: ["l2-1", "l2-2", "l2-3"],
      applicability: "相关话题",
      reason: "跨月重复",
    }] }, evidence)
    expect(result.rejected).toEqual([])
    expect(result.accepted[0]).toMatchObject({ firstSeenAt: base, lastSeenAt: base + 30 * day, distinctDates: 3 })
  })

  it("rejects fabricated ids, short spans and unmatched evidence", () => {
    const ungrounded = evidence.map((item, index) => index === 2 ? { ...item, grounding: "unmatched" as const } : item)
    const fabricated = validateLongTermObservations({ observations: [{
      key: "fake", claim: "伪造", scope: "stable_preference", confidence: 0.9,
      evidenceIds: ["l2-1", "l2-2", "missing"],
    }] }, evidence)
    expect(fabricated.rejected[0].reason).toContain("unknown evidence ids")
    const unmatched = validateLongTermObservations({ observations: [{
      key: "ungrounded", claim: "无来源", scope: "stable_preference", confidence: 0.9,
      evidenceIds: ["l2-1", "l2-2", "l2-3"],
    }] }, ungrounded)
    expect(unmatched.rejected[0].reason).toBe("contains an ungrounded memory")
  })

  it("only accepts audit citations from the holdout set", () => {
    const observations = validateLongTermObservations({ observations: [{
      key: "steady", claim: "长期规律", scope: "recurring_pattern", confidence: 0.8,
      evidenceIds: ["l2-1", "l2-2", "l2-3"],
    }] }, evidence).accepted
    const result = validateLongTermAudits({ audits: [
      { key: "steady", verdict: "supported", evidenceIds: ["l2-4"], reason: "后续仍出现" },
      { key: "steady", verdict: "contradicted", evidenceIds: ["l2-1"], reason: "泄漏训练证据" },
    ] }, observations, [evidence[3]])
    expect(result.accepted).toHaveLength(1)
    expect(result.rejected[0].reason).toContain("outside the holdout")
  })

  it("parses fenced output while stripping reasoning", () => {
    expect(parseJsonObject('<think>hidden</think>```json\n{"observations":[]}\n```')).toEqual({ observations: [] })
    expect(parseJsonArray('<think>hidden</think>```json\n[{"key":"one"}]\n```')).toEqual([{ key: "one" }])
  })

  it("mines only cross-date semantic groups without chaining unrelated vectors", () => {
    const groups = buildSemanticCandidateGroups(evidence.map((item, index) => ({
      evidence: item,
      embedding: index < 3 ? [1, index * 0.01] : [0, 1],
    })), 0.95)
    expect(groups).toHaveLength(1)
    expect(groups[0].evidenceIds).toEqual(["l2-1", "l2-2", "l2-3"])
  })
})
