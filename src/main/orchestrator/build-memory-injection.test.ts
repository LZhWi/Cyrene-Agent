import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { clearRecentMemoryInjections, wasRecentlyInjectedMemory } from "../memory/recent-injected-memory"

const testEnv = vi.hoisted(() => ({
  userDataDir: "",
}))

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
  getDreamNarratives: vi.fn(async () => []),
  getL2DmaeSnapshot: vi.fn(async () => ({ states: {}, round: 0 })),
  setL2DmaeSnapshot: vi.fn(async () => undefined),
  recordL2RecallsBatch: vi.fn(async () => 0),
}))

const entityGraphMock = vi.hoisted(() => ({
  search: vi.fn(),
}))

vi.mock("../rag", () => ragMock)
vi.mock("../memory/memory-store", () => ({ memoryStore: memoryStoreMock }))
vi.mock("../memory/entity-graph", () => ({ entityGraph: entityGraphMock }))
vi.mock("../runtime/runtime-paths", () => ({ getUserDataDir: () => testEnv.userDataDir }))
vi.mock("./tool-registry", () => ({ toolRegistry: { getEnabledTools: vi.fn(() => []) } }))

describe("buildMemoryInjection", () => {
  beforeEach(() => {
    clearRecentMemoryInjections()
    testEnv.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-injection-"))
    ragMock.searchMemory.mockReset()
    ragMock.searchMemoryEntries.mockReset()
    ragMock.searchMemory.mockResolvedValue([])
    ragMock.searchMemoryEntries.mockResolvedValue([])
    memoryStoreMock.getAllL2.mockReset()
    memoryStoreMock.getAllL2.mockResolvedValue([])
    memoryStoreMock.recordL2RecallsBatch.mockClear()
    entityGraphMock.search.mockReset()
    entityGraphMock.search.mockReturnValue("")
  })

  afterEach(() => {
    fs.rmSync(testEnv.userDataDir, { recursive: true, force: true })
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
    expect(ragMock.searchMemoryEntries).toHaveBeenCalledWith("跑步", "user_memory", 5, { recordRecall: false })
    // reconsolidation：召回统计在最终注入集上批量记账（fire-and-forget，等一个微任务）
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(memoryStoreMock.recordL2RecallsBatch).toHaveBeenCalledWith(["l2_run"])
  })

  it("can retrieve memory without changing recent-injection state", async () => {
    ragMock.searchMemoryEntries.mockResolvedValue([{
      id: "rag_phone",
      text: "用户喜欢散步",
      createdAt: Date.now(),
      score: 0.8,
      metadata: { l2Id: "l2_phone" },
    }])
    const { buildMemoryInjection } = await import("./index")

    const context = await buildMemoryInjection("散步", { trackState: false })

    expect(context).toContain("用户喜欢散步")
    expect(wasRecentlyInjectedMemory("l2_phone")).toBe(false)
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

    // active 正常引用，带记录日期锚点
    expect(context).toMatch(/· 用户喜欢冰淇淋（记录于 \d{4}\/\d{1,2}\/\d{1,2}）/)
    // aging 标注久远印象 + 日期
    expect(context).toContain("用户在学法语（较久远的印象，记录于")
    // 冲突条目保留 ⚠️ 标注 + 日期
    expect(context).toContain("用户住在上海 ⚠️（该信息可能存在矛盾记录，记录于")
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

  it("appends sourceQuote as literal evidence, falling back to triggerText", async () => {
    ragMock.searchMemoryEntries.mockResolvedValue([
      { id: "rag_q1", text: "用户在做前端项目", createdAt: Date.now(), score: 0.9, metadata: { l2Id: "l2_q1" } },
      { id: "rag_q2", text: "用户喜欢香菇", createdAt: Date.now(), score: 0.8, metadata: { l2Id: "l2_q2" } },
    ])
    memoryStoreMock.getAllL2.mockResolvedValue([
      // 有 sourceQuote：优先用提取期保留的原文
      { id: "l2_q1", content: "用户在做前端项目", status: "active", conflictWith: [], sourceQuote: "我用 React 18.2 做的前端，部署在 vercel 上", triggerText: "我在做前端" },
      // 无 sourceQuote：回退 triggerText（同样是用户原话短引文）
      { id: "l2_q2", content: "用户喜欢香菇", status: "active", conflictWith: [], triggerText: "我喜欢吃香菇" },
    ])
    const { buildMemoryInjection } = await import("./index")

    const context = await buildMemoryInjection("前端")

    expect(context).toContain("原文：我用 React 18.2 做的前端，部署在 vercel 上；记录于")
    expect(context).toContain("原文：我喜欢吃香菇；记录于")
  })
})

describe("buildMemoryInjection with DMAE working memory", () => {
  const topicL2 = {
    id: "l2_topic",
    content: "用户正在筹备画展",
    status: "active",
    conflictWith: [],
    triggerText: "我在筹备画展",
    syncStatus: "synced",
    ragId: "rag_topic",
    createdAt: Date.now(),
  }

  function enableDmae(): void {
    fs.writeFileSync(
      path.join(testEnv.userDataDir, "model-settings.json"),
      JSON.stringify({ memoryDmaeEnabled: true }),
      "utf8",
    )
  }

  beforeEach(async () => {
    testEnv.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-injection-dmae-"))
    const { l2DmaeManager } = await import("../memory/dmae-manager")
    l2DmaeManager.resetForTest()
  })

  afterEach(async () => {
    const { l2DmaeManager } = await import("../memory/dmae-manager")
    l2DmaeManager.resetForTest()
  })

  it("keeps a topic memory injected on the next turn even when recall misses it", async () => {
    // 真实场景：用户连聊几轮画展后换了个说法提问，纯检索召回不到——
    // DMAE 驻留集应让话题记忆继续在场，而不是断片。
    enableDmae()
    const { buildMemoryInjection } = await import("./index")

    ragMock.searchMemoryEntries.mockResolvedValue([
      { id: "rag_topic", text: "用户正在筹备画展", createdAt: Date.now(), score: 0.9, metadata: { l2Id: "l2_topic" } },
    ])
    memoryStoreMock.getAllL2.mockResolvedValue([topicL2])
    const first = await buildMemoryInjection("画展准备得怎么样了")
    expect(first).toContain("用户正在筹备画展")

    // 第二轮：用户话题漂移，检索空手而归
    ragMock.searchMemoryEntries.mockResolvedValue([])
    const second = await buildMemoryInjection("今天天气怎么样")
    expect(second).toContain("用户正在筹备画展")
  })

  it("read-only callers preview the working set without committing state", async () => {
    // 真实场景：通话/只读管线与设置页沙箱走 trackState:false，
    // 预览可以展示驻留效果，但不能把状态写进正式表。
    enableDmae()
    const { buildMemoryInjection } = await import("./index")

    ragMock.searchMemoryEntries.mockResolvedValue([
      { id: "rag_topic", text: "用户正在筹备画展", createdAt: Date.now(), score: 0.9, metadata: { l2Id: "l2_topic" } },
    ])
    memoryStoreMock.getAllL2.mockResolvedValue([topicL2])
    const first = await buildMemoryInjection("画展准备得怎么样了", { trackState: false })
    expect(first).toContain("用户正在筹备画展")

    ragMock.searchMemoryEntries.mockResolvedValue([])
    const second = await buildMemoryInjection("今天天气怎么样", { trackState: false })
    // 预览未提交 → 第二次预览仍从空状态表出发，不会驻留
    expect(second).not.toContain("用户正在筹备画展")
  })

  it("stays byte-identical to pure retrieval when the switch is off", async () => {
    // 回归守卫：默认关闭时，第二轮检索为空就是没有注入，行为与改造前一致
    const { buildMemoryInjection } = await import("./index")

    ragMock.searchMemoryEntries.mockResolvedValue([
      { id: "rag_topic", text: "用户正在筹备画展", createdAt: Date.now(), score: 0.9, metadata: { l2Id: "l2_topic" } },
    ])
    memoryStoreMock.getAllL2.mockResolvedValue([topicL2])
    await buildMemoryInjection("画展准备得怎么样了")

    ragMock.searchMemoryEntries.mockResolvedValue([])
    const second = await buildMemoryInjection("今天天气怎么样")
    expect(second).not.toContain("用户正在筹备画展")
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

  it("can read active worldbook context without updating activation or stale cascade", async () => {
    ragMock.getActiveWorldbookEntries.mockReturnValue(["【当前条目】\n内容"])
    ragMock.getCascadeWorldbookEntries.mockReturnValue(["【残留联动】\n不应注入"])
    const { buildAlwaysOnContext } = await import("./index")

    const context = await buildAlwaysOnContext("通话内容", [], { trackState: false })

    expect(ragMock.updateWorldbookActivation).not.toHaveBeenCalled()
    expect(ragMock.getCascadeWorldbookEntries).not.toHaveBeenCalled()
    expect(context).toContain("当前条目")
    expect(context).not.toContain("残留联动")
  })
})
