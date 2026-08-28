import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  updateL2Content: vi.fn(),
  deleteL2: vi.fn(),
  getAllL2: vi.fn(),
  markL2SyncStatus: vi.fn(),
  updateL2FacetsBatch: vi.fn(),
  getEntriesBySource: vi.fn(),
  deleteUserMemoryVectors: vi.fn(),
  addL2MemoryVector: vi.fn(),
  removeMemory: vi.fn(),
  classifyMemoryFacetsBatch: vi.fn(),
  enqueueLLMTask: vi.fn(),
}))

vi.mock("./memory-store", () => ({
  memoryStore: {
    updateL2Content: mocks.updateL2Content,
    deleteL2: mocks.deleteL2,
    getAllL2: mocks.getAllL2,
    markL2SyncStatus: mocks.markL2SyncStatus,
    updateL2FacetsBatch: mocks.updateL2FacetsBatch,
  },
}))
vi.mock("../rag", () => ({
  getEntriesBySource: mocks.getEntriesBySource,
  deleteUserMemoryVectors: mocks.deleteUserMemoryVectors,
  addL2MemoryVector: mocks.addL2MemoryVector,
}))
vi.mock("./dmae-manager", () => ({ l2DmaeManager: { removeMemory: mocks.removeMemory } }))
vi.mock("./memory-judge", () => ({
  memoryJudge: { classifyMemoryFacetsBatch: mocks.classifyMemoryFacetsBatch },
}))
vi.mock("../llm-queue", () => ({
  enqueueLLMTask: mocks.enqueueLLMTask,
}))

import { deleteL2MemoryForUser, editL2MemoryForUser } from "./l2-user-management"

const memory = {
  id: "l2_target",
  content: "用户喜欢新颜色",
  triggerText: "我以前喜欢蓝色",
  createdAt: 123,
  facets: { primaryKind: "other", retrievalKinds: ["other"], source: "pending", pendingClassification: true },
}

describe("L2 user management", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getEntriesBySource.mockReturnValue([
      { id: "rag_old", metadata: { l2Id: "l2_target" } },
      { id: "rag_orphan", metadata: { l2Id: "l2_target" } },
      { id: "rag_other", metadata: { l2Id: "l2_other" } },
    ])
    mocks.deleteUserMemoryVectors.mockReturnValue(2)
    mocks.removeMemory.mockResolvedValue(undefined)
    mocks.markL2SyncStatus.mockResolvedValue(undefined)
    mocks.getAllL2.mockResolvedValue([])
    mocks.updateL2FacetsBatch.mockResolvedValue(1)
    mocks.classifyMemoryFacetsBatch.mockResolvedValue([{
      id: "l2_target",
      facets: { primaryKind: "preference", retrievalKinds: ["preference"], source: "model", pendingClassification: false },
    }])
    mocks.enqueueLLMTask.mockImplementation((_name, task) => task())
  })

  it("rebuilds only the edited L2 vector and preserves its trigger text", async () => {
    mocks.updateL2Content.mockResolvedValue({ memory, oldRagId: "rag_old" })
    mocks.addL2MemoryVector.mockResolvedValue("rag_new")

    await expect(editL2MemoryForUser("l2_target", "用户喜欢新颜色")).resolves.toEqual({ ok: true, indexed: true })

    expect(mocks.deleteUserMemoryVectors).toHaveBeenCalledWith(["rag_old", "rag_orphan"])
    expect(mocks.addL2MemoryVector).toHaveBeenCalledWith(
      "用户喜欢新颜色",
      "l2_target",
      expect.objectContaining({
        triggerText: "我以前喜欢蓝色",
        facets: expect.objectContaining({ primaryKind: "preference", source: "model" }),
        source: "user_edit",
      }),
      { createdAt: 123 },
    )
    expect(mocks.markL2SyncStatus).toHaveBeenCalledWith("l2_target", "synced", "rag_new")
    expect(mocks.removeMemory).toHaveBeenCalledWith("l2_target")
    expect(mocks.updateL2FacetsBatch).toHaveBeenCalledWith([
      expect.objectContaining({ id: "l2_target", facets: expect.objectContaining({ primaryKind: "preference" }) }),
    ])
  })

  it("keeps semantic indexing pending and leaves startup backfill a retry target when reclassification fails", async () => {
    mocks.updateL2Content.mockResolvedValue({ memory, oldRagId: "rag_old" })
    mocks.classifyMemoryFacetsBatch.mockRejectedValue(new Error("classifier unavailable"))
    mocks.addL2MemoryVector.mockResolvedValue("rag_new")

    await expect(editL2MemoryForUser("l2_target", "用户喜欢新颜色")).resolves.toEqual({ ok: true, indexed: true })

    expect(mocks.updateL2FacetsBatch).not.toHaveBeenCalled()
    expect(mocks.addL2MemoryVector).toHaveBeenCalledWith(
      "用户喜欢新颜色",
      "l2_target",
      expect.objectContaining({ facets: expect.objectContaining({ source: "pending", pendingClassification: true }) }),
      { createdAt: 123 },
    )
  })

  it("keeps the edited text but fails closed when reindexing fails", async () => {
    mocks.updateL2Content.mockResolvedValue({ memory, oldRagId: "rag_old" })
    mocks.addL2MemoryVector.mockRejectedValue(new Error("embedding unavailable"))

    await expect(editL2MemoryForUser("l2_target", "用户喜欢新颜色")).resolves.toEqual({
      ok: true,
      indexed: false,
      error: "embedding unavailable",
    })
    expect(mocks.markL2SyncStatus).toHaveBeenCalledWith("l2_target", "sync_failed", undefined, expect.any(Error))
  })

  it("deletes the L2 record, every mapped vector, and its DMAE state", async () => {
    mocks.getAllL2.mockResolvedValue([{ ...memory, ragId: "rag_old" }])
    mocks.deleteL2.mockResolvedValue(undefined)

    await expect(deleteL2MemoryForUser("l2_target")).resolves.toEqual({
      ok: true,
      deleted: true,
      deletedVectors: 2,
    })
    expect(mocks.deleteUserMemoryVectors).toHaveBeenCalledWith(["rag_old", "rag_orphan"])
    expect(mocks.deleteL2).toHaveBeenCalledWith("l2_target")
    expect(mocks.removeMemory).toHaveBeenCalledWith("l2_target")
  })
})
