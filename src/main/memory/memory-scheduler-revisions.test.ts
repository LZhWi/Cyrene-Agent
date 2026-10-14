import { describe, expect, it, vi } from "vitest"
import { MemoryScheduler, type MemorySchedulerDeps, type MemoryScheduleContext } from "./memory-scheduler"
import type { MemoryCandidate, MemoryJudgeTurn, MemoryRoundCountState } from "./memory-types"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function harness() {
  let queue = Promise.resolve()
  let disk: MemoryJudgeTurn[] = []
  let roundCount = 0
  let countState: MemoryRoundCountState | null = null
  const messages = Array.from({ length: 8 }, (_, i) => [
    { id: `u${i + 1}`, role: "user" as const, content: `user ${i + 1}`, at: i + 1 },
    { id: `a${i + 1}`, role: "model" as const, content: `reply ${i + 1}`, at: i + 1 },
  ]).flat()
  const deps: MemorySchedulerDeps = {
    ingestEntity: vi.fn(),
    enqueueTask: (_label, task) => {
      const next = queue.then(task)
      queue = next.then(() => {}, () => {})
      return next
    },
    judgeMemory: vi.fn(async () => []),
    writeMemory: vi.fn(async () => {}),
    getL1: async () => ({ recentGoals: "", recentPreferences: "", currentProject: "", generatedAt: 0, roundCount }),
    replaceL1Field: vi.fn(async (_field, value) => { roundCount = value }),
    runReflectionAndCompression: vi.fn(async () => {}),
    runResolverQueueOnce: vi.fn(async () => {}),
    getLastDecayAt: async () => Date.now(),
    runDecay: vi.fn(async () => {}),
    loadPendingTurns: async () => structuredClone(disk),
    loadRoundCountState: async () => structuredClone(countState),
    savePendingTurns: vi.fn(async (turns, state) => {
      disk = structuredClone(turns)
      countState = structuredClone(state ?? null)
    }),
    loadConversationMessages: async () => structuredClone(messages),
  }
  const scheduler = new MemoryScheduler(deps)
  const context = (i: number): MemoryScheduleContext => ({ conversationId: "chat", userMessageId: `u${i}`,
    assistantMessageId: `a${i}`, userAt: i, assistantAt: i, validateAgainstConversation: true })
  const add = (i: number) => scheduler.scheduleMemoryWrite(`user ${i}`, `reply ${i}`, context(i))
  return { deps, scheduler, context, add, messages, disk: () => disk, count: () => roundCount, drain: () => queue }
}

