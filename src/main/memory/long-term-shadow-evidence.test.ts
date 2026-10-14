import { describe, expect, it } from "vitest"
import type { ConflictLog, L2Memory } from "./memory-types"
import { groundShadowMemory, prepareShadowEvidence, type ShadowSourceMessage } from "./long-term-shadow-evidence"

const at = Date.UTC(2026, 8, 1)
const text = "我想把今天看到的云海照片分享给你"
const message: ShadowSourceMessage = { key: "s:u", conversationId: "s", role: "user", content: `${text}[sticker:playful]`, at }
function memory(patch: Partial<L2Memory> = {}): L2Memory {
  return { id: "m1", content: "用户分享云海", triggerText: text, sourceConversationId: "s", sourceAt: at,
    sourceEndAt: at, createdAt: at + 1000, lastAccessedAt: at, accessCount: 0, weight: 0,
    isPinned: false, status: "active", ...patch }
}
function log(patch: Partial<ConflictLog> = {}): ConflictLog {
  return { id: "c", createdAt: at, sourceL2Id: "m1", targetL2Id: "m2", status: "pending",
    reason: "test", confidence: 0.5, detector: "local", ...patch }
}

describe("Shadow evidence source boundaries", () => {
  it("matches sticker/role wrappers without using AI statements", () => {
    const result = groundShadowMemory(memory({ sourceQuote: `用户：${text}（用户发送表情包：好开心）\nAI：用户一直都很喜欢拍照这是真的` }), [message])
    expect(result.matches.map((m) => m.key)).toEqual(["s:u"])
    expect(result.fragments.join()).not.toContain("一直都")
  })
  it("requires all substantial fragments of a multi-turn user quote", () => {
    const second = { ...message, key: "s:u2", content: "我还专门拍了一张夕阳下的山峰", at: at + 60000 }
    const m = memory({ sourceQuote: `用户：${text}……用户：${second.content}`, sourceEndAt: second.at })
    expect(groundShadowMemory(m, [message, second]).matches).toHaveLength(2)
    expect(groundShadowMemory(m, [message]).reason).toBeTruthy()
  })
  it("rejects nearby unrelated text, wrong dates, wrong sessions, ambiguity, and deleted sources", () => {
    expect(groundShadowMemory(memory({ triggerText: "我不喜欢拍照并且不会给你发照片" }), [message]).reason).toBeTruthy()
    expect(groundShadowMemory(memory(), [{ ...message, at: at + 86400000 }]).reason).toBeTruthy()
    expect(groundShadowMemory(memory(), [{ ...message, conversationId: "other" }]).reason).toBeTruthy()
    expect(groundShadowMemory(memory(), [message, { ...message, key: "s:repeat" }]).reason).toContain("ambiguous")
    expect(groundShadowMemory(memory(), []).reason).toBeTruthy()
  })
  it("does not accept a tiny contained user message as grounding for a long invented quote", () => {
    expect(groundShadowMemory(memory({ triggerText: "我想创造一种完全没有提过的新型超级装置好哦" }), [{ ...message, content: "好哦" }]).reason).toBeTruthy()
  })
  it("deduplicates shared sources and excludes summaries and invalid lifetimes", () => {
    const result = prepareShadowEvidence([memory(), memory({ id: "duplicate" }), memory({ id: "summary", isSummary: true }), memory({ id: "expired", validTo: at })], [message], [], at + 10000)
    expect(result.evidence.map((e) => e.id)).toHaveLength(1)
    expect(result.excluded.map((e) => e.reason)).toEqual(expect.arrayContaining(["overlapping source messages", "summary is not independent evidence", "outside validity window"]))
  })
  it("retains independent repeated expressions on different dates", () => {
    const later = { ...message, key: "s:later", at: at + 86400000 }
    expect(prepareShadowEvidence([memory(), memory({ id: "m2", sourceAt: later.at, sourceEndAt: later.at })], [message, later], [], later.at).evidence).toHaveLength(2)
  })
  it("blocks unresolved conflicts but respects an explicit subsequent dismissal", () => {
    expect(prepareShadowEvidence([memory()], [message], [log()], at).evidence).toHaveLength(0)
    expect(prepareShadowEvidence([memory()], [message], [log(), log({ id: "c2", status: "dismissed", createdAt: at + 1 })], at).evidence).toHaveLength(1)
    expect(prepareShadowEvidence([memory()], [message], [log({ status: "resolved", resolutionType: "uncertain" })], at).evidence).toHaveLength(0)
  })
})
