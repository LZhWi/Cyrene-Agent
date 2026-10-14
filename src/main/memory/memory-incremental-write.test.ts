import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { bindCandidateEvidence, memoryContentVersion } from "./memory-write-validation"
import type { MemoryCandidate, MemoryJudgeTurn } from "./memory-types"

const mocks = vi.hoisted(() => ({ dir: "", add: vi.fn(), remove: vi.fn(), entries: vi.fn() }))
vi.mock("../runtime/runtime-paths", () => ({ getUserDataDir: () => mocks.dir }))
vi.mock("../rag/index", () => ({ addL2MemoryVector: mocks.add, deleteUserMemoryVectors: mocks.remove,
  getEntriesBySource: mocks.entries, searchMemoryEntries: async () => [] }))
vi.mock("../rag/embedding", () => ({ getEmbeddingProvider: () => undefined }))

const turns: MemoryJudgeTurn[] = [
  { conversationId: "chat", userMessageId: "u1", userInput: "文档在 E:\\资料\\记录.txt，截止10月18日。", assistantReply: "好", userAt: 10 },
  { conversationId: "chat", userMessageId: "u2", userInput: "补充了中英文对照表。", assistantReply: "好", userAt: 20 },
]
const source = { turns, conversationId: "chat" }
beforeEach(() => {
  mocks.dir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-incremental-"))
  mocks.add.mockReset().mockResolvedValue("new-vector")
  mocks.remove.mockReset()
  mocks.entries.mockReset().mockReturnValue([])
  vi.resetModules()
})
afterEach(() => fs.rmSync(mocks.dir, { recursive: true, force: true }))

async function setup() {
  const { memoryStore } = await import("./memory-store")
  const { memoryManager } = await import("./memory-manager")
  const old = await memoryStore.addL2Memory({ content: turns[0].userInput, triggerText: turns[0].userInput,
    sourceConversationId: "chat", sourceMessageIds: ["u1"],
    sourceEvidence: [{ conversationId: "chat", messageId: "u1", quote: turns[0].userInput }],
    sourceAt: 10, sourceEndAt: 10, isPinned: false, ragId: "old-vector", syncStatus: "synced" })
  const patch = bindCandidateEvidence({ layer: "L2", content: "新增中英文对照表", confidence: 1,
    triggerText: turns[1].userInput, evidenceQuotes: [turns[1].userInput], evidenceTurnRefs: ["T2"],
    certainty: "explicit", attribution: "user_explicit", memoryAction: "supplement", targetMemoryId: old.id,
    targetVersion: memoryContentVersion(old) }, turns, "chat")
  return { memoryStore, memoryManager, old: structuredClone(old), patch }
}

