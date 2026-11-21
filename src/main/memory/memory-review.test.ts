import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { MemoryCandidate } from "./memory-types"
import { memoryContentVersion } from "./memory-write-validation"

const mocks = vi.hoisted(() => ({ dir: "", add: vi.fn(), remove: vi.fn() }))
vi.mock("../runtime/runtime-paths", () => ({ getUserDataDir: () => mocks.dir }))
vi.mock("../rag", () => ({ addL2MemoryVector: mocks.add, deleteUserMemoryVectors: mocks.remove,
  getEntriesBySource: () => [], searchMemoryEntries: async () => [] }))
vi.mock("../rag/embedding", () => ({ getEmbeddingProvider: () => undefined }))
vi.mock("./dmae-manager", () => ({ l2DmaeManager: { removeMemory: vi.fn() } }))
vi.mock("./memory-judge", () => ({ memoryJudge: { classifyMemoryFacetsBatch: async () => [] } }))
vi.mock("../llm-queue", () => ({ enqueueLLMTask: (_label: string, task: () => unknown) => task() }))

const bicycle: MemoryCandidate = {
  layer: "L2", content: "用户的自行车尚未修理，因修车点较远，推车麻烦，懒得去",
  confidence: 0.9, triggerText: "我自行车还没修，因为要推车推好远，不想动",
  evidenceQuotes: ["我自行车还没修，因为要推车推好远，不想动"], shouldWrite: true,
}

beforeEach(() => {
  mocks.dir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-review-"))
  mocks.add.mockReset().mockResolvedValue("vector")
  mocks.remove.mockReset().mockReturnValue(1)
  vi.resetModules()
})
afterEach(() => fs.rmSync(mocks.dir, { recursive: true, force: true }))

async function setup() {
  const { memoryStore } = await import("./memory-store")
  const { memoryManager } = await import("./memory-manager")
  const { resolveMemorySemanticReview } = await import("./memory-review")
  return { memoryStore, memoryManager, resolveMemorySemanticReview }
}