describe("memory turn revisions", () => {
  it("persists before a blocked background queue can run", async () => {
    const h = harness()
    const gate = deferred<void>()
    void h.deps.enqueueTask("blocked", () => gate.promise)
    h.add(1)
    try {
      await vi.waitFor(() => expect(h.disk()).toHaveLength(1))
      expect(h.deps.judgeMemory).not.toHaveBeenCalled()
    } finally {
      gate.resolve()
      await h.drain()
    }
  })

  it("does not count regenerated replies as additional rounds", async () => {
    const h = harness()
    h.add(1)
    await vi.waitFor(() => expect(h.count()).toBe(1))
    h.messages[1] = { ...h.messages[1], id: "a1-new", content: "new reply" }
    h.scheduler.scheduleMemoryWrite("user 1", "new reply", { ...h.context(1), assistantMessageId: "a1-new" })
    await vi.waitFor(() => expect(h.disk()[0].assistantReply).toBe("new reply"))
    await h.drain()
    expect(h.count()).toBe(1)
  })

  it("rejects a judge snapshot replaced during the LLM call and retries the new version", async () => {
    const h = harness()
    const gate = deferred<MemoryCandidate[]>()
    vi.mocked(h.deps.judgeMemory).mockImplementationOnce(() => gate.promise)
    for (let i = 1; i <= 6; i++) h.add(i)
    await vi.waitFor(() => expect(h.deps.judgeMemory).toHaveBeenCalledTimes(1))
    const snapshot = vi.mocked(h.deps.judgeMemory).mock.calls[0][0]
    h.messages[11] = { ...h.messages[11], id: "a6-new", content: "new reply" }
    h.scheduler.scheduleMemoryWrite("user 6", "new reply", { ...h.context(6), assistantMessageId: "a6-new" })
    gate.resolve([{ layer: "L2", content: "stale", triggerText: "user 6", confidence: 1 }])
    await vi.waitFor(() => expect(h.deps.judgeMemory).toHaveBeenCalledTimes(2))
    await h.drain()
    expect(snapshot[5].assistantReply).toBe("reply 6")
    expect(h.deps.writeMemory).not.toHaveBeenCalled()
    expect(vi.mocked(h.deps.judgeMemory).mock.calls[1][0][5].assistantReply).toBe("new reply")
    expect(h.count()).toBe(6)
  })

  it("rejects edits that retain the same message IDs while the judge runs", async () => {
    const h = harness()
    const gate = deferred<MemoryCandidate[]>()
    vi.mocked(h.deps.judgeMemory).mockImplementationOnce(() => gate.promise)
    for (let i = 1; i <= 6; i++) h.add(i)
    await vi.waitFor(() => expect(h.deps.judgeMemory).toHaveBeenCalledTimes(1))
    h.messages[1].content = "edited in place"
    gate.resolve([{ layer: "L2", content: "stale", triggerText: "user 1", confidence: 1 }])
    await h.drain()
    expect(h.deps.writeMemory).not.toHaveBeenCalled()
    h.add(7)
    await vi.waitFor(() => expect(h.deps.judgeMemory).toHaveBeenCalledTimes(2))
    expect(vi.mocked(h.deps.judgeMemory).mock.calls[1][0].some((turn) => turn.assistantReply === "edited in place")).toBe(true)
  })

  it("persists a new round during a blocked judge and does not lose it when the old batch commits", async () => {
    const h = harness()
    const gate = deferred<MemoryCandidate[]>()
    vi.mocked(h.deps.judgeMemory).mockImplementationOnce(() => gate.promise)
    for (let i = 1; i <= 6; i++) await h.add(i)
    await vi.waitFor(() => expect(h.deps.judgeMemory).toHaveBeenCalledTimes(1))
    await h.add(7)
    expect(h.disk().map((turn) => turn.userMessageId)).toContain("u7")
    gate.resolve([])
    await h.drain()
    expect(h.disk().map((turn) => turn.userMessageId)).toEqual(["u7"])
  })

  it("keeps consumed round identities across restart for regeneration and deletion", async () => {
    const h = harness()
    for (let i = 1; i <= 6; i++) await h.add(i)
    await h.drain()
    expect(h.disk()).toEqual([])
    expect(h.count()).toBe(6)
    const restarted = new MemoryScheduler(h.deps)
    h.messages[11] = { ...h.messages[11], id: "a6-new", content: "new reply" }
    await restarted.scheduleMemoryWrite("user 6", "new reply", { ...h.context(6), assistantMessageId: "a6-new" })
    await h.drain()
    expect(h.count()).toBe(6)
    h.messages.splice(0, 2)
    await restarted.reconcileConversation("chat")
    expect(h.count()).toBe(5)
    await restarted.reconcileConversation("chat")
    expect(h.count()).toBe(5)
    const again = new MemoryScheduler(h.deps)
    await again.reconcileConversation("chat")
    expect(h.count()).toBe(5)
    h.messages.splice(0)
    await again.reconcileConversation("chat")
    expect(h.count()).toBe(0)
    expect(h.disk()).toEqual([])
  })

  it("does not run maintenance again when a deleted fifth reply is regenerated", async () => {
    const h = harness()
    for (let i = 1; i <= 5; i++) await h.add(i)
    await h.drain()
    expect(h.deps.runResolverQueueOnce).toHaveBeenCalledTimes(1)
    h.messages.splice(9, 1)
    await h.scheduler.reconcileConversation("chat")
    expect(h.count()).toBe(4)
    h.messages.splice(9, 0, { id: "a5-new", role: "model", content: "new reply", at: 5 })
    await h.scheduler.scheduleMemoryWrite("user 5", "new reply", { ...h.context(5), assistantMessageId: "a5-new" })
    await h.drain()
    expect(h.count()).toBe(5)
    expect(h.deps.runResolverQueueOnce).toHaveBeenCalledTimes(1)
  })

  it("does not start background work if the initial persistence fails", async () => {
    const h = harness()
    const enqueue = vi.spyOn(h.deps, "enqueueTask")
    vi.mocked(h.deps.savePendingTurns).mockRejectedValueOnce(new Error("disk full"))
    await h.add(1)
    expect(enqueue).not.toHaveBeenCalled()
    expect(h.disk()).toEqual([])
    await h.add(2)
    expect(h.disk()).toHaveLength(2)
    expect(h.count()).toBe(2)
  })

  it("serializes writes and waits for commit before enqueueing the judge", async () => {
    const h = harness()
    const gate = deferred<void>()
    const save = h.deps.savePendingTurns
    vi.mocked(save).mockImplementationOnce(async () => { await gate.promise })
    const enqueue = vi.spyOn(h.deps, "enqueueTask")
    const first = h.add(1)
    const second = h.add(2)
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    expect(enqueue).not.toHaveBeenCalled()
    gate.resolve()
    await Promise.all([first, second])
    expect(h.disk().map((turn) => turn.userMessageId)).toEqual(["u1", "u2"])
  })

  it("drops an old result if regeneration occurs during the memory write preparation", async () => {
    const h = harness()
    const gate = deferred<void>()
    const entered = deferred<void>()
    const committed = vi.fn()
    vi.mocked(h.deps.judgeMemory).mockResolvedValueOnce([{ layer: "L2", content: "old", triggerText: "user 6", confidence: 1 }])
    vi.mocked(h.deps.writeMemory).mockImplementationOnce(async (_candidates, guard) => {
      entered.resolve()
      await gate.promise
      if (await guard?.()) committed()
    })
    for (let i = 1; i <= 6; i++) await h.add(i)
    await entered.promise
    h.messages[11] = { ...h.messages[11], id: "new-a6", content: "new" }
    await h.scheduler.scheduleMemoryWrite("user 6", "new", { ...h.context(6), assistantMessageId: "new-a6" })
    gate.resolve()
    await h.drain()
    expect(committed).not.toHaveBeenCalled()
    expect(h.deps.judgeMemory).toHaveBeenCalledTimes(2)
    expect(vi.mocked(h.deps.judgeMemory).mock.calls[1][0][5].assistantReply).toBe("new")
  })

  it("retries restoration without duplicating pending turns after a temporary source read failure", async () => {
    const h = harness()
    await h.add(1)
    await h.drain()
    const restarted = new MemoryScheduler(h.deps)
    vi.spyOn(h.deps, "loadConversationMessages").mockRejectedValueOnce(new Error("temporarily unreadable"))
    await restarted.reconcileConversation("chat").catch(() => {})
    await restarted.reconcileConversation("chat")
    expect(h.disk().map((turn) => turn.userMessageId)).toEqual(["u1"])
    expect(h.count()).toBe(1)
  })
})
