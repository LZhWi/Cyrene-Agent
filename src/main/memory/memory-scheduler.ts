import { enqueueLLMTask } from "../llm-queue"
import * as chatsStore from "../chats/chats-store"
import { runReflectionAndCompression } from "./memory-compressor"
import { entityGraph } from "./entity-graph"
import { memoryJudge } from "./memory-judge"
import { memoryManager } from "./memory-manager"
import { runResolverQueueOnce } from "./memory-resolver"
import { memoryStore } from "./memory-store"
import type { L1Profile, MemoryCandidate, MemoryJudgeTurn } from "./memory-types"

const MEMORY_JUDGE_INTERVAL = 6
const MEMORY_JUDGE_CONTEXT_TURNS = 8
const MAX_PENDING_TURN_REFS = 128
const MAX_CONTEXT_TURN_REFS = MAX_PENDING_TURN_REFS + MEMORY_JUDGE_CONTEXT_TURNS - MEMORY_JUDGE_INTERVAL
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
  loadConversationMessages: (conversationId: string) => Promise<MemoryConversationMessage[] | null>
}

export interface MemoryConversationMessage {
  id: string
  role: "user" | "model"
  content: string
  at: number
}

export interface MemoryScheduleContext {
  conversationId: string
  userMessageId: string
  assistantMessageId: string
  userAt: number
  assistantAt: number
  validateAgainstConversation: boolean
}

function hasTurnIdentity(turn: MemoryJudgeTurn): boolean {
  return Boolean(turn.conversationId && turn.userMessageId && turn.assistantMessageId)
}

function sameTurn(a: MemoryJudgeTurn, b: MemoryJudgeTurn): boolean {
  return a.conversationId === b.conversationId && a.userMessageId === b.userMessageId
}

function normalizedEvidenceText(value: string | undefined): string {
  return (value ?? "")
    .normalize("NFKC")
    .replace(/\[sticker:[^\]]+\]/giu, "")
    .replace(/[\s\p{P}\p{S}]/gu, "")
    .trim()
}

/**
 * 将 Judge 的本轮临时引用（T1…T8）换算为来源时间；不把轮次引用或消息 ID 写入 L2。
 * 合法引用必须至少有一轮与 triggerText 对应；引用指错时以 triggerText 唯一命中的轮次为准。
 * triggerText 无法唯一定位时使用本批候选创建时间，不把不确定性伪装成消息级精确时间。
 */
export function attachCandidateSourceTimes(
  candidates: MemoryCandidate[],
  turns: MemoryJudgeTurn[],
): MemoryCandidate[] {
  const batchCreatedAt = Date.now()
  return candidates.map((candidate) => {
    const referenced = [...new Set(candidate.evidenceTurnRefs ?? [])]
      .flatMap((ref) => {
        const match = /^T([1-8])$/.exec(ref)
        if (!match) return []
        const turn = turns[Number(match[1]) - 1]
        return turn ? [turn] : []
      })
    const triggerText = normalizedEvidenceText(candidate.triggerText)
    const triggerMatches = triggerText.length >= 4
      ? turns.filter((turn) => {
        const userText = normalizedEvidenceText(turn.userInput)
        return userText.includes(triggerText) || triggerText.includes(userText)
      })
      : []
    const referencedMatchesTrigger = referenced.some((turn) => triggerMatches.includes(turn))
    const sourceTurns = referencedMatchesTrigger
      ? referenced
      : triggerMatches.length === 1
        ? triggerMatches
        : []
    const times = sourceTurns
      .map((turn) => turn.userAt)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    if (times.length === 0) {
      const createdAt = candidate.createdAt ?? batchCreatedAt
      return {
        ...candidate,
        createdAt,
        sourceAt: createdAt,
        sourceEndAt: createdAt,
      }
    }
    return {
      ...candidate,
      sourceAt: Math.min(...times),
      sourceEndAt: Math.max(...times),
    }
  })
}

export function buildMemoryJudgeTurnsFromMessages(
  messages: MemoryConversationMessage[],
  overlays: MemoryJudgeTurn[] = [],
): MemoryJudgeTurn[] {
  const overlayByUserId = new Map(overlays.flatMap((turn) => (
    turn.userMessageId ? [[turn.userMessageId, turn] as const] : []
  )))
  const turns: MemoryJudgeTurn[] = []
  for (let index = 0; index < messages.length - 1; index += 1) {
    const user = messages[index]
    const assistant = messages[index + 1]
    if (user.role !== "user" || assistant.role !== "model" || !user.content.trim() || !assistant.content.trim()) continue
    const candidateOverlay = overlayByUserId.get(user.id)
    const overlay = candidateOverlay?.assistantMessageId === assistant.id ? candidateOverlay : undefined
    turns.push({
      userInput: overlay?.userInput ?? user.content,
      assistantReply: overlay?.assistantReply ?? assistant.content,
      userAt: user.at,
      assistantAt: assistant.at,
      conversationId: overlay?.conversationId,
      userMessageId: user.id,
      assistantMessageId: assistant.id,
      validateAgainstConversation: overlay?.validateAgainstConversation,
    })
    index += 1
  }
  return turns
}

