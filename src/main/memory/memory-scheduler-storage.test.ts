import fs from "fs"
import os from "os"
import path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({ root: "" }))
vi.mock("electron", () => ({ app: { getPath: () => state.root } }))
vi.mock("../llm-queue", () => ({ enqueueLLMTask: vi.fn(async () => {}) }))
vi.mock("./entity-graph", () => ({ entityGraph: { ingest: vi.fn() } }))
vi.mock("./memory-judge", () => ({ memoryJudge: { judgeRecentTurns: vi.fn() } }))
vi.mock("./memory-manager", () => ({ memoryManager: { writeMemory: vi.fn(), runDecay: vi.fn() } }))
vi.mock("./memory-compressor", () => ({ runReflectionAndCompression: vi.fn() }))
vi.mock("./memory-resolver", () => ({ runResolverQueueOnce: vi.fn() }))

describe("memory scheduler with persisted chat and memory stores", () => {
  beforeEach(() => {
    state.root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-rounds-integration-"))
    vi.resetModules()
  })
  afterEach(() => { fs.rmSync(state.root, { recursive: true, force: true }) })

  it("rebuilds the old count from live pairs, then tracks replacement and deletion across restart", async () => {
    const chats = await import("../chats/chats-store")
    chats.initialize()
    const session = chats.createSession({ initialMessages: [
      { id: "u1", role: "user", content: "user 1", at: 1 },
      { id: "a1", role: "model", content: "reply 1", at: 1 },
      { id: "u2", role: "user", content: "user 2", at: 2 },
      { id: "a2", role: "model", content: "reply 2", at: 2 },
    ] })
    const { memoryStore } = await import("./memory-store")
    await memoryStore.replaceL1Field("roundCount", 47)
    const { memoryScheduler } = await import("./memory-scheduler")
    await memoryScheduler.reconcileConversation(session.id)
    expect((await memoryStore.getL1()).roundCount).toBe(2)

    chats.replaceMessagesTail(session.id, 3, [{ id: "a2-new", role: "model", content: "new", at: 3 }])
    await vi.waitFor(async () => expect((await memoryStore.getL1()).roundCount).toBe(1))
    await memoryScheduler.scheduleMemoryWrite("user 2", "new", { conversationId: session.id,
      userMessageId: "u2", assistantMessageId: "a2-new", userAt: 2, assistantAt: 3, validateAgainstConversation: true })
    const persisted = JSON.parse(fs.readFileSync(path.join(state.root, "memory.json"), "utf8"))
    expect(persisted.l1.roundCount).toBe(2)
    expect(persisted.pendingTurns[0].assistantMessageId).toBe("a2-new")
    expect(persisted.roundCountState.turns.find((turn: { userMessageId: string }) => turn.userMessageId === "u2").assistantMessageId).toBe("a2-new")

    chats.deleteMessageRound(session.id, "a1")
    await vi.waitFor(async () => expect((await memoryStore.getL1()).roundCount).toBe(1))
    vi.resetModules()
    const restartedChats = await import("../chats/chats-store")
    restartedChats.initialize()
    const restarted = await import("./memory-scheduler")
    const restartedMemory = (await import("./memory-store")).memoryStore
    await restarted.memoryScheduler.reconcileConversation(session.id)
    expect((await restartedMemory.getL1()).roundCount).toBe(1)
    expect((await restartedMemory.getPendingTurns())[0].assistantReply).toBe("new")
    restartedChats.deleteSession(session.id)
    await vi.waitFor(async () => expect((await restartedMemory.getL1()).roundCount).toBe(0))
    expect(await restartedMemory.getPendingTurns()).toEqual([])
  })

  it("awaits pending persistence even when all background tasks are blocked", async () => {
    const chats = await import("../chats/chats-store")
    chats.initialize()
    const session = chats.createSession({ initialMessages: [{ id: "u1", role: "user", content: "user", at: 1 }] })
    const { memoryScheduler } = await import("./memory-scheduler")
    await memoryScheduler.scheduleMemoryWrite("user", "reply", { conversationId: session.id,
      userMessageId: "u1", assistantMessageId: "a1", userAt: 1, assistantAt: 2, validateAgainstConversation: true })
    const persisted = JSON.parse(fs.readFileSync(path.join(state.root, "memory.json"), "utf8"))
    expect(persisted.pendingTurns[0].assistantReply).toBe("reply")
    expect(persisted.l1.roundCount).toBe(1)
    // Renderer completion persists the same reply after the main-process callback.
    chats.replaceMessages(session.id, [...session.messages, { id: "a1", role: "model", content: "reply", at: 2 }])
    await memoryScheduler.reconcileConversation(session.id)
    await expect((await import("./memory-store")).memoryStore.getPendingTurns()).resolves.toHaveLength(1)
  })
})
