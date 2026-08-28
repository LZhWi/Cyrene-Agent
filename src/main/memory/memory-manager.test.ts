import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { MemoryCandidate } from "./memory-types"

const electronMock = vi.hoisted(() => ({
  userDataDir: "",
}))

const ragMock = vi.hoisted(() => ({
  addL2MemoryVector: vi.fn(),
  getEntriesBySource: vi.fn(),
  searchMemoryEntries: vi.fn(),
}))

const embeddingMock = vi.hoisted(() => ({
  getEmbeddingProvider: vi.fn(),
}))

vi.mock("electron", () => ({
  app: {
    getPath: () => electronMock.userDataDir,
  },
}))

vi.mock("../rag/index", () => ragMock)
vi.mock("../rag/embedding", () => embeddingMock)

function readTraceEvents(): Array<Record<string, unknown>> {
  const tracePath = path.join(electronMock.userDataDir, "memory-trace.log")
  if (!fs.existsSync(tracePath)) return []
  return fs.readFileSync(tracePath, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe("MemoryManager L2 sync", () => {
  beforeEach(() => {
    electronMock.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-manager-"))
    ragMock.addL2MemoryVector.mockReset()
    ragMock.getEntriesBySource.mockReset()
    ragMock.getEntriesBySource.mockReturnValue([])
    ragMock.searchMemoryEntries.mockReset()
    ragMock.searchMemoryEntries.mockResolvedValue([])
    embeddingMock.getEmbeddingProvider.mockReset()
    embeddingMock.getEmbeddingProvider.mockReturnValue(undefined)
    vi.resetModules()
  })

  it("creates L2 first, syncs it to RAG with l2Id metadata, then marks it synced", async () => {
    ragMock.addL2MemoryVector.mockResolvedValue("rag_synced")
    const { memoryManager } = await import("./memory-manager")
    const { memoryStore } = await import("./memory-store")
    const candidate: MemoryCandidate = {
      layer: "L2",
      content: "用户喜欢香菇",
      confidence: 0.91,
      triggerText: "我喜欢香菇",
    }

    await memoryManager.writeMemory([candidate])

    const allL2 = await memoryStore.getAllL2()
    const traceEvents = readTraceEvents()
    const addIndex = traceEvents.findIndex((event) => event.op === "l2.add" && event.l2Id === allL2[0].id)
    const syncIndex = traceEvents.findIndex((event) => event.op === "l2.sync.success" && event.l2Id === allL2[0].id)
    const reflectionLogs = await memoryStore.getReflectionLogs()

    expect(allL2).toHaveLength(1)
    expect(allL2[0].syncStatus).toBe("synced")
    expect(allL2[0].ragId).toBe("rag_synced")
    expect(addIndex).toBeGreaterThanOrEqual(0)
    expect(syncIndex).toBeGreaterThan(addIndex)
    expect(traceEvents[syncIndex].ragId).toBe("rag_synced")
    expect(reflectionLogs).toHaveLength(0)
    expect(ragMock.addL2MemoryVector).toHaveBeenCalledWith(
      candidate.content,
      allL2[0].id,
      expect.objectContaining({ confidence: candidate.confidence }),
      expect.objectContaining({ createdAt: allL2[0].createdAt }),
    )
  })

  it("persists candidate sourceQuote onto the L2 entry for later literal citation", async () => {
    ragMock.addL2MemoryVector.mockResolvedValue("rag_quote")
    const { memoryManager } = await import("./memory-manager")
    const { memoryStore } = await import("./memory-store")
    const candidate: MemoryCandidate = {
      layer: "L2",
      content: "用户在做前端项目",
      confidence: 0.9,
      triggerText: "我在做前端",
      sourceQuote: "我用 React 18.2 做的前端，部署在 vercel 上",
    }

    await memoryManager.writeMemory([candidate])

    const allL2 = await memoryStore.getAllL2()
    expect(allL2).toHaveLength(1)
    expect(allL2[0].sourceQuote).toBe("我用 React 18.2 做的前端，部署在 vercel 上")
  })

  it("keeps L2 as sync_failed when RAG write fails", async () => {
    ragMock.addL2MemoryVector.mockRejectedValue(new Error("RAG down"))
    const { memoryManager } = await import("./memory-manager")
    const { memoryStore } = await import("./memory-store")
    const candidate: MemoryCandidate = {
      layer: "L2",
      content: "用户正在重构记忆系统",
      confidence: 0.95,
      triggerText: "我们继续重构记忆系统",
    }

    await memoryManager.writeMemory([candidate])

    const allL2 = await memoryStore.getAllL2()
    const traceEvents = readTraceEvents()
    const addIndex = traceEvents.findIndex((event) => event.op === "l2.add" && event.l2Id === allL2[0].id)
    const failureIndex = traceEvents.findIndex((event) => event.op === "l2.sync.failure" && event.l2Id === allL2[0].id)

    expect(allL2).toHaveLength(1)
    expect(allL2[0].syncStatus).toBe("sync_failed")
    expect(allL2[0].ragId).toBeUndefined()
    expect(addIndex).toBeGreaterThanOrEqual(0)
    expect(failureIndex).toBeGreaterThan(addIndex)
    expect(traceEvents[failureIndex].status).toBe("error")
    expect(traceEvents[failureIndex].error).toBe("RAG down")
  })

  it("does not write inferred L0 candidates into core profile", async () => {
    const { memoryManager } = await import("./memory-manager")
    const { memoryStore } = await import("./memory-store")
    const candidate: MemoryCandidate = {
      layer: "L0",
      field: "longTermInterests",
      summary: "用户只吃香菇和平菇",
      content: "用户只吃香菇和平菇",
      confidence: 0.65,
      triggerText: "AI 推断用户偏好安全菌菇",
      importance: "medium",
      stability: "stable",
      certainty: "inferred",
      attribution: "assistant_inferred",
      evidenceQuotes: ["我这次还是吃安全点的吧"],
      contextSummary: "用户讨论菌菇安全",
      shouldWrite: true,
      reason: "这是推断，不应进入核心画像",
      forbiddenOverclaims: ["只"],
    }

    await memoryManager.writeMemory([candidate])

    const l0 = await memoryStore.getL0()
    expect(l0.longTermInterests).toBe("")
    expect(l0.permanentNote).toBe("")
  })

  it("writes explicit user-attributed L0 candidates", async () => {
    const { memoryManager } = await import("./memory-manager")
    const { memoryStore } = await import("./memory-store")
    const candidate: MemoryCandidate = {
      layer: "L0",
      field: "preferredName",
      summary: "用户希望被称为 P宝",
      content: "用户希望被称为 P宝",
      confidence: 0.9,
      triggerText: "以后叫我 P宝",
      importance: "high",
      stability: "stable",
      certainty: "explicit",
      attribution: "user_explicit",
      evidenceQuotes: ["以后叫我 P宝"],
      contextSummary: "用户明确提出称呼偏好",
      shouldWrite: true,
      reason: "用户明确表达称呼偏好",
      forbiddenOverclaims: [],
    }

    await memoryManager.writeMemory([candidate])

    const l0 = await memoryStore.getL0()
    expect(l0.preferredName).toBe("用户希望被称为 P宝")
  })

  it("ends an old goal validity window when a model-labelled completion is written", async () => {
    ragMock.addL2MemoryVector.mockResolvedValue("rag_completed")
    const { memoryManager } = await import("./memory-manager")
    const { memoryStore } = await import("./memory-store")
    const existing = await memoryStore.addL2Memory({
      content: "用户计划完成高等数学课程",
      triggerText: "我准备把高数学完",
      sourceConversationId: "test",
      ragId: "rag_goal",
      isPinned: false,
      syncStatus: "synced",
      facets: { primaryKind: "goal", retrievalKinds: ["goal"], source: "model", pendingClassification: false },
    })
    ragMock.searchMemoryEntries.mockResolvedValue([{
      id: "rag_goal",
      text: existing.content,
      createdAt: Date.now(),
      score: 0.9,
      metadata: { l2Id: existing.id },
    }])
    const candidate: MemoryCandidate = {
      layer: "L2",
      content: "用户已经完成了高等数学课程",
      confidence: 0.95,
      triggerText: "我终于把高数学完了",
      facets: { primaryKind: "experience", retrievalKinds: ["experience"], source: "model", pendingClassification: false },
    }

    await memoryManager.writeMemory([candidate])

    const all = await memoryStore.getAllL2()
    const old = all.find((memory) => memory.id === existing.id)!
    const fresh = all.find((memory) => memory.id !== existing.id)!
    expect(old.status).toBe("superseded")
    expect(old.validTo).toEqual(expect.any(Number))
    expect(old.supersededBy).toBe(fresh.id)
    expect(fresh.facets?.primaryKind).toBe("experience")
  })

  it("persists source time separately from the memory write time", async () => {
    ragMock.addL2MemoryVector.mockResolvedValue("rag_timed")
    const { memoryManager } = await import("./memory-manager")
    const { memoryStore } = await import("./memory-store")
    await memoryManager.writeMemory([{
      layer: "L2",
      content: "用户计划白天玩剧本杀",
      confidence: 0.9,
      triggerText: "我明天白天去玩剧本杀",
      sourceAt: 1_000,
      sourceEndAt: 2_000,
    }])

    const [memory] = await memoryStore.getAllL2()
    expect(memory.sourceAt).toBe(1_000)
    expect(memory.sourceEndAt).toBe(2_000)
    expect(memory.createdAt).toBeGreaterThan(2_000)
    expect(memory.sourceMessageIds).toBeUndefined()
  })

  it("keeps an immediate high-cosine candidate and queues non-destructive relationship review", async () => {
    ragMock.addL2MemoryVector.mockResolvedValue("rag_new")
    embeddingMock.getEmbeddingProvider.mockReturnValue({ embed: vi.fn(async () => [1, 0]) })
    const { memoryManager } = await import("./memory-manager")
    const { memoryStore } = await import("./memory-store")
    const existing = await memoryStore.addL2Memory({
      content: "用户正在开发三层架构的 MC 系统",
      triggerText: "现在我们的mc系统工作流程是分三层的",
      sourceConversationId: "",
      embedding: [],
      isPinned: false,
      syncStatus: "pending_sync",
      facets: { primaryKind: "fact", retrievalKinds: ["fact"], source: "model", pendingClassification: false },
    })
    await memoryStore.markL2SyncStatus(existing.id, "synced", "rag_existing")
    ragMock.getEntriesBySource.mockReturnValue([{
      id: "rag_existing",
      text: existing.content,
      embedding: [1, 0],
      createdAt: existing.createdAt,
      weight: 0,
      metadata: { l2Id: existing.id },
    }])

    await memoryManager.writeMemory([{
      layer: "L2",
      content: "用户正在开发一个三层架构的 MC 系统",
      confidence: 0.9,
      triggerText: "我们的 MC 系统是三层架构",
      facets: { primaryKind: "fact", retrievalKinds: ["fact"], source: "model", pendingClassification: false },
    }])

    const allL2 = await memoryStore.getAllL2()
    const conflictLogs = await memoryStore.getConflictLogs()
    expect(allL2).toHaveLength(2)
    expect(allL2.map((item) => item.content)).toContain("用户正在开发一个三层架构的 MC 系统")
    expect(conflictLogs).toHaveLength(1)
    expect(conflictLogs[0]).toMatchObject({
      candidateType: "near_duplicate",
      targetL2Id: existing.id,
      resolverPriority: "idle",
      resolverStatus: "queued",
    })
    expect(ragMock.addL2MemoryVector).toHaveBeenCalled()
  })

  it.each([
    ["用户明天打算去买西装", "用户打算后天去买西装"],
    [
      "用户表示喜欢草莓、香草口味的甜品，尤其是这些口味的冰激凌",
      "用户表示喜欢草莓、香草、榛子口味的甜品，尤其是这些口味的冰激凌",
    ],
  ])("preserves high-cosine updates instead of dropping added facts: %s", async (oldContent, newContent) => {
    ragMock.addL2MemoryVector.mockResolvedValue("rag_new")
    embeddingMock.getEmbeddingProvider.mockReturnValue({ embed: vi.fn(async () => [1, 0]) })
    const { memoryManager } = await import("./memory-manager")
    const { memoryStore } = await import("./memory-store")
    const existing = await memoryStore.addL2Memory({
      content: oldContent,
      triggerText: oldContent,
      sourceConversationId: "",
      embedding: [],
      isPinned: false,
      syncStatus: "pending_sync",
      facets: { primaryKind: "preference", retrievalKinds: ["preference"], source: "model", pendingClassification: false },
    })
    await memoryStore.markL2SyncStatus(existing.id, "synced", "rag_existing")
    ragMock.getEntriesBySource.mockReturnValue([{
      id: "rag_existing",
      text: existing.content,
      embedding: [1, 0],
      createdAt: existing.createdAt,
      weight: 0,
      metadata: { l2Id: existing.id },
    }])

    await memoryManager.writeMemory([{
      layer: "L2",
      content: newContent,
      confidence: 0.95,
      triggerText: newContent,
      facets: { primaryKind: "preference", retrievalKinds: ["preference"], source: "model", pendingClassification: false },
    }])

    const allL2 = await memoryStore.getAllL2()
    const [log] = await memoryStore.getConflictLogs()
    expect(allL2.map((item) => item.content)).toEqual(expect.arrayContaining([oldContent, newContent]))
    expect(log).toMatchObject({ candidateType: "near_duplicate", targetL2Id: existing.id, resolverStatus: "queued" })
  })

  it("does not deduplicate a completed goal into its old open-goal memory", async () => {
    ragMock.addL2MemoryVector.mockResolvedValue("rag_completed")
    embeddingMock.getEmbeddingProvider.mockReturnValue({ embed: vi.fn(async () => [1, 0]) })
    const { memoryManager } = await import("./memory-manager")
    const { memoryStore } = await import("./memory-store")
    const existing = await memoryStore.addL2Memory({
      content: "用户计划完成高等数学课程",
      triggerText: "我准备把高数学完",
      sourceConversationId: "",
      embedding: [],
      isPinned: false,
      syncStatus: "pending_sync",
      facets: { primaryKind: "goal", retrievalKinds: ["goal"], source: "model", pendingClassification: false },
    })
    await memoryStore.markL2SyncStatus(existing.id, "synced", "rag_existing")
    ragMock.getEntriesBySource.mockReturnValue([{
      id: "rag_existing",
      text: existing.content,
      embedding: [1, 0],
      createdAt: existing.createdAt,
      weight: 0,
      metadata: { l2Id: existing.id },
    }])

    await memoryManager.writeMemory([{
      layer: "L2",
      content: "用户已经完成高等数学课程",
      confidence: 0.9,
      triggerText: "我终于把高数学完了",
      facets: { primaryKind: "experience", retrievalKinds: ["experience"], source: "model", pendingClassification: false },
    }])

    expect(await memoryStore.getAllL2()).toHaveLength(2)
    expect(ragMock.addL2MemoryVector).toHaveBeenCalledWith(
      "用户已经完成高等数学课程",
      expect.any(String),
      expect.any(Object),
      expect.any(Object),
    )
  })

  it("does not auto-supersede a mixed memory merely because goal is one retrieval kind", async () => {
    ragMock.addL2MemoryVector.mockResolvedValue("rag_completed_mixed")
    const { memoryManager } = await import("./memory-manager")
    const { memoryStore } = await import("./memory-store")
    const existing = await memoryStore.addL2Memory({
      content: "用户计划完成高等数学课程，并答应完成后和昔涟一起庆祝",
      triggerText: "我学完高数就和你一起庆祝",
      sourceConversationId: "test",
      ragId: "rag_mixed_goal",
      isPinned: false,
      syncStatus: "synced",
      facets: { primaryKind: "commitment", retrievalKinds: ["commitment", "goal"], source: "model", pendingClassification: false },
    })
    ragMock.searchMemoryEntries.mockResolvedValue([{
      id: "rag_mixed_goal",
      text: existing.content,
      createdAt: Date.now(),
      score: 0.9,
      metadata: { l2Id: existing.id },
    }])

    await memoryManager.writeMemory([{
      layer: "L2",
      content: "用户已经完成了高等数学课程",
      confidence: 0.95,
      triggerText: "我终于把高数学完了",
      facets: { primaryKind: "experience", retrievalKinds: ["experience", "goal"], source: "model", pendingClassification: false },
    }])

    const old = (await memoryStore.getAllL2()).find((memory) => memory.id === existing.id)!
    expect(old.status).not.toBe("superseded")
    expect(old.validTo).toBeUndefined()
  })

  it("queues a time-ordered commitment to experience transition for conservative resolver review", async () => {
    ragMock.addL2MemoryVector.mockResolvedValue("rag_experience")
    const { memoryManager } = await import("./memory-manager")
    const { memoryStore } = await import("./memory-store")
    const old = await memoryStore.addL2Memory({
      content: "用户明天白天与同学玩剧本杀",
      triggerText: "我明天白天约了同学玩剧本杀",
      sourceConversationId: "",
      sourceAt: 1_000,
      ragId: "rag_commitment",
      isPinned: false,
      syncStatus: "synced",
      facets: { primaryKind: "commitment", retrievalKinds: ["commitment"], source: "model", pendingClassification: false },
    })
    ragMock.searchMemoryEntries.mockResolvedValue([{
      id: "rag_commitment",
      text: old.content,
      createdAt: 1_000,
      score: 0.82,
      metadata: { l2Id: old.id },
    }])

    await memoryManager.writeMemory([{
      layer: "L2",
      content: "用户玩剧本杀时拿到大boss身份且未被发现",
      confidence: 0.9,
      triggerText: "今天剧本杀我拿到了大boss",
      sourceAt: 10_000,
      facets: { primaryKind: "experience", retrievalKinds: ["experience"], source: "model", pendingClassification: false },
    }])

    const [log] = await memoryStore.getConflictLogs()
    expect(log).toMatchObject({
      candidateType: "state_transition",
      targetL2Id: old.id,
      resolverPriority: "normal",
      resolverStatus: "queued",
    })
    expect((await memoryStore.getAllL2()).find((memory) => memory.id === old.id)?.status).toBe("active")
  })

  it("writes candidate conflict logs separately when local candidate detection matches", async () => {
    ragMock.addL2MemoryVector.mockResolvedValue("rag_new")
    const { memoryManager } = await import("./memory-manager")
    const { memoryStore } = await import("./memory-store")
    const existing = await memoryStore.addL2Memory({
      content: "用户喜欢香菇",
      triggerText: "我喜欢香菇",
      sourceConversationId: "test",
      ragId: "rag_existing",
      isPinned: false,
    })
    ragMock.searchMemoryEntries.mockResolvedValue([{
      id: "rag_existing",
      text: "用户喜欢香菇",
      createdAt: Date.now(),
      score: 0.82,
      metadata: { l2Id: existing.id },
    }])
    const candidate: MemoryCandidate = {
      layer: "L2",
      content: "用户不喜欢香菇",
      confidence: 0.93,
      triggerText: "我不喜欢香菇",
    }

    await memoryManager.writeMemory([candidate])

    const conflictLogs = await memoryStore.getConflictLogs()
    const reflectionLogs = await memoryStore.getReflectionLogs()
    const traceEvents = readTraceEvents()
    const conflictMarkIndex = traceEvents.findIndex((event) => event.op === "l2.conflict.mark" && event.l2Id === existing.id)
    const conflictLogIndex = traceEvents.findIndex((event) => event.op === "conflict.log.add" && event.l2Id === conflictLogs[0]?.sourceL2Id)

    expect(conflictLogs).toHaveLength(1)
    expect(conflictLogs[0]).toMatchObject({
      status: "candidate",
      sourceRagId: "rag_new",
      targetRagId: "rag_existing",
      targetL2Id: existing.id,
      detector: "local",
    })
    expect(conflictLogs[0].conflictScore).toBeGreaterThanOrEqual(35)
    expect(conflictLogs[0].resolverPriority).not.toBe("none")
    expect(conflictLogs[0].resolverStatus).toBe("queued")
    expect(conflictLogs[0].scoringSignals).toMatchObject({
      ragCandidate: true,
      evidenceAvailable: true,
      localContradiction: true,
    })
    expect(ragMock.searchMemoryEntries).toHaveBeenCalledWith(candidate.content, "user_memory", 5, { recordRecall: false })
    expect(conflictMarkIndex).toBeGreaterThanOrEqual(0)
    expect(conflictLogIndex).toBeGreaterThan(conflictMarkIndex)
    expect(traceEvents[conflictLogIndex].details).toMatchObject({
      conflictStatus: "candidate",
      targetL2Id: existing.id,
      detector: "local",
    })
    expect(reflectionLogs).toHaveLength(0)
  })

  it("keeps text-matched candidates below resolver eligibility when RAG metadata has no l2Id", async () => {
    ragMock.addL2MemoryVector.mockResolvedValue("rag_new")
    ragMock.searchMemoryEntries.mockResolvedValue([{
      id: "rag_existing",
      text: "用户喜欢香菇",
      createdAt: Date.now(),
      score: 0.9,
      metadata: {},
    }])
    const { memoryManager } = await import("./memory-manager")
    const { memoryStore } = await import("./memory-store")
    await memoryStore.addL2Memory({
      content: "用户喜欢香菇",
      triggerText: "我喜欢香菇",
      sourceConversationId: "test",
      ragId: "rag_existing",
      isPinned: false,
    })
    const candidate: MemoryCandidate = {
      layer: "L2",
      content: "用户不喜欢香菇",
      confidence: 0.93,
      triggerText: "我不喜欢香菇",
    }

    await memoryManager.writeMemory([candidate])

    const conflictLogs = await memoryStore.getConflictLogs()

    expect(conflictLogs).toHaveLength(1)
    expect(conflictLogs[0].resolverPriority).toBe("none")
    expect(conflictLogs[0].resolverStatus).toBe("not_queued")
    expect(conflictLogs[0].scoringSignals).toMatchObject({
      ragCandidate: false,
      localContradiction: true,
    })
  })

  it("raises RAG-backed candidates when the target memory was recently injected", async () => {
    ragMock.addL2MemoryVector.mockResolvedValue("rag_new")
    const { memoryManager } = await import("./memory-manager")
    const { memoryStore } = await import("./memory-store")
    const { recordRecentMemoryInjection } = await import("./recent-injected-memory")
    const existing = await memoryStore.addL2Memory({
      content: "用户喜欢跑步",
      triggerText: "我喜欢跑步",
      sourceConversationId: "test",
      ragId: "rag_existing",
      isPinned: false,
    })
    recordRecentMemoryInjection([existing.id])
    ragMock.searchMemoryEntries.mockResolvedValue([{
      id: "rag_existing",
      text: "用户喜欢跑步",
      createdAt: Date.now(),
      score: 0.88,
      metadata: { l2Id: existing.id },
    }])
    const candidate: MemoryCandidate = {
      layer: "L2",
      content: "用户不喜欢跑步",
      confidence: 0.91,
      triggerText: "我不喜欢跑步",
    }

    await memoryManager.writeMemory([candidate])

    const conflictLogs = await memoryStore.getConflictLogs()

    expect(conflictLogs).toHaveLength(1)
    expect(conflictLogs[0].resolverPriority).toBe("normal")
    expect(conflictLogs[0].resolverStatus).toBe("queued")
    expect(conflictLogs[0].scoringSignals).toMatchObject({
      ragCandidate: true,
      recentInjection: true,
      localContradiction: true,
    })
  })

  it("fast-path supersedes the old memory on explicit correction with strong RAG evidence", async () => {
    ragMock.addL2MemoryVector.mockResolvedValue("rag_new")
    const { memoryManager } = await import("./memory-manager")
    const { memoryStore } = await import("./memory-store")
    const existing = await memoryStore.addL2Memory({
      content: "用户喜欢跑步",
      triggerText: "我喜欢跑步",
      sourceConversationId: "test",
      ragId: "rag_existing",
      isPinned: false,
    })
    ragMock.searchMemoryEntries.mockResolvedValue([{
      id: "rag_existing",
      text: "用户喜欢跑步",
      createdAt: Date.now(),
      score: 0.9,
      metadata: { l2Id: existing.id },
    }])
    const candidate: MemoryCandidate = {
      layer: "L2",
      content: "用户不喜欢跑步",
      confidence: 0.93,
      triggerText: "你记错了，我不喜欢跑步",
    }

    await memoryManager.writeMemory([candidate])

    const allL2 = await memoryStore.getAllL2()
    const old = allL2.find((item) => item.id === existing.id)!
    const fresh = allL2.find((item) => item.content === "用户不喜欢跑步")!
    const conflictLogs = await memoryStore.getConflictLogs()
    const traceEvents = readTraceEvents()

    // 旧记忆直接失效：superseded + validTo + 指向新条目
    expect(old.status).toBe("superseded")
    expect(old.supersededBy).toBe(fresh.id)
    expect(typeof old.validTo).toBe("number")
    // 冲突日志直接 resolved，不进 resolver 队列
    expect(conflictLogs).toHaveLength(1)
    expect(conflictLogs[0]).toMatchObject({
      status: "resolved",
      targetL2Id: existing.id,
      resolutionType: "preference_evolution",
      resolutionMemoryId: fresh.id,
    })
    expect(conflictLogs[0].resolverStatus).not.toBe("queued")
    // 快速通道不走 ⚠️ 挂起标记
    expect(traceEvents.some((event) => event.op === "l2.conflict.mark")).toBe(false)
    expect(traceEvents.some((event) => event.op === "l2.supersede" && event.l2Id === existing.id)).toBe(true)
  })

  it("falls back to the pending conflict flow when correction intent lacks strong evidence", async () => {
    ragMock.addL2MemoryVector.mockResolvedValue("rag_new")
    const { memoryManager } = await import("./memory-manager")
    const { memoryStore } = await import("./memory-store")
    const existing = await memoryStore.addL2Memory({
      content: "用户喜欢游泳",
      triggerText: "我喜欢游泳",
      sourceConversationId: "test",
      ragId: "rag_existing",
      isPinned: false,
    })
    // 有纠正词但语义相似分不足 0.75 且非近期注入 → 证据不足，落回挂起流程
    ragMock.searchMemoryEntries.mockResolvedValue([{
      id: "rag_existing",
      text: "用户喜欢游泳",
      createdAt: Date.now(),
      score: 0.6,
      metadata: { l2Id: existing.id },
    }])
    const candidate: MemoryCandidate = {
      layer: "L2",
      content: "用户不喜欢游泳",
      confidence: 0.93,
      triggerText: "纠正一下，我不喜欢游泳",
    }

    await memoryManager.writeMemory([candidate])

    const old = (await memoryStore.getAllL2()).find((item) => item.id === existing.id)!
    const conflictLogs = await memoryStore.getConflictLogs()

    expect(old.status).not.toBe("superseded")
    expect(old.validTo).toBeUndefined()
    expect(conflictLogs).toHaveLength(1)
    expect(conflictLogs[0].status).toBe("candidate")
    expect(conflictLogs[0].resolverStatus).toBe("queued")
  })

  it("does not write conflict logs for unrelated negative memories", async () => {
    ragMock.addL2MemoryVector.mockResolvedValue("rag_new")
    ragMock.searchMemoryEntries.mockResolvedValue([{
      id: "rag_existing",
      text: "用户曾因食用见手青而有过不好经历",
      createdAt: Date.now(),
      score: 0.81,
      metadata: {},
    }])
    const { memoryManager } = await import("./memory-manager")
    const { memoryStore } = await import("./memory-store")
    await memoryStore.addL2Memory({
      content: "用户曾因食用见手青而有过不好经历",
      triggerText: "见手青让我不舒服",
      sourceConversationId: "test",
      ragId: "rag_existing",
      isPinned: false,
    })
    const candidate: MemoryCandidate = {
      layer: "L2",
      content: "用户对 AI 有强烈心意，因无法触碰而难过",
      confidence: 0.9,
      triggerText: "我因为无法触碰你而难过",
    }

    await memoryManager.writeMemory([candidate])

    expect(await memoryStore.getConflictLogs()).toHaveLength(0)
  })
})