export class MemoryScheduler {
  private recentTurns: Array<MemoryJudgeTurn & { seq: number }> = []
  private contextTurns: Array<MemoryJudgeTurn & { seq: number }> = []
  private nextTurnSeq = 0
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
          const identifiable = persisted.filter(hasTurnIdentity)
          if (identifiable.length !== persisted.length) {
            console.warn(`[Memory] 丢弃 ${persisted.length - identifiable.length} 条无法核对删除状态的旧 pendingTurns`)
          }
          const restored = identifiable.map((turn, index) => ({
            ...turn,
            seq: index - identifiable.length + 1,
          }))
          this.recentTurns = [...restored, ...this.recentTurns].slice(-MAX_PENDING_TURN_REFS)
          this.contextTurns = [...restored, ...this.contextTurns].slice(-MAX_CONTEXT_TURN_REFS)
          if (restored.length > 0) console.log(`[Memory] 已恢复重启前未提取的 ${restored.length} 轮对话引用`)
        } catch (err) {
          console.warn("[Memory] 恢复未提取轮次失败，不影响主流程", err)
        }
      })()
    }
    return this.restorePromise
  }

  scheduleMemoryWrite(userInput: string, assistantReply: string, context?: Partial<MemoryScheduleContext>): void {
    const seq = ++this.nextTurnSeq
    const now = Date.now()
    const turn: MemoryJudgeTurn & { seq: number } = {
      seq,
      userInput,
      assistantReply,
      conversationId: context?.conversationId || "default",
      userMessageId: context?.userMessageId || `runtime-user-${seq}`,
      assistantMessageId: context?.assistantMessageId || `runtime-assistant-${seq}`,
      userAt: typeof context?.userAt === "number" ? context.userAt : now,
      assistantAt: typeof context?.assistantAt === "number" ? context.assistantAt : now,
      validateAgainstConversation: context?.validateAgainstConversation === true,
    }
    const duplicate = this.recentTurns.find((existing) => sameTurn(existing, turn))
    if (duplicate) Object.assign(duplicate, turn, { seq: duplicate.seq })
    else this.recentTurns.push(turn)
    const contextDuplicate = this.contextTurns.find((existing) => sameTurn(existing, turn))
    if (contextDuplicate) Object.assign(contextDuplicate, turn, { seq: contextDuplicate.seq })
    else this.contextTurns.push(turn)
    if (this.recentTurns.length > MAX_PENDING_TURN_REFS) {
      this.recentTurns = this.recentTurns.slice(-MAX_PENDING_TURN_REFS)
    }
    if (this.contextTurns.length > MAX_CONTEXT_TURN_REFS) {
      this.contextTurns = this.contextTurns.slice(-MAX_CONTEXT_TURN_REFS)
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
    const current = this.recentTurns.find((turn) => turn.seq === seq)
    let eligible = this.recentTurns.filter((turn) => turn.seq <= seq)
    let conversationMessages: MemoryConversationMessage[] | null = null
    if (current?.validateAgainstConversation) {
      try {
        conversationMessages = await this.deps.loadConversationMessages(current.conversationId || "default")
        const messageIds = new Set(conversationMessages?.map((message) => message.id) ?? [])
        const invalidSeqs = new Set(eligible
          .filter((turn) => turn.validateAgainstConversation && turn.conversationId === current.conversationId)
          .filter((turn) => {
            const userExists = messageIds.has(turn.userMessageId || "")
            const assistantExists = messageIds.has(turn.assistantMessageId || "")
            return !userExists || (!assistantExists && turn.seq !== seq)
          })
          .map((turn) => turn.seq))
        if (invalidSeqs.size > 0) {
          this.recentTurns = this.recentTurns.filter((turn) => !invalidSeqs.has(turn.seq))
          this.contextTurns = this.contextTurns.filter((turn) => !invalidSeqs.has(turn.seq))
          eligible = eligible.filter((turn) => !invalidSeqs.has(turn.seq))
        }
      } catch (err) {
        console.warn("[Memory] 回查聊天轮次失败，本次不推进提取", err)
        conversationMessages = null
        eligible = eligible.filter((turn) => !turn.validateAgainstConversation)
      }
    }

    const conversationId = current?.conversationId || "default"
    const pendingForConversation = eligible
      .filter((turn) => turn.conversationId === conversationId)
      .filter((turn, index, turns) => (
        turns.findIndex((candidate) => candidate.userMessageId === turn.userMessageId) === index
      ))
    const newMessageIdCount = new Set(pendingForConversation.map((turn) => turn.userMessageId)).size
    const currentStillExists = current ? eligible.includes(current) : false

    if (current && currentStillExists && newMessageIdCount >= MEMORY_JUDGE_INTERVAL) {
      try {
        const pendingBatch = pendingForConversation.slice(0, MEMORY_JUDGE_INTERVAL)
        const batchTail = pendingBatch[pendingBatch.length - 1]
        let availableTurns: MemoryJudgeTurn[]
        if (current.validateAgainstConversation && conversationMessages) {
          const assistantIndex = conversationMessages.findIndex((message) => message.id === batchTail.assistantMessageId)
          const userIndex = conversationMessages.findIndex((message) => message.id === batchTail.userMessageId)
          const cutoff = assistantIndex >= 0 ? assistantIndex : userIndex
          const boundedMessages = cutoff >= 0 ? conversationMessages.slice(0, cutoff + 1) : []
          availableTurns = buildMemoryJudgeTurnsFromMessages(boundedMessages, pendingBatch)
        } else {
          availableTurns = this.contextTurns
            .filter((turn) => turn.seq <= batchTail.seq && turn.conversationId === conversationId)
            .map(({ seq: _seq, ...turn }) => turn)
        }
        const firstBatchIndex = availableTurns.findIndex((turn) => sameTurn(turn, pendingBatch[0]))
        const priorContext = firstBatchIndex > 0
          ? availableTurns.slice(0, firstBatchIndex).slice(-(MEMORY_JUDGE_CONTEXT_TURNS - MEMORY_JUDGE_INTERVAL))
          : []
        const turns = [...priorContext, ...pendingBatch]
        const candidates = attachCandidateSourceTimes(
          await this.deps.judgeMemory(turns, conversationId),
          turns,
        )

        let sourceBatchStillValid = true
        if (current.validateAgainstConversation) {
          try {
            const latestMessages = await this.deps.loadConversationMessages(conversationId)
            const latestMessageIds = new Set(latestMessages?.map((message) => message.id) ?? [])
            sourceBatchStillValid = turns.every((turn) => {
              const userExists = Boolean(turn.userMessageId && latestMessageIds.has(turn.userMessageId))
              const assistantExists = Boolean(turn.assistantMessageId && latestMessageIds.has(turn.assistantMessageId))
              const isCurrentTurn = turn.userMessageId === current.userMessageId
              return userExists && (assistantExists || isCurrentTurn)
            })
            if (!sourceBatchStillValid) {
              const invalidSeqs = new Set(this.recentTurns
                .filter((turn) => turn.validateAgainstConversation && turn.conversationId === conversationId)
                .filter((turn) => {
                  const userExists = latestMessageIds.has(turn.userMessageId || "")
                  const assistantExists = latestMessageIds.has(turn.assistantMessageId || "")
                  return !userExists || (!assistantExists && turn.userMessageId !== current.userMessageId)
                })
                .map((turn) => turn.seq))
              this.recentTurns = this.recentTurns.filter((turn) => !invalidSeqs.has(turn.seq))
              this.contextTurns = this.contextTurns.filter((turn) => !invalidSeqs.has(turn.seq))
              console.warn("[Memory] Judge 运行期间来源轮次被删除，本批候选作废并保留其余轮次待重提")
            }
          } catch (err) {
            sourceBatchStillValid = false
            console.warn("[Memory] Judge 返回后无法复核来源轮次，本批候选不落盘", err)
          }
        }

        if (sourceBatchStillValid) {
          if (candidates.length > 0) {
            await this.deps.writeMemory(candidates)
          }
          // 提取成功（含“无值得记”）只清掉本批 6 个新轮次；前置上下文和其余积压不消费。
          const consumedSeqs = new Set(pendingBatch.map((turn) => turn.seq))
          this.recentTurns = this.recentTurns.filter((turn) => !consumedSeqs.has(turn.seq))
        }
      } catch (err) {
        console.error("[Memory] MemoryJudge/Manager 执行失败，本轮仍会计数", err)
      }
    }

    // 每轮固化水位线之后的残余轮次，重启不丢；失败不影响主流程。
    try {
      const residue = this.recentTurns.map(({ seq: _seq, ...turn }) => turn)
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
  loadConversationMessages: async (conversationId) => chatsStore.getSession(conversationId)?.messages.map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content,
    at: message.at,
  })) ?? null,
})
