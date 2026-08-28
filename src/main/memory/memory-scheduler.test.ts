import { describe, expect, it, vi } from "vitest"
import { attachCandidateSourceTimes, MemoryScheduler } from "./memory-scheduler"
import type { MemorySchedulerDeps } from "./memory-scheduler"
import type { MemoryCandidate, MemoryJudgeTurn } from "./memory-types"

function createScheduler(overrides: Partial<MemorySchedulerDeps> = {}) {
  const calls: string[] = []
  const enqueueLabels: string[] = []
  let roundCount = 0
  let queue = Promise.resolve()
  const deps: MemorySchedulerDeps = {
    ingestEntity: vi.fn((text: string) => {
      calls.push(`ingest:${text}`)
    }),
    enqueueTask: <T>(label: string, task: () => Promise<T>) => {
      enqueueLabels.push(label)
      calls.push("enqueue")
      const run = queue.then(task)
      queue = run.then(() => undefined, () => undefined)
      return run
    },
    judgeMemory: vi.fn(async () => [] as MemoryCandidate[]),
    writeMemory: vi.fn(async () => {
      calls.push("write")
    }),
    getL1: vi.fn(async () => ({
      recentGoals: "",
      recentPreferences: "",
      currentProject: "",
      generatedAt: 0,
        roundCount,
      })),
    replaceL1Field: vi.fn(async (_field: "roundCount", value: number) => {
      roundCount = value
      calls.push(`round:${value}`)
    }),
    runReflectionAndCompression: vi.fn(async () => {
      calls.push("reflection")
    }),
    runResolverQueueOnce: vi.fn(async () => {
      calls.push("resolver")
    }),
    // 默认“刚刚跑过”，避免无关用例触发 decay
    getLastDecayAt: vi.fn(async () => Date.now()),
    runDecay: vi.fn(async () => {
      calls.push("decay")
    }),
    // 默认无残余轮次；用例可覆盖模拟重启恢复
    loadPendingTurns: vi.fn(async () => [] as MemoryJudgeTurn[]),
    savePendingTurns: vi.fn(async () => {
      calls.push("savePending")
    }),
    loadConversationMessages: vi.fn(async () => null),
    ...overrides,
  }

  return { scheduler: new MemoryScheduler(deps), deps, calls, enqueueLabels }
}

