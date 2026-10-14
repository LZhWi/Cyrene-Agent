import { enqueueLLMTask } from "../llm-queue"
import { createHash, randomUUID } from "crypto"
import * as chatsStore from "../chats/chats-store"
import { runReflectionAndCompression } from "./memory-compressor"
import { entityGraph } from "./entity-graph"
import { memoryJudge } from "./memory-judge"
import { memoryManager } from "./memory-manager"
import { runResolverQueueOnce } from "./memory-resolver"
import { memoryStore } from "./memory-store"
import type { L1Profile, MemoryCandidate, MemoryCountedTurn, MemoryJudgeTurn, MemoryRoundCountState, MemoryJudgeContext, MemoryReviewTarget } from "./memory-types"
import { relatedMemoryTargets } from "./memory-write-validation"

const MEMORY_JUDGE_INTERVAL = 6
const MEMORY_JUDGE_CONTEXT_TURNS = 8
const MAX_PENDING_TURN_REFS = 128
const MAX_CONTEXT_TURN_REFS = MAX_PENDING_TURN_REFS + MEMORY_JUDGE_CONTEXT_TURNS - MEMORY_JUDGE_INTERVAL
/** L2 生命周期衰减最小间隔：每 24 小时最多跑一次 */
const DECAY_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000

export interface MemorySchedulerDeps {
  ingestEntity: (text: string) => void
  enqueueTask: <T>(label: string, task: () => Promise<T>) => Promise<T>
  judgeMemory: (turns: MemoryJudgeTurn[], conversationId: string, context?: MemoryJudgeContext) => Promise<MemoryCandidate[]>
  writeMemory: (candidates: MemoryCandidate[], isSourceCurrent?: () => Promise<boolean>, source?: { turns: MemoryJudgeTurn[]; conversationId: string }) => Promise<void>
  loadRelatedMemories?: (prior: MemoryJudgeTurn[], conversationId: string) => Promise<MemoryReviewTarget[]>
  getL1: () => Promise<L1Profile>
  replaceL1Field: (field: "roundCount", value: number) => Promise<void>
  runReflectionAndCompression: () => Promise<unknown>
  runResolverQueueOnce: () => Promise<unknown>
  getLastDecayAt: () => Promise<number>
  runDecay: () => Promise<void>
  loadPendingTurns: () => Promise<MemoryJudgeTurn[]>
  savePendingTurns: (turns: MemoryJudgeTurn[], roundCountState?: MemoryRoundCountState) => Promise<void>
  loadRoundCountState?: () => Promise<MemoryRoundCountState | null>
  loadInitialCountedTurns?: () => Promise<MemoryCountedTurn[]>
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

function turnKey(turn: Pick<MemoryJudgeTurn, "conversationId" | "userMessageId">): string {
  return JSON.stringify([turn.conversationId, turn.userMessageId])
}

function messageVersion(message: MemoryConversationMessage | undefined): string | undefined {
  return message && createHash("sha256").update(JSON.stringify([message.id, message.role, message.content, message.at])).digest("hex")
}

function normalizedEvidenceText(value: string | undefined): string {
  return (value ?? "")
    .normalize("NFKC")
    .replace(/\[sticker:[^\]]+\]/giu, "")
    .replace(/[\s\p{P}\p{S}]/gu, "")
    .trim()
}

/**
 * 已通过逐字证据校验的候选保留其消息 ID 和来源时间；以下兼容旧调用的时间推断。
 * 合法引用必须至少有一轮与 triggerText 对应；引用指错时以 triggerText 唯一命中的轮次为准。
 * triggerText 无法唯一定位时使用本批候选创建时间，不把不确定性伪装成消息级精确时间。
 */
