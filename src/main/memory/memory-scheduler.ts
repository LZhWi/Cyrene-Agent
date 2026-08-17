import { enqueueLLMTask } from "../llm-queue"
import { runReflectionAndCompression } from "./memory-compressor"
import { entityGraph } from "./entity-graph"
import { memoryJudge } from "./memory-judge"
import { memoryManager } from "./memory-manager"
import { runResolverQueueOnce } from "./memory-resolver"
import { memoryStore } from "./memory-store"
import type { L1Profile, MemoryCandidate, MemoryJudgeTurn } from "./memory-types"

const MEMORY_JUDGE_INTERVAL = 6
const MEMORY_JUDGE_CONTEXT_TURNS = 8
/** L2 生命周期衰减最小间隔：每 24 小时最多跑一次 */
const DECAY_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000

export interface MemorySchedulerDeps {
  ingestEntity: (text: string) => void
  enqueueTask: <T>(label: string, task: () => Promise<T>) => Promise<T>
  judgeMemory: (turns: MemoryJudgeTurn[], conversationId: string) => Promise<MemoryCandidate[]>
  writeMemory: (candidates: MemoryCandidate[]) => Promise<void>
  getL1: () => Promise<L1Profile>
  replaceL1Field: (field: "roundCount", value: number) => Promise<void>
  runReflectionAndCompression: () => Promise<unknown>
  runResolverQueueOnce: () => Promise<unknown>
  getLastDecayAt: () => Promise<number>
  runDecay: () => Promise<void>
  loadPendingTurns: () => Promise<MemoryJudgeTurn[]>
  savePendingTurns: (turns: MemoryJudgeTurn[]) => Promise<void>
}

export class MemoryScheduler {
  private recentTurns: Array<MemoryJudgeTurn & { seq: number }> = []
  private nextTurnSeq = 0
  /** 上次成功提取覆盖到的 seq 水位线；之后的轮次视为未提取残余 */
  private lastJudgedSeq = Number.NEGATIVE_INFINITY
  /** 重启后恢复残余轮次，只跑一次 */
  private restorePromise: Promise<void> | null = null

  constructor(private readonly deps: MemorySchedulerDeps) {}

  /** 把重启前未提取的轮次前插回缓冲区；seq 取 ≤0，永不与本次会话的新轮次（seq ≥ 1）碰撞 */
  private ensureRestored(): Promise<void> {
    if (!this.restorePromise) {
      this.restorePromise = (async () => {
        try {
          const persisted = await this.deps.loadPendingTurns()
          if (persisted.length === 0) return
          const restored = persisted.map((turn, index) => ({
            userInput: turn.userInput,
            assistantReply: turn.assistantReply,
            seq: index - persisted.length + 1,
          }))
          this.recentTurns = [...restored, ...this.recentTurns].slice(-MEMORY_JUDGE_CONTEXT_TURNS * 2)
          console.log(`[Memory] 已恢复重启前未提取的 ${persisted.length} 轮对话`)
        } catch (err) {
          console.warn("[Memory] 恢复未提取轮次失败，不影响主流程", err)
        }
      })()
    }
    return this.restorePromise
  }

  scheduleMemoryWrite(userInput: string, assistantReply: string): void {
    const seq = ++this.nextTurnSeq
    this.recentTurns.push({ seq, userInput, assistantReply })
    if (this.recentTurns.length > MEMORY_JUDGE_CONTEXT_TURNS * 2) {
      this.recentTurns = this.recentTurns.slice(-MEMORY_JUDGE_CONTEXT_TURNS * 2)
    }

    try {
      this.deps.ingestEntity(userInput)
      this.deps.ingestEntity(assistantReply)
    } catch (err) {
      console.warn("[Memory] 实体图谱提取失败:", err)
    }

    this.deps.enqueueTask("MemoryMaintenance", async () => {
      await this.runQueuedMemoryWrite(seq)
    }).catch((e) => {
      console.error("[Memory] 记忆写入失败，不影响主流程", e)
    })
  }

  private async runQueuedMemoryWrite(seq: number): Promise<void> {
    await this.ensureRestored()
    const l1 = await this.deps.getL1()
    const newCount = (l1.roundCount || 0) + 1

    if (newCount % MEMORY_JUDGE_INTERVAL === 0) {
      try {
        const turns = this.recentTurns
          .filter((turn) => turn.seq <= seq)
          .slice(-MEMORY_JUDGE_CONTEXT_TURNS)
          .map(({ userInput, assistantReply }) => ({ userInput, assistantReply }))
        const candidates = await this.deps.judgeMemory(turns, "default")

        if (candidates.length > 0) {
          await this.deps.writeMemory(candidates)
        }
        // 提取成功（含“无值得记”）才推进水位线；失败时不推，轮次保留待下次重试
        this.lastJudgedSeq = seq
      } catch (err) {
        console.error("[Memory] MemoryJudge/Manager 执行失败，本轮仍会计数", err)
      }
    }

    // 每轮固化水位线之后的残余轮次，重启不丢；失败不影响主流程。
    try {
      const residue = this.recentTurns
        .filter((turn) => turn.seq > this.lastJudgedSeq)
        .map(({ userInput, assistantReply }) => ({ userInput, assistantReply }))
      await this.deps.savePendingTurns(residue)
    } catch (err) {
      console.warn("[Memory] 持久化未提取轮次失败，不影响主流程", err)
    }

    await this.deps.replaceL1Field("roundCount", newCount)

    if (newCount % 5 === 0) {
      try {
        await this.deps.runResolverQueueOnce()
      } catch (err) {
        console.warn("[Memory] Resolver 队列处理失败，不影响主流程", err)
      }
    }

    if (newCount % 20 === 0) {
      console.log("[Memory] 达到 20 轮，触发 Reflection + 记忆压缩")
      await this.deps.runReflectionAndCompression()
    }

    // 每日一次的 L2 生命周期衰减；失败不影响主流程。
    try {
      const lastDecayAt = await this.deps.getLastDecayAt()
      if (Date.now() - lastDecayAt >= DECAY_MIN_INTERVAL_MS) {
        await this.deps.runDecay()
      }
    } catch (err) {
      console.warn("[Memory] L2 权重衰减失败，不影响主流程", err)
    }
  }
}

export const memoryScheduler = new MemoryScheduler({
  ingestEntity: (text) => entityGraph.ingest(text),
  enqueueTask: enqueueLLMTask,
  judgeMemory: (turns, conversationId) => memoryJudge.judgeRecentTurns(turns, conversationId),
  writeMemory: (candidates) => memoryManager.writeMemory(candidates),
  getL1: () => memoryStore.getL1(),
  replaceL1Field: (field, value) => memoryStore.replaceL1Field(field, value),
  runReflectionAndCompression,
  runResolverQueueOnce,
  getLastDecayAt: () => memoryStore.getLastDecayAt(),
  runDecay: () => memoryManager.runDecay(),
  loadPendingTurns: () => memoryStore.getPendingTurns(),
  savePendingTurns: (turns) => memoryStore.setPendingTurns(turns),
})
