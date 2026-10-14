import { describe, expect, it } from "vitest"
import { applyMemoryContentPatch, assertNoTemporaryTurnRefs, bindCandidateEvidence, memoryContentVersion, relatedMemoryTargets, validateIncrementalCandidates } from "./memory-write-validation"
import type { L2Memory, MemoryCandidate, MemoryJudgeTurn } from "./memory-types"

const turns: MemoryJudgeTurn[] = [
  { conversationId: "chat", userMessageId: "u1", userInput: "文档在 E:\\资料\\记录.txt，截止10月18日。", assistantReply: "我猜你喜欢草莓", userAt: 1 },
  { conversationId: "chat", userMessageId: "u2", userInput: "补充了中英文对照表。", assistantReply: "好", userAt: 2 },
]
const candidate: MemoryCandidate = { layer: "L2", content: "新增中英文对照表", confidence: 1, triggerText: "补充了中英文对照表。",
  evidenceQuotes: ["补充了中英文对照表。"], evidenceTurnRefs: ["T2"], certainty: "explicit", attribution: "user_explicit" }
const memory = { id: "m1", content: turns[0].userInput, sourceConversationId: "chat", sourceMessageIds: ["u1"],
  sourceEvidence: [{ conversationId: "chat", messageId: "u1", quote: turns[0].userInput }], status: "active", isPinned: false } as L2Memory

describe("incremental memory write validation", () => {
  it("rejects temporary indices in prose, while leaving evidence refs separate", () => {
    expect(() => assertNoTemporaryTurnRefs("用户于T2提供路径，后于T3补充")).toThrow()
    expect(bindCandidateEvidence(candidate, turns, "chat").evidenceTurnRefs).toEqual(["T2"])
  })
  it("preserves all original literals when supplementing", () => {
    expect(applyMemoryContentPatch(memory.content, { ...candidate, memoryAction: "supplement" }))
      .toBe(`${memory.content}\n补充：新增中英文对照表`)
    expect(() => applyMemoryContentPatch("已新增中英文对照表", { ...candidate, memoryAction: "supplement" })).toThrow("keep")
  })
  it("corrects only one exact fragment with explicit correction evidence", () => {
    const correction: MemoryCandidate = { ...candidate, memoryAction: "correct", replaceText: "10月18日", content: "10月22日", evidenceQuotes: ["截止日期不对，改为10月22日"] }
    expect(applyMemoryContentPatch(memory.content, correction)).toBe("文档在 E:\\资料\\记录.txt，截止10月22日。")
    expect(() => applyMemoryContentPatch("10月18日或10月18日", correction)).toThrow()
    expect(() => applyMemoryContentPatch(memory.content, { ...correction, evidenceQuotes: ["补充了对照表"] })).toThrow()
  })
  it("requires exact unique user evidence and matching references", () => {
    for (const quote of ["我猜你喜欢草莓", "补充了...对照表。", "补充了对照表。", "文档在 E:\\\\资料\\\\记录.txt"])
      expect(() => bindCandidateEvidence({ ...candidate, evidenceQuotes: [quote] }, turns, "chat")).toThrow()
    expect(() => bindCandidateEvidence({ ...candidate, evidenceTurnRefs: ["T1"] }, turns, "chat")).toThrow()
    expect(() => bindCandidateEvidence(candidate, [...turns, { ...turns[1], userMessageId: "u3" }], "chat")).toThrow()
  })
  it("binds multiple facts from one message and multi-message evidence without conflation", () => {
    const both = bindCandidateEvidence({ ...candidate, evidenceQuotes: [turns[0].userInput, turns[1].userInput], evidenceTurnRefs: ["T1", "T2"] }, turns, "chat")
    expect(both.sourceMessageIds).toEqual(["u1", "u2"])
    expect(both.sourceAt).toBe(1)
    expect(both.sourceEndAt).toBe(2)
    for (const quote of ["文档在 E:\\资料\\记录.txt", "截止10月18日"])
      expect(bindCandidateEvidence({ ...candidate, evidenceQuotes: [quote], evidenceTurnRefs: ["T1"] }, turns, "chat").sourceMessageIds).toEqual(["u1"])
  })
  it("does not turn appended model context into user evidence", () => {
    const augmented = [{ ...turns[1], userInput: turns[1].userInput + "\n附件解释：用户喜欢蓝色", sourceUserText: turns[1].userInput }]
    expect(() => bindCandidateEvidence({ ...candidate, evidenceQuotes: ["用户喜欢蓝色"] }, augmented, "chat")).toThrow()
  })
  it("selects only related, editable memories with current quoted evidence", () => {
    expect(relatedMemoryTargets([memory, { ...memory, id: "other", sourceConversationId: "other" },
      { ...memory, id: "legacy", sourceEvidence: undefined }, { ...memory, id: "pinned", isPinned: true }], turns.slice(0, 1), "chat").map(m => m.id)).toEqual(["m1"])
    expect(relatedMemoryTargets([memory], [{ ...turns[0], userInput: "edited" }], "chat")).toEqual([])
  })
  it("versions track edits and lifecycle but ignore recall counters and sync", () => {
    expect(memoryContentVersion({ ...memory, accessCount: 5, weight: 20, syncStatus: "synced" })).toBe(memoryContentVersion(memory))
    for (const patch of [{ content: "edited" }, { contentRevision: 1 }, { status: "archived" as const }, { isPinned: true }])
      expect(memoryContentVersion({ ...memory, ...patch })).not.toBe(memoryContentVersion(memory))
  })
  it("requires exactly one decision per target and binds target versions locally", () => {
    const context = { priorTurnCount: 1, previousMemories: relatedMemoryTargets([memory], turns, "chat") }
    const row = { ...candidate, memoryAction: "supplement", targetMemoryId: "m1", targetVersion: "forged" }
    const normalize = () => ({ ...candidate })
    const result = validateIncrementalCandidates([row], normalize, turns, "chat", context)
    expect(result[0].targetVersion).toBe(memoryContentVersion(memory))
    expect(() => validateIncrementalCandidates([], normalize, turns, "chat", context)).toThrow()
    expect(() => validateIncrementalCandidates([row, row], normalize, turns, "chat", context)).toThrow()
    expect(validateIncrementalCandidates([{ memoryAction: "keep", targetMemoryId: "m1" }], normalize, turns, "chat", context)).toEqual([])
  })
})