export function attachCandidateSourceTimes(
  candidates: MemoryCandidate[],
  turns: MemoryJudgeTurn[],
): MemoryCandidate[] {
  const batchCreatedAt = Date.now()
  return candidates.map((candidate) => {
    if (candidate.sourceEvidence?.length) return candidate
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
  // 只串行化短小的状态读写，绝不把落盘排在后台 LLM 请求之后。
  private stateQueue: Promise<unknown> = Promise.resolve()
  private countedTurns = new Map<string, MemoryCountedTurn>()
  private baseCount = 0
  private latestVersions = new Map<string, number>()

  constructor(private readonly deps: MemorySchedulerDeps) {}

  private changeState<T>(task: () => Promise<T>): Promise<T> {
    const run = this.stateQueue.then(task)
    this.stateQueue = run.catch(() => {})
    return run
  }

  private get roundCount(): number {
    return this.baseCount + [...this.countedTurns.values()].filter((turn) => turn.active).length
  }

  private async persist(): Promise<void> {
    await this.deps.savePendingTurns(this.recentTurns.map(({ seq: _seq, ...turn }) => ({ ...turn })), {
      baseCount: this.baseCount,
      turns: [...this.countedTurns.values()].map((turn) => ({ ...turn })),
    })
    await this.deps.replaceL1Field("roundCount", this.roundCount)
  }

  /** 把重启前未提取的轮次前插回缓冲区；seq 取 ≤0，永不与本次会话的新轮次（seq ≥ 1）碰撞 */
  private ensureRestored(): Promise<void> {
    if (!this.restorePromise) {
      this.restorePromise = (async () => {
        try {
          const persisted = await this.deps.loadPendingTurns()
          const identifiable = persisted.filter(hasTurnIdentity)
          if (identifiable.length !== persisted.length) {
            console.warn(`[Memory] 丢弃 ${persisted.length - identifiable.length} 条无法核对删除状态的旧 pendingTurns`)
          }
          const restored = identifiable.map((turn, index) => ({
            ...turn,
            seq: index - identifiable.length + 1,
          }))
          // 新轮次只有恢复成功后才入队；失败重试必须替换，不能再次前插同一份磁盘数据。
          this.recentTurns = restored.slice(-MAX_PENDING_TURN_REFS)
          this.contextTurns = restored.slice(-MAX_CONTEXT_TURN_REFS)
          const savedCount = await this.deps.loadRoundCountState?.()
          const initial = savedCount?.turns ?? await this.deps.loadInitialCountedTurns?.()
          const counted = initial ?? identifiable.map((turn) => ({
            conversationId: turn.conversationId!, userMessageId: turn.userMessageId!,
            assistantMessageId: turn.assistantMessageId!,
            validateAgainstConversation: turn.validateAgainstConversation === true, active: true,
          }))
          this.countedTurns = new Map(counted.map((turn) => [turnKey(turn), { ...turn }]))
          this.baseCount = savedCount?.baseCount ?? (initial ? 0
            : Math.max(0, (await this.deps.getL1()).roundCount - this.countedTurns.size))
          // 恢复时只复核有身份的来源；不会因文件暂不可读而抹掉计数。
          for (const id of new Set(counted.filter((turn) => turn.validateAgainstConversation).map((turn) => turn.conversationId))) {
            await this.reconcile(id)
          }
          if (restored.length > 0) console.log(`[Memory] 已恢复重启前未提取的 ${restored.length} 轮对话引用`)
        } catch (err) {
          this.restorePromise = null
          throw err
        }
      })()
    }
    return this.restorePromise
  }

  async scheduleMemoryWrite(userInput: string, assistantReply: string, context?: Partial<MemoryScheduleContext>): Promise<void> {
    const seq = ++this.nextTurnSeq
    const now = Date.now()
    const turn: MemoryJudgeTurn & { seq: number } = {
      seq,
      userInput,
      assistantReply,
      conversationId: context?.conversationId || "default",
      userMessageId: context?.userMessageId || `runtime-user-${randomUUID()}`,
      assistantMessageId: context?.assistantMessageId || `runtime-assistant-${randomUUID()}`,
      userAt: typeof context?.userAt === "number" ? context.userAt : now,
      assistantAt: typeof context?.assistantAt === "number" ? context.assistantAt : now,
      validateAgainstConversation: context?.validateAgainstConversation === true,
    }
    // 立即使正在等待 Judge 的旧版本失效；状态落盘不必等待 Judge。
    this.latestVersions.set(turnKey(turn), seq)
    try {
      const maintenanceCount = await this.changeState(async () => {
        await this.ensureRestored()
        if (this.latestVersions.get(turnKey(turn)) !== seq) return undefined
        if (turn.validateAgainstConversation) await this.reconcile(turn.conversationId!, turn)
        const previous = this.countedTurns.get(turnKey(turn))
        this.recentTurns = this.recentTurns.filter((existing) => !sameTurn(existing, turn))
        this.contextTurns = this.contextTurns.filter((existing) => !sameTurn(existing, turn))
        this.recentTurns.push(turn)
        this.contextTurns.push(turn)
        this.recentTurns = this.recentTurns.slice(-MAX_PENDING_TURN_REFS)
        this.contextTurns = this.contextTurns.slice(-MAX_CONTEXT_TURN_REFS)
        this.countedTurns.set(turnKey(turn), {
          conversationId: turn.conversationId!, userMessageId: turn.userMessageId!,
          assistantMessageId: turn.assistantMessageId!,
          validateAgainstConversation: turn.validateAgainstConversation === true, active: true,
        })
        if (turn.validateAgainstConversation) await this.reconcile(turn.conversationId!, turn)
        await this.persist()
        return !previous && this.countedTurns.get(turnKey(turn))?.active ? this.roundCount : undefined
      })
      if (this.latestVersions.get(turnKey(turn)) !== seq) return
      try {
        this.deps.ingestEntity(userInput)
        this.deps.ingestEntity(assistantReply)
      } catch (err) {
        console.warn("[Memory] 实体图谱提取失败:", err)
      }
      void this.deps.enqueueTask("MemoryMaintenance", async () => {
        await this.runQueuedMemoryWrite(seq, maintenanceCount)
      }).catch((e) => console.error("[Memory] 记忆写入失败，不影响主流程", e))
    } catch (err) {
      console.warn("[Memory] 待处理轮次保存失败，保留内存状态且不启动蒸馏", err)
    }
  }

  /** 消息替换/删除时即时更新 pending 和有效计数，不依赖下一次聊天。 */
  reconcileConversation(conversationId: string): Promise<void> {
    return this.changeState(async () => {
      await this.ensureRestored()
      await this.reconcile(conversationId)
      await this.persist()
    })
  }

  private async reconcile(conversationId: string, current?: MemoryJudgeTurn): Promise<MemoryConversationMessage[] | null> {
    const messages = await this.deps.loadConversationMessages(conversationId)
    const byId = new Map((messages ?? []).map((message) => [message.id, message]))
    const pairs = new Map(buildMemoryJudgeTurnsFromMessages(messages ?? []).map((turn) => [turn.userMessageId, turn]))
    const exists = (turn: Pick<MemoryJudgeTurn, "userMessageId" | "assistantMessageId">): boolean => {
      const pair = pairs.get(turn.userMessageId)
      if (pair) return pair.assistantMessageId === turn.assistantMessageId
      // 收尾回调早于渲染端保存 assistant；仅放行当前刚完成、且仍有原用户消息的一轮。
      return Boolean(current && turn.userMessageId === current.userMessageId
        && turn.assistantMessageId === current.assistantMessageId
        && messages?.some((message) => message.id === turn.userMessageId && message.role === "user"))
    }
    for (const turn of this.countedTurns.values()) {
      if (turn.conversationId === conversationId && turn.validateAgainstConversation && turn.active && !exists(turn)) {
        turn.active = false
      }
    }
    const keep = (turn: MemoryJudgeTurn) => turn.conversationId !== conversationId || !turn.validateAgainstConversation || exists(turn)
    this.recentTurns = this.recentTurns.filter(keep)
    this.contextTurns = this.contextTurns.filter(keep)
    for (const turn of this.recentTurns.filter((item) => item.conversationId === conversationId && item.validateAgainstConversation)) {
      const userVersion = messageVersion(byId.get(turn.userMessageId!))
      const assistantVersion = messageVersion(byId.get(turn.assistantMessageId!))
      const edited = (turn.sourceUserVersion && turn.sourceUserVersion !== userVersion)
        || (turn.sourceAssistantVersion && turn.sourceAssistantVersion !== assistantVersion)
      if (edited) {
        // 同 ID 原地编辑也会失效旧快照；下一批从新的会话原文提取。
        const updated = { ...turn, seq: ++this.nextTurnSeq,
          userInput: byId.get(turn.userMessageId!)!.content,
          assistantReply: byId.get(turn.assistantMessageId!)?.content ?? turn.assistantReply,
          sourceUserVersion: userVersion, sourceAssistantVersion: assistantVersion }
        this.latestVersions.set(turnKey(turn), updated.seq)
        this.recentTurns = this.recentTurns.map((item) => item === turn ? updated : item)
        this.contextTurns = this.contextTurns.map((item) => sameTurn(item, turn) ? updated : item)
      } else {
        turn.sourceUserVersion = userVersion
        turn.sourceAssistantVersion = assistantVersion
      }
    }
    return messages
  }

  private async runQueuedMemoryWrite(seq: number, maintenanceCount?: number): Promise<void> {
    await this.stateQueue
    await this.ensureRestored()
    const current = this.recentTurns.find((turn) => turn.seq === seq)
    let eligible = this.recentTurns.filter((turn) => turn.seq <= seq)
    let conversationMessages: MemoryConversationMessage[] | null = null
    if (current?.validateAgainstConversation) {
      try {
        conversationMessages = await this.changeState(() => this.reconcile(current.conversationId!, current))
        eligible = this.recentTurns.filter((turn) => turn.seq <= seq)
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
        const turns = [...priorContext, ...pendingBatch].map((turn) => ({ ...turn, conversationId,
          sourceUserText: conversationMessages?.find(message => message.id === turn.userMessageId)?.content ?? turn.userInput }))
        const versions = turns.map((turn) => this.latestVersions.get(turnKey(turn)))
        const sourceMessages = new Map((conversationMessages ?? []).map((message) => [message.id, messageVersion(message)]))
        const isSourceCurrent = async (): Promise<boolean> => {
          if (current.validateAgainstConversation) {
            const latest = await this.deps.loadConversationMessages(conversationId)
            const messages = new Map((latest ?? []).map((message) => [message.id, message]))
            for (const turn of turns) {
              if (messageVersion(messages.get(turn.userMessageId!)) !== sourceMessages.get(turn.userMessageId!)) return false
              const originalAssistant = sourceMessages.get(turn.assistantMessageId!)
              if (originalAssistant !== undefined) {
                if (messageVersion(messages.get(turn.assistantMessageId!)) !== originalAssistant) return false
              } else {
                // 当前回复可能尚未由渲染端落盘；用户消息也必须仍然存在。
                if (!messages.has(turn.userMessageId!)) return false
                const pair = buildMemoryJudgeTurnsFromMessages(latest ?? []).find((item) => item.userMessageId === turn.userMessageId)
                if (pair && pair.assistantMessageId !== turn.assistantMessageId) return false
              }
            }
          }
          return turns.every((turn, index) => this.latestVersions.get(turnKey(turn)) === versions[index]
            && (this.countedTurns.get(turnKey(turn))?.active !== false))
        }
        const context = this.deps.loadRelatedMemories ? {
          priorTurnCount: priorContext.length,
          previousMemories: await this.deps.loadRelatedMemories(turns.slice(0, priorContext.length), conversationId),
        } : undefined
        const candidates = attachCandidateSourceTimes(
          await this.deps.judgeMemory(turns, conversationId, context),
          turns,
        )

        if (await isSourceCurrent()) {
          if (candidates.length > 0) {
            await this.deps.writeMemory(candidates, isSourceCurrent, context ? { turns, conversationId } : undefined)
          }
          // 提取成功（含“无值得记”）只清掉本批 6 个新轮次；前置上下文和其余积压不消费。
          await this.changeState(async () => {
            if (!await isSourceCurrent()) return
            const consumedSeqs = new Set(pendingBatch.map((turn) => turn.seq))
            this.recentTurns = this.recentTurns.filter((turn) => !consumedSeqs.has(turn.seq))
          })
        } else {
          console.warn("[Memory] Judge 来源版本已变化，本批候选作废")
          if (current.validateAgainstConversation) {
            await this.changeState(() => this.reconcile(conversationId,
              this.latestVersions.get(turnKey(current)) === seq ? current : undefined))
          }
        }
      } catch (err) {
        console.error("[Memory] MemoryJudge/Manager 执行失败，本轮仍会计数", err)
      }
    }

    // 每轮固化水位线之后的残余轮次，重启不丢；失败不影响主流程。
    try {
      await this.changeState(() => this.persist())
    } catch (err) {
      console.warn("[Memory] 持久化未提取轮次失败，不影响主流程", err)
    }

    const newCount = maintenanceCount ?? 0
    const countAdvanced = newCount > 0 && this.roundCount >= newCount
      && Boolean(current && this.countedTurns.get(turnKey(current))?.active
        && this.latestVersions.get(turnKey(current)) === seq)
    if (countAdvanced && newCount % 5 === 0) {
      try {
        await this.deps.runResolverQueueOnce()
      } catch (err) {
        console.warn("[Memory] Resolver 队列处理失败，不影响主流程", err)
      }
    }

    if (countAdvanced && newCount % 20 === 0) {
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
  judgeMemory: (turns, conversationId, context) => memoryJudge.judgeRecentTurns(turns, conversationId, context),
  loadRelatedMemories: async (prior, conversationId) => relatedMemoryTargets(await memoryStore.getAllL2(), prior, conversationId),
  writeMemory: (candidates, isSourceCurrent, source) => memoryManager.writeMemory(candidates, isSourceCurrent, source),
  getL1: () => memoryStore.getL1(),
  replaceL1Field: async (field, value) => {
    if ((await memoryStore.getL1())[field] !== value) await memoryStore.replaceL1Field(field, value)
  },
  runReflectionAndCompression,
  runResolverQueueOnce,
  getLastDecayAt: () => memoryStore.getLastDecayAt(),
  runDecay: () => memoryManager.runDecay(),
  loadPendingTurns: () => memoryStore.getPendingTurns(),
  savePendingTurns: (turns, state) => memoryStore.setPendingTurns(turns, state),
  loadRoundCountState: () => memoryStore.getRoundCountState(),
  loadInitialCountedTurns: async () => {
    if (chatsStore.getStorageStatus().status !== "ready") throw new Error("聊天存储未就绪，暂不重建轮次计数")
    const turns: MemoryCountedTurn[] = []
    for (const meta of chatsStore.listSessions()) {
      const session = chatsStore.getSession(meta.id)
      if (!session) throw new Error("会话暂不可读，暂不重建轮次计数")
      for (const turn of buildMemoryJudgeTurnsFromMessages(session.messages)) {
        turns.push({ conversationId: meta.id, userMessageId: turn.userMessageId!,
          assistantMessageId: turn.assistantMessageId!, validateAgainstConversation: true, active: true })
      }
    }
    return turns
  },
  loadConversationMessages: async (conversationId) => {
    const session = chatsStore.getSession(conversationId)
    if (chatsStore.getStorageStatus().status !== "ready") throw new Error("聊天存储未就绪，暂不更新记忆轮次")
    return session?.messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      at: message.at,
    })) ?? null
  },
})

chatsStore.onMessagesChanged((conversationId) => {
  void memoryScheduler.reconcileConversation(conversationId)
    .catch((error) => console.warn("[Memory] 消息变更后的轮次同步失败，下次复核重试", error))
})
