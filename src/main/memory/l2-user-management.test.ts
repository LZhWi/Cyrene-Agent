import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  addL2MemoryVector: vi.fn(),
  deleteUserMemoryVectors: vi.fn(),
  getEntriesBySource: vi.fn(),
  getAllL2: vi.fn(),
  updateL2Content: vi.fn(),
  markL2SyncStatus: vi.fn(),
  deleteL2: vi.fn(),
  removeMemory: vi.fn(),
}))

vi.mock("../rag", () => ({
  addL2MemoryVector: mocks.addL2MemoryVector,
  deleteUserMemoryVectors: mocks.deleteUserMemoryVectors,
  getEntriesBySource: mocks.getEntriesBySource,
}))
vi.mock("./memory-store", () => ({ memoryStore: {
  getAllL2: mocks.getAllL2,
  updateL2Content: mocks.updateL2Content,
  markL2SyncStatus: mocks.markL2SyncStatus,
  deleteL2: mocks.deleteL2,
} }))
vi.mock("./l2-dmae-manager", () => ({ l2DmaeManager: { removeMemory: mocks.removeMemory } }))

import { deleteL2MemoryForUser, editL2MemoryForUser } from "./l2-user-management"

describe("L2 user management", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getEntriesBySource.mockReturnValue([])
    mocks.deleteUserMemoryVectors.mockReturnValue(0)
  })

  it("edits content, clears stale DMAE/vector state and rebuilds the vector", async () => {
    const memory = { id: "l2_1", content: "旧内容", triggerText: "原始线索", ragId: "rag_old" }
    mocks.getAllL2.mockResolvedValue([memory])
    mocks.updateL2Content.mockResolvedValue({ ...memory, content: "新内容" })
    mocks.getEntriesBySource.mockReturnValue([{ id: "rag_old", metadata: { l2Id: "l2_1" } }])
    mocks.addL2MemoryVector.mockResolvedValue("rag_new")

    await expect(editL2MemoryForUser("l2_1", " 新内容 ")).resolves.toEqual({ ok: true, indexed: true })
    expect(mocks.removeMemory).toHaveBeenCalledWith("l2_1")
    expect(mocks.deleteUserMemoryVectors).toHaveBeenCalledWith(["rag_old"])
    expect(mocks.addL2MemoryVector).toHaveBeenCalledWith("新内容", "l2_1", { triggerText: "原始线索", source: "user_edit" })
    expect(mocks.markL2SyncStatus).toHaveBeenCalledWith("l2_1", "synced", "rag_new")
  })

  it("deletes the L2 record, DMAE state and every matching vector", async () => {
    mocks.getAllL2.mockResolvedValue([{ id: "l2_1", ragId: "rag_primary" }])
    mocks.getEntriesBySource.mockReturnValue([{ id: "rag_extra", metadata: { l2Id: "l2_1" } }])
    mocks.deleteUserMemoryVectors.mockReturnValue(2)

    await expect(deleteL2MemoryForUser("l2_1")).resolves.toEqual({ ok: true, deleted: true, deletedVectors: 2 })
    expect(mocks.deleteL2).toHaveBeenCalledWith("l2_1")
    expect(mocks.removeMemory).toHaveBeenCalledWith("l2_1")
    expect(mocks.deleteUserMemoryVectors).toHaveBeenCalledWith(["rag_extra", "rag_primary"])
  })
})