describe("MemoryScheduler", () => {
  it("defers MemoryJudge until every sixth round", async () => {
    const { scheduler, deps, enqueueLabels } = createScheduler()

    for (let i = 1; i <= 5; i++) {
      scheduler.scheduleMemoryWrite(`user ${i}`, `assistant ${i}`)
    }
    await vi.waitFor(() => expect(deps.replaceL1Field).toHaveBeenCalledWith("roundCount", 5))

    expect(deps.ingestEntity).toHaveBeenCalledTimes(10)
    expect(enqueueLabels).toEqual(["MemoryMaintenance", "MemoryMaintenance", "MemoryMaintenance", "MemoryMaintenance", "MemoryMaintenance"])
    expect(deps.judgeMemory).not.toHaveBeenCalled()
    expect(deps.writeMemory).not.toHaveBeenCalled()
  })

  it("runs MemoryJudge on the sixth round with turns 1 through 6", async () => {
    const candidate: MemoryCandidate = {
      layer: "L2",
      summary: "用户喜欢香菇",
      content: "用户喜欢香菇",
      confidence: 0.9,
      triggerText: "我喜欢香菇",
      importance: "medium",
      stability: "situational",
      certainty: "explicit",
      attribution: "user_explicit",
      evidenceQuotes: ["我喜欢香菇"],
      contextSummary: "用户表达食物偏好",
      shouldWrite: true,
      reason: "用户明确表达",
      forbiddenOverclaims: [],
    }
    const { scheduler, deps } = createScheduler({
      judgeMemory: vi.fn(async () => [candidate]),
    })

    for (let i = 1; i <= 6; i++) {
      scheduler.scheduleMemoryWrite(`user ${i}`, `assistant ${i}`)
    }
    await vi.waitFor(() => expect(deps.writeMemory).toHaveBeenCalledTimes(1))
    const [written] = vi.mocked(deps.writeMemory).mock.calls[0][0]
    expect(written).toMatchObject(candidate)
    expect(written.sourceAt).toBe(written.createdAt)
    expect(written.sourceEndAt).toBe(written.createdAt)

    const turns = vi.mocked(deps.judgeMemory).mock.calls[0][0]
    expect(turns.map((turn: MemoryJudgeTurn) => turn.userInput)).toEqual([
      "user 1",
      "user 2",
      "user 3",
      "user 4",
      "user 5",
      "user 6",
    ])
    expect(deps.replaceL1Field).toHaveBeenCalledWith("roundCount", 6)
  })

  it("uses an overlapping 8-turn window on later MemoryJudge runs", async () => {
    const { scheduler, deps } = createScheduler()

    for (let i = 1; i <= 12; i++) {
      scheduler.scheduleMemoryWrite(`user ${i}`, `assistant ${i}`)
    }
    await vi.waitFor(() => expect(deps.replaceL1Field).toHaveBeenCalledWith("roundCount", 12))

    expect(deps.judgeMemory).toHaveBeenCalledTimes(2)
    const secondTurns = vi.mocked(deps.judgeMemory).mock.calls[1][0]
    expect(secondTurns.map((turn: MemoryJudgeTurn) => turn.userInput)).toEqual([
      "user 5",
      "user 6",
      "user 7",
      "user 8",
      "user 9",
      "user 10",
      "user 11",
      "user 12",
    ])
  })

  it("still increments round count when judging fails", async () => {
    const { scheduler, deps } = createScheduler({
      judgeMemory: vi.fn(async () => {
        throw new Error("judge failed")
      }),
    })

    scheduler.scheduleMemoryWrite("user", "assistant")
    await vi.waitFor(() => expect(deps.replaceL1Field).toHaveBeenCalledWith("roundCount", 1))

    expect(deps.judgeMemory).not.toHaveBeenCalled()
    expect(deps.writeMemory).not.toHaveBeenCalled()
  })

  it("runs reflection and compression on every twentieth round", async () => {
    const { scheduler, deps } = createScheduler({
      getL1: vi.fn(async () => ({
        recentGoals: "",
        recentPreferences: "",
        currentProject: "",
        generatedAt: 0,
        roundCount: 19,
      })),
    })

    scheduler.scheduleMemoryWrite("user", "assistant")
    await vi.waitFor(() => expect(deps.runReflectionAndCompression).toHaveBeenCalled())

    expect(deps.replaceL1Field).toHaveBeenCalledWith("roundCount", 20)
  })

  it("runs one resolver queue item every fifth round", async () => {
    const { scheduler, deps } = createScheduler({
      getL1: vi.fn(async () => ({
        recentGoals: "",
        recentPreferences: "",
        currentProject: "",
        generatedAt: 0,
        roundCount: 4,
      })),
    })

    scheduler.scheduleMemoryWrite("user", "assistant")
    await vi.waitFor(() => expect(deps.runResolverQueueOnce).toHaveBeenCalled())

    expect(deps.replaceL1Field).toHaveBeenCalledWith("roundCount", 5)
  })

  it("runs decay when the last run is older than 24 hours", async () => {
    const { scheduler, deps } = createScheduler({
      getLastDecayAt: vi.fn(async () => 0),
    })

    scheduler.scheduleMemoryWrite("user", "assistant")
    await vi.waitFor(() => expect(deps.runDecay).toHaveBeenCalledTimes(1))
  })

  it("skips decay when it already ran within 24 hours", async () => {
    const { scheduler, deps } = createScheduler({
      getLastDecayAt: vi.fn(async () => Date.now() - 60 * 1000),
    })

    scheduler.scheduleMemoryWrite("user", "assistant")
    await vi.waitFor(() => expect(deps.replaceL1Field).toHaveBeenCalledWith("roundCount", 1))

    expect(deps.runDecay).not.toHaveBeenCalled()
  })

  it("keeps counting rounds when decay fails", async () => {
    const { scheduler, deps } = createScheduler({
      getLastDecayAt: vi.fn(async () => 0),
      runDecay: vi.fn(async () => {
        throw new Error("decay failed")
      }),
    })

    scheduler.scheduleMemoryWrite("user 1", "assistant 1")
    scheduler.scheduleMemoryWrite("user 2", "assistant 2")
    await vi.waitFor(() => expect(deps.replaceL1Field).toHaveBeenCalledWith("roundCount", 2))
  })

  it("restores persisted pending turns into the first judge window after restart", async () => {
    let roundCount = 5
    const persisted: MemoryJudgeTurn[] = Array.from({ length: 5 }, (_, i) => ({
      userInput: `old user ${i + 1}`,
      assistantReply: `old assistant ${i + 1}`,
      conversationId: "default",
      userMessageId: `old-u${i + 1}`,
      assistantMessageId: `old-a${i + 1}`,
      userAt: i * 1000,
      assistantAt: i * 1000 + 500,
      validateAgainstConversation: false,
    }))
    const { scheduler, deps } = createScheduler({
      loadPendingTurns: vi.fn(async () => persisted),
      getL1: vi.fn(async () => ({
        recentGoals: "",
        recentPreferences: "",
        currentProject: "",
        generatedAt: 0,
        roundCount,
      })),
      replaceL1Field: vi.fn(async (_field: "roundCount", value: number) => {
        roundCount = value
      }),
    })

    // 重启后第一轮就凑满 6 轮，触发 judge
    scheduler.scheduleMemoryWrite("new user", "new assistant")
    await vi.waitFor(() => expect(deps.judgeMemory).toHaveBeenCalledTimes(1))

    const turns = (deps.judgeMemory as ReturnType<typeof vi.fn>).mock.calls[0][0] as MemoryJudgeTurn[]
    expect(turns).toHaveLength(6)
    expect(turns[0]).toMatchObject({ userInput: "old user 1", assistantReply: "old assistant 1" })
    expect(turns[5]).toMatchObject({ userInput: "new user", assistantReply: "new assistant" })
  })

  it("processes restored backlog in oldest six-turn batches and keeps two prior turns as context", async () => {
    let roundCount = 9
    let persisted: MemoryJudgeTurn[] = Array.from({ length: 9 }, (_, index) => ({
      userInput: `user ${index + 1}`,
      assistantReply: `assistant ${index + 1}`,
      conversationId: "default",
      userMessageId: `u${index + 1}`,
      assistantMessageId: `a${index + 1}`,
      userAt: (index + 1) * 1000,
      assistantAt: (index + 1) * 1000 + 500,
      validateAgainstConversation: false,
    }))
    const { scheduler, deps } = createScheduler({
      loadPendingTurns: vi.fn(async () => persisted.map((turn) => ({ ...turn }))),
      savePendingTurns: vi.fn(async (turns: MemoryJudgeTurn[]) => {
        persisted = turns.map((turn) => ({ ...turn }))
      }),
      getL1: vi.fn(async () => ({
        recentGoals: "",
        recentPreferences: "",
        currentProject: "",
        generatedAt: 0,
        roundCount,
      })),
      replaceL1Field: vi.fn(async (_field: "roundCount", value: number) => {
        roundCount = value
      }),
    })

    scheduler.scheduleMemoryWrite("user 10", "assistant 10", {
      conversationId: "default",
      userMessageId: "u10",
      assistantMessageId: "a10",
      userAt: 10_000,
      assistantAt: 10_500,
    })
    await vi.waitFor(() => expect(deps.judgeMemory).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(persisted.map((turn) => turn.userMessageId)).toEqual(["u7", "u8", "u9", "u10"]))
    expect(vi.mocked(deps.judgeMemory).mock.calls[0][0].map((turn: MemoryJudgeTurn) => turn.userMessageId)).toEqual([
      "u1", "u2", "u3", "u4", "u5", "u6",
    ])

    for (let turn = 11; turn <= 12; turn++) {
      scheduler.scheduleMemoryWrite(`user ${turn}`, `assistant ${turn}`, {
        conversationId: "default",
        userMessageId: `u${turn}`,
        assistantMessageId: `a${turn}`,
        userAt: turn * 1000,
        assistantAt: turn * 1000 + 500,
      })
    }
    await vi.waitFor(() => expect(deps.judgeMemory).toHaveBeenCalledTimes(2))
    expect(vi.mocked(deps.judgeMemory).mock.calls[1][0].map((turn: MemoryJudgeTurn) => turn.userMessageId)).toEqual([
      "u5", "u6", "u7", "u8", "u9", "u10", "u11", "u12",
    ])
    await vi.waitFor(() => expect(persisted).toEqual([]))
  })

  it("persists residue every round and clears it after a successful judge", async () => {
    const savedBatches: MemoryJudgeTurn[][] = []
    const { scheduler, deps } = createScheduler({
      savePendingTurns: vi.fn(async (turns: MemoryJudgeTurn[]) => {
        savedBatches.push(turns)
      }),
    })

    for (let i = 1; i <= 6; i++) {
      scheduler.scheduleMemoryWrite(`user ${i}`, `assistant ${i}`)
    }
    await vi.waitFor(() => expect(deps.replaceL1Field).toHaveBeenCalledWith("roundCount", 6))

    // 轮次一入缓冲即被固化（后到的轮次也提前受保护）；第 6 轮 judge 成功后水位线推进，残余清空
    expect(savedBatches[4]).toHaveLength(6)
    expect(savedBatches[5]).toEqual([])
  })

  it("converts temporary evidence turn refs into source times without persisting message IDs", async () => {
    const candidate: MemoryCandidate = {
      layer: "L2",
      content: "用户明天去玩剧本杀",
      confidence: 0.9,
      triggerText: "我明天去玩剧本杀",
      evidenceTurnRefs: ["T2", "T4"],
    }
    const { scheduler, deps } = createScheduler({
      judgeMemory: vi.fn(async () => [candidate]),
    })
    for (let index = 1; index <= 6; index++) {
      scheduler.scheduleMemoryWrite(index === 2 ? "我明天去玩剧本杀" : `user ${index}`, `assistant ${index}`, {
        userAt: index * 1000,
        assistantAt: index * 1000 + 500,
      })
    }

    await vi.waitFor(() => expect(deps.writeMemory).toHaveBeenCalledTimes(1))
    const [written] = vi.mocked(deps.writeMemory).mock.calls[0][0]
    expect(written.sourceAt).toBe(2000)
    expect(written.sourceEndAt).toBe(4000)
    expect(written).not.toHaveProperty("sourceMessageIds")
  })

  it("replaces syntactically valid but semantically wrong refs with the triggerText turn", () => {
    const turns: MemoryJudgeTurn[] = [
      { userInput: "我今天在家休息", assistantReply: "好哦", userAt: 1000 },
      { userInput: "我明天去玩剧本杀。", assistantReply: "等你回来", userAt: 2000 },
    ]
    const [candidate] = attachCandidateSourceTimes([{
      layer: "L2",
      content: "用户明天去玩剧本杀",
      confidence: 0.9,
      triggerText: "我明天去玩剧本杀",
      evidenceTurnRefs: ["T1"],
    }], turns)

    expect(candidate.sourceAt).toBe(2000)
    expect(candidate.sourceEndAt).toBe(2000)
  })

  it("keeps a multi-turn range when at least one referenced turn matches triggerText", () => {
    const turns: MemoryJudgeTurn[] = [
      { userInput: "我报名了舞会", assistantReply: "真好", userAt: 1000 },
      { userInput: "教程真的很有用", assistantReply: "太好了", userAt: 2000 },
      { userInput: "说起别的事情", assistantReply: "嗯嗯", userAt: 3000 },
    ]
    const [candidate] = attachCandidateSourceTimes([{
      layer: "L2",
      content: "用户报名舞会并认为教程有用",
      confidence: 0.9,
      triggerText: "教程真的很有用",
      evidenceTurnRefs: ["T1", "T2"],
    }], turns)

    expect(candidate.sourceAt).toBe(1000)
    expect(candidate.sourceEndAt).toBe(2000)
  })

  it("uses the candidate creation time when triggerText has no unique turn", () => {
    const turns: MemoryJudgeTurn[] = [
      { userInput: "重复片段", assistantReply: "第一次", userAt: 1000 },
      { userInput: "重复片段", assistantReply: "第二次", userAt: 2000 },
    ]
    const [candidate] = attachCandidateSourceTimes([{
      layer: "L2",
      content: "无法唯一定位的记忆",
      confidence: 0.9,
      triggerText: "重复片段",
      evidenceTurnRefs: ["T9", "t1"],
      createdAt: 9000,
    }], turns)

    expect(candidate.createdAt).toBe(9000)
    expect(candidate.sourceAt).toBe(9000)
    expect(candidate.sourceEndAt).toBe(9000)
  })

  it("drops legacy pending text snapshots that cannot be checked against deleted chat messages", async () => {
    const legacy = Array.from({ length: 5 }, (_, index) => ({
      userInput: `legacy user ${index + 1}`,
      assistantReply: `legacy assistant ${index + 1}`,
    }))
    const saved: MemoryJudgeTurn[][] = []
    const { scheduler, deps } = createScheduler({
      loadPendingTurns: vi.fn(async () => legacy),
      savePendingTurns: vi.fn(async (turns) => { saved.push(turns) }),
    })

    scheduler.scheduleMemoryWrite("new user", "new assistant")
    await vi.waitFor(() => expect(deps.replaceL1Field).toHaveBeenCalledWith("roundCount", 1))

    expect(deps.judgeMemory).not.toHaveBeenCalled()
    expect(saved.at(-1)).toHaveLength(1)
    expect(saved.at(-1)?.[0].userInput).toBe("new user")
  })

  it("counts only still-existing new message IDs and excludes a deleted round from the judge window", async () => {
    const messages = Array.from({ length: 7 }, (_, index) => {
      const turn = index + 1
      return [
        { id: `u${turn}`, role: "user" as const, content: `stored user ${turn}`, at: turn * 1000 },
        { id: `a${turn}`, role: "model" as const, content: `stored assistant ${turn}`, at: turn * 1000 + 500 },
      ]
    }).flat().filter((message) => message.id !== "u2" && message.id !== "a2")
    const { scheduler, deps } = createScheduler({
      loadConversationMessages: vi.fn(async () => messages),
    })

    for (let turn = 1; turn <= 6; turn++) {
      scheduler.scheduleMemoryWrite(`live user ${turn}`, `live assistant ${turn}`, {
        conversationId: "chat-1",
        userMessageId: `u${turn}`,
        assistantMessageId: `a${turn}`,
        userAt: turn * 1000,
        assistantAt: turn * 1000 + 500,
        validateAgainstConversation: true,
      })
    }
    await vi.waitFor(() => expect(deps.replaceL1Field).toHaveBeenCalledWith("roundCount", 6))
    expect(deps.judgeMemory).not.toHaveBeenCalled()

    scheduler.scheduleMemoryWrite("live user 7", "live assistant 7", {
      conversationId: "chat-1",
      userMessageId: "u7",
      assistantMessageId: "a7",
      userAt: 7000,
      assistantAt: 7500,
      validateAgainstConversation: true,
    })
    await vi.waitFor(() => expect(deps.judgeMemory).toHaveBeenCalledTimes(1))

    const turns = vi.mocked(deps.judgeMemory).mock.calls[0][0]
    expect(turns.map((turn) => turn.userInput)).toEqual([
      "live user 1",
      "live user 3",
      "live user 4",
      "live user 5",
      "live user 6",
      "live user 7",
    ])
    expect(turns.some((turn) => turn.userMessageId === "u2")).toBe(false)
  })

  it("does not count the same user message ID twice", async () => {
    const messages = [
      { id: "u1", role: "user" as const, content: "stored user", at: 1000 },
      { id: "a1", role: "model" as const, content: "stored assistant", at: 1500 },
    ]
    const { scheduler, deps } = createScheduler({
      loadConversationMessages: vi.fn(async () => messages),
    })

    for (let attempt = 0; attempt < 6; attempt++) {
      scheduler.scheduleMemoryWrite("live user", "live assistant", {
        conversationId: "chat-1",
        userMessageId: "u1",
        assistantMessageId: "a1",
        userAt: 1000,
        assistantAt: 1500,
        validateAgainstConversation: true,
      })
    }
    await vi.waitFor(() => expect(deps.replaceL1Field).toHaveBeenCalledWith("roundCount", 6))
    expect(deps.judgeMemory).not.toHaveBeenCalled()
  })

  it("discards the whole judge result when a source round is deleted while the judge is running", async () => {
    let resolveJudge!: (candidates: MemoryCandidate[]) => void
    const firstJudge = new Promise<MemoryCandidate[]>((resolve) => {
      resolveJudge = resolve
    })
    const candidate: MemoryCandidate = {
      layer: "L2",
      content: "用户正在准备一份礼物",
      confidence: 0.9,
      triggerText: "我正在准备礼物",
    }
    const messages = Array.from({ length: 7 }, (_, index) => {
      const turn = index + 1
      return [
        { id: `u${turn}`, role: "user" as const, content: `stored user ${turn}`, at: turn * 1000 },
        { id: `a${turn}`, role: "model" as const, content: `stored assistant ${turn}`, at: turn * 1000 + 500 },
      ]
    }).flat()
    const savedBatches: MemoryJudgeTurn[][] = []
    const judgeMemory = vi.fn()
      .mockImplementationOnce(() => firstJudge)
      .mockResolvedValueOnce([candidate])
    const { scheduler, deps } = createScheduler({
      judgeMemory,
      loadConversationMessages: vi.fn(async () => messages),
      savePendingTurns: vi.fn(async (turns: MemoryJudgeTurn[]) => {
        savedBatches.push(turns.map((turn) => ({ ...turn })))
      }),
    })

    for (let turn = 1; turn <= 6; turn++) {
      scheduler.scheduleMemoryWrite(`live user ${turn}`, `live assistant ${turn}`, {
        conversationId: "chat-1",
        userMessageId: `u${turn}`,
        assistantMessageId: `a${turn}`,
        userAt: turn * 1000,
        assistantAt: turn * 1000 + 500,
        validateAgainstConversation: true,
      })
    }
    await vi.waitFor(() => expect(judgeMemory).toHaveBeenCalledTimes(1))

    messages.splice(messages.findIndex((message) => message.id === "u2"), 2)
    resolveJudge([candidate])
    await vi.waitFor(() => expect(deps.replaceL1Field).toHaveBeenCalledWith("roundCount", 6))

    expect(deps.writeMemory).not.toHaveBeenCalled()
    expect(savedBatches.at(-1)?.map((turn) => turn.userMessageId)).toEqual(["u1", "u3", "u4", "u5", "u6"])

    scheduler.scheduleMemoryWrite("live user 7", "live assistant 7", {
      conversationId: "chat-1",
      userMessageId: "u7",
      assistantMessageId: "a7",
      userAt: 7000,
      assistantAt: 7500,
      validateAgainstConversation: true,
    })
    await vi.waitFor(() => expect(deps.writeMemory).toHaveBeenCalledTimes(1))
    const [writtenAfterRetry] = vi.mocked(deps.writeMemory).mock.calls[0][0]
    expect(writtenAfterRetry).toMatchObject(candidate)
    expect(writtenAfterRetry.sourceAt).toBe(writtenAfterRetry.createdAt)
    expect(writtenAfterRetry.sourceEndAt).toBe(writtenAfterRetry.createdAt)

    expect(judgeMemory).toHaveBeenCalledTimes(2)
    expect(vi.mocked(judgeMemory).mock.calls[1][0].some((turn: MemoryJudgeTurn) => turn.userMessageId === "u2")).toBe(false)
  })

  it("does not restore successfully cleared turns on a later restart", async () => {
    let persisted: MemoryJudgeTurn[] = Array.from({ length: 5 }, (_, i) => ({
      userInput: `old user ${i + 1}`,
      assistantReply: `old assistant ${i + 1}`,
      conversationId: "default",
      userMessageId: `old-u${i + 1}`,
      assistantMessageId: `old-a${i + 1}`,
      userAt: i * 1000,
      assistantAt: i * 1000 + 500,
      validateAgainstConversation: false,
    }))
    let roundCount = 5
    const first = createScheduler({
      loadPendingTurns: vi.fn(async () => persisted.map((turn) => ({ ...turn }))),
      savePendingTurns: vi.fn(async (turns: MemoryJudgeTurn[]) => {
        persisted = turns.map((turn) => ({ ...turn }))
      }),
      getL1: vi.fn(async () => ({ recentGoals: "", recentPreferences: "", currentProject: "", generatedAt: 0, roundCount })),
      replaceL1Field: vi.fn(async (_field: "roundCount", value: number) => { roundCount = value }),
    })
    first.scheduler.scheduleMemoryWrite("new user", "new assistant")
    await vi.waitFor(() => expect(first.deps.judgeMemory).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(persisted).toEqual([]))

    const second = createScheduler({
      loadPendingTurns: vi.fn(async () => persisted.map((turn) => ({ ...turn }))),
      getL1: vi.fn(async () => ({ recentGoals: "", recentPreferences: "", currentProject: "", generatedAt: 0, roundCount })),
    })
    second.scheduler.scheduleMemoryWrite("later user", "later assistant")
    await vi.waitFor(() => expect(second.deps.replaceL1Field).toHaveBeenCalled())
    expect(second.deps.judgeMemory).not.toHaveBeenCalled()
  })

  it("keeps residue when judge fails so a restart can retry extraction", async () => {
    const savedBatches: MemoryJudgeTurn[][] = []
    const { scheduler, deps } = createScheduler({
      judgeMemory: vi.fn(async () => {
        throw new Error("judge failed")
      }),
      savePendingTurns: vi.fn(async (turns: MemoryJudgeTurn[]) => {
        savedBatches.push(turns)
      }),
    })

    for (let i = 1; i <= 6; i++) {
      scheduler.scheduleMemoryWrite(`user ${i}`, `assistant ${i}`)
    }
    await vi.waitFor(() => expect(deps.replaceL1Field).toHaveBeenCalledWith("roundCount", 6))

    // judge 失败不推水位线，6 轮全部保留待重试
    expect(savedBatches[5]).toHaveLength(6)
  })

  it("retries the oldest live batch and preserves newer turns after repeated judge failures", async () => {
    let attempts = 0
    let persisted: MemoryJudgeTurn[] = []
    const { scheduler, deps } = createScheduler({
      judgeMemory: vi.fn(async () => {
        attempts += 1
        if (attempts < 4) throw new Error("judge failed")
        return []
      }),
      savePendingTurns: vi.fn(async (turns: MemoryJudgeTurn[]) => {
        persisted = turns.map((turn) => ({ ...turn }))
      }),
    })

    for (let turn = 1; turn <= 9; turn++) {
      scheduler.scheduleMemoryWrite(`user ${turn}`, `assistant ${turn}`, {
        conversationId: "default",
        userMessageId: `u${turn}`,
        assistantMessageId: `a${turn}`,
        userAt: turn * 1000,
        assistantAt: turn * 1000 + 500,
      })
    }

    await vi.waitFor(() => expect(deps.judgeMemory).toHaveBeenCalledTimes(4))
    for (const [turns] of vi.mocked(deps.judgeMemory).mock.calls) {
      expect(turns.map((turn: MemoryJudgeTurn) => turn.userMessageId)).toEqual([
        "u1", "u2", "u3", "u4", "u5", "u6",
      ])
    }
    await vi.waitFor(() => expect(persisted.map((turn) => turn.userMessageId)).toEqual(["u7", "u8", "u9"]))
  })
})