describe("written memory semantic review", () => {
  it("writes and indexes the bicycle paraphrase plus unrelated facts, marking only the risk", async () => {
    const { memoryStore, memoryManager } = await setup()
    const normal: MemoryCandidate = { layer: "L2", content: "用户在做前端项目", confidence: 0.9,
      triggerText: "我在做前端", evidenceQuotes: ["我在做前端"] }
    await memoryManager.writeMemory([bicycle, normal])
    const memories = await memoryStore.getAllL2()
    expect(memories.map(item => [item.content, item.status, item.syncStatus])).toEqual([
      [bicycle.content, "active", "synced"], [normal.content, "active", "synced"],
    ])
    const reviews = await memoryStore.getSemanticReviews()
    expect(reviews).toHaveLength(1)
    expect(reviews[0]).toMatchObject({ memoryId: memories[0].id, content: bicycle.content, evidenceQuotes: bicycle.evidenceQuotes })
    expect(mocks.add).toHaveBeenCalledTimes(2)
    vi.resetModules()
    const reloaded = await import("./memory-store")
    expect(await reloaded.memoryStore.getSemanticReviews()).toEqual(reviews)
    expect(await reloaded.memoryStore.getAllL2()).toHaveLength(2)
  })

  it("also writes explicit overclaim hints by default", async () => {
    const { memoryStore, memoryManager } = await setup()
    await memoryManager.writeMemory([{ ...bicycle, forbiddenOverclaims: ["只"] }])
    expect(await memoryStore.getAllL2()).toHaveLength(1)
    expect((await memoryStore.getSemanticReviews())[0].reason).toContain("过度概括")
  })

  it("confirming only clears the hint without writing or indexing another memory", async () => {
    const { memoryStore, memoryManager, resolveMemorySemanticReview } = await setup()
    await memoryManager.writeMemory([bicycle])
    const before = structuredClone(await memoryStore.getAllL2())
    const [review] = await memoryStore.getSemanticReviews()
    await expect(resolveMemorySemanticReview(review.id, review.content, "keep")).resolves.toEqual({ ok: true })
    expect(await memoryStore.getSemanticReviews()).toEqual([])
    expect(await memoryStore.getAllL2()).toEqual(before)
    expect(mocks.add).toHaveBeenCalledTimes(1)
  })

  it("edits the actual L2 memory and rebuilds its vector", async () => {
    const { memoryStore, memoryManager, resolveMemorySemanticReview } = await setup()
    await memoryManager.writeMemory([bicycle])
    const [review] = await memoryStore.getSemanticReviews()
    await expect(resolveMemorySemanticReview(review.id, review.content, "edit", "自行车还没修，嫌推车远")).resolves.toEqual({ ok: true, indexed: true })
    expect((await memoryStore.getAllL2())[0]).toMatchObject({ id: review.memoryId, content: "自行车还没修，嫌推车远", syncStatus: "synced" })
    expect(await memoryStore.getSemanticReviews()).toEqual([])
    expect(mocks.remove).toHaveBeenCalledWith(["vector"])
    expect(mocks.add).toHaveBeenCalledTimes(2)
  })

  it("deletes the actual L2 memory and its vector", async () => {
    const { memoryStore, memoryManager, resolveMemorySemanticReview } = await setup()
    await memoryManager.writeMemory([bicycle])
    const [review] = await memoryStore.getSemanticReviews()
    expect((await resolveMemorySemanticReview(review.id, review.content, "delete")).ok).toBe(true)
    expect(await memoryStore.getAllL2()).toEqual([])
    expect(await memoryStore.getSemanticReviews()).toEqual([])
    expect(mocks.remove).toHaveBeenCalledWith(["vector"])
  })

  it("does not overwrite a memory edited after the page loaded or revive its old hint", async () => {
    const { memoryStore, memoryManager, resolveMemorySemanticReview } = await setup()
    await memoryManager.writeMemory([bicycle])
    const [review] = await memoryStore.getSemanticReviews()
    await memoryStore.updateL2Content(review.memoryId!, "自行车已经修好")
    expect((await resolveMemorySemanticReview(review.id, review.content, "delete")).ok).toBe(false)
    expect((await memoryStore.getAllL2())[0].content).toBe("自行车已经修好")
    await memoryStore.updateL2Content(review.memoryId!, bicycle.content)
    expect(await memoryStore.getSemanticReviews()).toEqual([])
  })

  it("does not let an older page dismiss a newer review of the same memory", async () => {
    const { memoryStore, memoryManager, resolveMemorySemanticReview } = await setup()
    await memoryManager.writeMemory([bicycle])
    const [old] = await memoryStore.getSemanticReviews()
    await memoryStore.addSemanticReview({ ...old, reason: "新的复核提示" })
    const [latest] = await memoryStore.getSemanticReviews()
    expect(latest.id).not.toBe(old.id)
    expect((await resolveMemorySemanticReview(old.id, old.content, "keep")).ok).toBe(false)
    expect(await memoryStore.getSemanticReviews()).toEqual([latest])
  })

  it("rejects empty edits and unknown actions without changing the written memory", async () => {
    const { memoryStore, memoryManager, resolveMemorySemanticReview } = await setup()
    await memoryManager.writeMemory([bicycle])
    const [review] = await memoryStore.getSemanticReviews()
    expect((await resolveMemorySemanticReview(review.id, review.content, "edit", "  ")).ok).toBe(false)
    expect((await resolveMemorySemanticReview(review.id, review.content, "unknown")).ok).toBe(false)
    expect((await memoryStore.getAllL2())[0].content).toBe(bicycle.content)
    expect(await memoryStore.getSemanticReviews()).toEqual([review])
  })

  it.each(["L0", "L1"] as const)("reviews and edits a written %s field", async layer => {
    const { memoryStore, memoryManager, resolveMemorySemanticReview } = await setup()
    await memoryManager.writeMemory([{ layer, field: "longTermInterests", content: "用户只喝茶", confidence: 0.9,
      triggerText: "喜欢茶", evidenceQuotes: ["喜欢茶"], certainty: "explicit", attribution: "user_explicit" }])
    const [review] = await memoryStore.getSemanticReviews()
    expect(review.layer).toBe(layer)
    expect((await resolveMemorySemanticReview(review.id, review.content, "edit", "用户喜欢喝茶")).ok).toBe(true)
    const profile = layer === "L0" ? await memoryStore.getL0() : await memoryStore.getL1()
    expect(profile[review.field as keyof typeof profile]).toBe("用户喜欢喝茶")
    expect(await memoryStore.getSemanticReviews()).toEqual([])
  })

  it.each(["L0", "L1"] as const)("deletes only the reviewed %s field", async layer => {
    const { memoryStore, memoryManager, resolveMemorySemanticReview } = await setup()
    await memoryStore.upsertL0Field("occupation", "工程师")
    await memoryStore.replaceL1Field("currentProject", "前端项目")
    await memoryManager.writeMemory([{ layer, field: "longTermInterests", content: "用户只喝茶", confidence: 0.9,
      triggerText: "喜欢茶", evidenceQuotes: ["喜欢茶"], certainty: "explicit", attribution: "user_explicit" }])
    const [review] = await memoryStore.getSemanticReviews()
    expect((await resolveMemorySemanticReview(review.id, review.content, "delete")).ok).toBe(true)
    const profile = layer === "L0" ? await memoryStore.getL0() : await memoryStore.getL1()
    expect(profile[review.field as keyof typeof profile]).toBe("")
    expect((await memoryStore.getL0()).occupation).toBe("工程师")
    expect((await memoryStore.getL1()).currentProject).toBe("前端项目")
    expect(await memoryStore.getSemanticReviews()).toEqual([])
  })

  it("keeps explicit L0 attribution, pin and shouldWrite guards", async () => {
    const { memoryStore, memoryManager } = await setup()
    await memoryManager.writeMemory([{ ...bicycle, shouldWrite: false },
      { ...bicycle, layer: "L0", field: "longTermInterests", certainty: "inferred" }])
    await memoryStore.upsertL0Field("isPinned", true)
    await memoryManager.writeMemory([{ ...bicycle, layer: "L0", field: "longTermInterests", certainty: "explicit", attribution: "user_explicit" }])
    expect(await memoryStore.getSemanticReviews()).toEqual([])
    expect(await memoryStore.getAllL2()).toEqual([])
    expect((await memoryStore.getL0()).longTermInterests).toBe("")
  })

  it("attaches a risky supplement to the updated full memory rather than creating a second memory", async () => {
    const { memoryStore, memoryManager } = await setup()
    const old = await memoryStore.addL2Memory({ content: "用户喜欢喝茶", triggerText: "喜欢茶", sourceConversationId: "chat", isPinned: false })
    const quote = "补充：只喝绿茶"
    await memoryManager.writeMemory([{ layer: "L2", content: "用户只喝绿茶", triggerText: quote,
      confidence: 0.9, evidenceQuotes: [quote], memoryAction: "supplement", targetMemoryId: old.id,
      targetVersion: memoryContentVersion(old) }], async () => true,
      { conversationId: "chat", turns: [{ conversationId: "chat", userMessageId: "u1", userInput: quote, assistantReply: "嗯" }] })
    const [review] = await memoryStore.getSemanticReviews()
    expect(review).toMatchObject({ memoryId: old.id, content: "用户喜欢喝茶\n补充：用户只喝绿茶" })
    expect(await memoryStore.getAllL2()).toHaveLength(1)
  })
})
