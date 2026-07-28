import { beforeEach, describe, expect, it, vi } from "vitest"
import { clearRecentMemoryInjections, wasRecentlyInjectedMemory } from "../memory/recent-injected-memory"

const ragMock = vi.hoisted(() => ({
  searchMemory: vi.fn(),
  searchMemoryEntries: vi.fn(),
  updateWorldbookActivation: vi.fn(),
  getPermanentWorldbookEntries: vi.fn(),
  getActiveWorldbookEntries: vi.fn(),
  getCascadeWorldbookEntries: vi.fn(),
  INJECTION_HEADER: "HEADER",
  INJECTION_PREAMBLE: "PREAMBLE",
}))

const memoryStoreMock = vi.hoisted(() => ({
  getAllL2: vi.fn(),
  getL0: vi.fn(),
  getL1: vi.fn(),
}))

const entityGraphMock = vi.hoisted(() => ({
  search: vi.fn(),
}))

vi.mock("../rag", () => ragMock)
vi.mock("../memory/memory-store", () => ({ memoryStore: memoryStoreMock }))
vi.mock("../memory/entity-graph", () => ({ entityGraph: entityGraphMock }))
vi.mock("./tool-registry", () => ({ toolRegistry: { getEnabledTools: vi.fn(() => []) } }))

describe("buildMemoryInjection", () => {
  beforeEach(() => {
    clearRecentMemoryInjections()
    ragMock.searchMemory.mockReset()
    ragMock.searchMemoryEntries.mockReset()
    ragMock.searchMemory.mockResolvedValue([])
    ragMock.searchMemoryEntries.mockResolvedValue([])
    memoryStoreMock.getAllL2.mockReset()
    memoryStoreMock.getAllL2.mockResolvedValue([])
    entityGraphMock.search.mockReset()
    entityGraphMock.search.mockReturnValue("")
  })

  it("records injected user memory l2 ids from RAG metadata", async () => {
    ragMock.searchMemoryEntries.mockResolvedValue([{
      id: "rag_run",
      text: "用户喜欢跑步",
      createdAt: Date.now(),
      score: 0.8,
      metadata: { l2Id: "l2_run" },
    }])
    const { buildMemoryInjection } = await import("./index")

    const context = await buildMemoryInjection("跑步")

    expect(context).toContain("用户喜欢跑步")
    expect(wasRecentlyInjectedMemory("l2_run")).toBe(true)
    expect(ragMock.searchMemoryEntries).toHaveBeenCalledWith("跑步", "user_memory", 5)
  })

  it("annotates aging and conflicted memories with citation guidance", async () => {
    ragMock.searchMemoryEntries.mockResolvedValue([
      { id: "rag_a", text: "用户喜欢冰淇淋", createdAt: Date.now(), score: 0.9, metadata: { l2Id: "l2_a" } },
      { id: "rag_b", text: "用户在学法语", createdAt: Date.now(), score: 0.8, metadata: { l2Id: "l2_b" } },
      { id: "rag_c", text: "用户住在上海", createdAt: Date.now(), score: 0.7, metadata: { l2Id: "l2_c" } },
    ])
    memoryStoreMock.getAllL2.mockResolvedValue([
      { id: "l2_a", content: "用户喜欢冰淇淋", status: "active", conflictWith: [] },
      { id: "l2_b", content: "用户在学法语", status: "aging", conflictWith: [] },
      { id: "l2_c", content: "用户住在上海", status: "active", conflictWith: ["rag_x"] },
    ])
    const { buildMemoryInjection } = await import("./index")

    const context = await buildMemoryInjection("随便聊聊")

    // active 正常引用，不带标注
    expect(context).toContain("· 用户喜欢冰淇淋\n")
    // aging 标注久远印象
    expect(context).toContain("用户在学法语（较久远的印象）")
    // 冲突条目保留 ⚠️ 标注
    expect(context).toContain("用户住在上海 ⚠️（该信息可能存在矛盾记录）")
    // 尾部引用指引只在命中对应档位时出现
    expect(context).toContain("提及时用不确定的语气")
    expect(context).toContain("引用前先向用户求证")
  })

  it("omits citation guidance when all memories are active and conflict-free", async () => {
    ragMock.searchMemoryEntries.mockResolvedValue([
      { id: "rag_a", text: "用户喜欢冰淇淋", createdAt: Date.now(), score: 0.9, metadata: { l2Id: "l2_a" } },
    ])
    memoryStoreMock.getAllL2.mockResolvedValue([
      { id: "l2_a", content: "用户喜欢冰淇淋", status: "active", conflictWith: [] },
    ])
    const { buildMemoryInjection } = await import("./index")

    const context = await buildMemoryInjection("随便聊聊")

    expect(context).toContain("· 用户喜欢冰淇淋")
    expect(context).not.toContain("较久远的印象")
    expect(context).not.toContain("求证")
  })
})

describe("buildAlwaysOnContext", () => {
  beforeEach(() => {
    ragMock.updateWorldbookActivation.mockReset()
    ragMock.getPermanentWorldbookEntries.mockReset()
    ragMock.getActiveWorldbookEntries.mockReset()
    ragMock.getCascadeWorldbookEntries.mockReset()
    ragMock.getPermanentWorldbookEntries.mockReturnValue([])
    ragMock.getActiveWorldbookEntries.mockReturnValue([])
    ragMock.getCascadeWorldbookEntries.mockReturnValue([])
    memoryStoreMock.getL0.mockReset()
    memoryStoreMock.getL1.mockReset()
    memoryStoreMock.getL0.mockResolvedValue({})
    memoryStoreMock.getL1.mockResolvedValue({})
  })

  it("does not let document modelContext trigger worldbook activation", async () => {
    const { buildAlwaysOnContext } = await import("./index")

    await buildAlwaysOnContext(
      "请总结这个文档\n\n【文档内容】\n文档里写着 迷迷 和 PHILIA093。",
      [],
    )

    expect(ragMock.updateWorldbookActivation).toHaveBeenCalledWith("请总结这个文档", "")
  })
})