describe("incremental memory persistence", () => {
  it("appends only the delta under the same ID, persists evidence and rebuilds the full vector", async () => {
    const { memoryStore, memoryManager, old, patch } = await setup()
    await memoryManager.writeMemory([patch], async () => true, source)
    const all = await memoryStore.getAllL2()
    expect(all).toHaveLength(1)
    expect(all[0]).toMatchObject({ id: old.id, content: `${old.content}\n补充：新增中英文对照表`, sourceMessageIds: ["u1", "u2"],
      sourceAt: 10, sourceEndAt: 20, contentRevision: 1, ragId: "new-vector", syncStatus: "synced" })
    expect((await memoryStore.getEvidenceByMemoryId(old.id)).at(-1)?.previousContent).toBe(old.content)
    expect(mocks.add).toHaveBeenCalledWith(all[0].content, old.id, expect.anything(), expect.anything())
    expect(mocks.remove).toHaveBeenCalledWith(["old-vector"])
    const disk = JSON.parse(fs.readFileSync(path.join(mocks.dir, "memory.json"), "utf8"))
    expect(disk.l2[0].sourceEvidence).toHaveLength(2)
  })
  it("persists source IDs for new facts and allows multiple facts per user message", async () => {
    const { memoryStore, memoryManager } = await setup()
    const facts: MemoryCandidate[] = ["路径为 E:\\资料\\记录.txt", "截止10月18日"].map(content => ({
      layer: "L2", content, confidence: 1, triggerText: turns[0].userInput,
      evidenceQuotes: [turns[0].userInput], evidenceTurnRefs: ["T1"], memoryAction: "add",
    }))
    await memoryManager.writeMemory(facts, async () => true, source)
    expect((await memoryStore.getAllL2()).slice(1).map(m => m.sourceMessageIds)).toEqual([["u1"], ["u1"]])
  })
  it.each(["edit", "delete", "archive", "pin"])("rejects a target changed by %s after extraction", async change => {
    const { memoryStore, memoryManager, old, patch } = await setup()
    if (change === "edit") await memoryStore.updateL2Content(old.id, "用户新内容")
    if (change === "delete") await memoryStore.deleteL2(old.id)
    if (change === "archive") await memoryStore.updateL2Status([old.id], "archived")
    if (change === "pin") { const m = (await memoryStore.getAllL2())[0]; m.isPinned = true }
    await expect(memoryManager.writeMemory([patch], async () => true, source)).rejects.toThrow("版本")
    expect(mocks.add).not.toHaveBeenCalled()
  })
  it("rechecks target after awaiting the source guard and rejects replay", async () => {
    const { memoryStore, old, patch } = await setup()
    await expect(memoryStore.applyL2MemoryPatch(patch, async () => {
      await memoryStore.updateL2Content(old.id, "刚编辑的内容")
      return true
    })).rejects.toThrow("版本")
    const latest = (await memoryStore.getAllL2())[0]
    const refreshed = { ...patch, targetVersion: memoryContentVersion(latest) }
    await memoryStore.applyL2MemoryPatch(refreshed, async () => true)
    await expect(memoryStore.applyL2MemoryPatch(refreshed, async () => true)).rejects.toThrow("版本")
  })
  it("does not relink a stale vector after a user edit during embedding", async () => {
    const { memoryStore, memoryManager, old, patch } = await setup()
    mocks.add.mockImplementationOnce(async () => {
      await memoryStore.updateL2Content(old.id, "更新后的用户内容")
      return "stale-vector"
    })
    await memoryManager.writeMemory([patch], async () => true, source)
    const current = (await memoryStore.getAllL2())[0]
    expect(current.content).toBe("更新后的用户内容")
    expect(current.ragId).toBeUndefined()
    expect(current.syncStatus).toBe("pending_sync")
    expect(mocks.remove).toHaveBeenCalledWith(["stale-vector"])
  })
  it("rejects all writes before mutation if any evidence or body is invalid", async () => {
    const { memoryStore, memoryManager, old, patch } = await setup()
    for (const invalid of [{ ...patch, content: "T2中补充" }, { ...patch, evidenceQuotes: ["补充...对照表"] }]) {
      await expect(memoryManager.writeMemory([patch, invalid], async () => true, source)).rejects.toThrow()
      expect((await memoryStore.getAllL2())[0].content).toBe(old.content)
    }
    await expect(memoryStore.applyL2MemoryPatch(patch, async () => false)).rejects.toThrow("来源")
  })
  it("corrects one exact fragment, preserving path and the previous content for audit", async () => {
    const { memoryStore, memoryManager, old, patch } = await setup()
    const correctionTurns = [turns[0], { ...turns[1], userInput: "截止日期不对，改为10月22日。" }]
    const correction: MemoryCandidate = { ...patch, memoryAction: "correct", replaceText: "10月18日", content: "10月22日",
      evidenceQuotes: [correctionTurns[1].userInput] }
    await memoryManager.writeMemory([correction], async () => true, { turns: correctionTurns, conversationId: "chat" })
    expect((await memoryStore.getAllL2())[0].content).toBe(old.content.replace("10月18日", "10月22日"))
  })
})
