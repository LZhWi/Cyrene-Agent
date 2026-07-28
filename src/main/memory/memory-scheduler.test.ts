import { describe, expect, it, vi } from "vitest"
import { MemoryScheduler } from "./memory-scheduler"
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
    await vi.waitFor(() => expect(deps.writeMemory).toHaveBeenCalledWith([candidate]))

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
    expect(turns[0]).toEqual({ userInput: "old user 1", assistantReply: "old assistant 1" })
    expect(turns[5]).toEqual({ userInput: "new user", assistantReply: "new assistant" })
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
})
