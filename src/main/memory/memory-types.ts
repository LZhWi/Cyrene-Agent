import type { MemoryFacets } from "./memory-facets"

export interface L0Profile {
  nickname: string
  preferredName: string
  occupation: string
  longTermInterests: string
  language: string
  permanentNote: string
  isPinned: boolean
  updatedAt: number
}
export const L0_FIELD_DESCRIPTIONS: Partial<Record<keyof L0Profile, string>> = {
  preferredName:     '用户希望被如何称呼、叫什么名字、昵称。例如："叫我P宝""我叫Playa""以后喊我宝宝"',
  occupation:        '用户的职业、身份、工作。例如："我是前端工程师""我在做设计"',
  longTermInterests: '用户的长期兴趣爱好（稳定的，不是临时的）。例如："我一直喜欢画画""我从小学钢琴"',
  language:          '用户常用的语言或地区习惯。例如："我习惯说中文""我是广东人"',
  permanentNote:     '其他不属于以上四类的稳定个人信息。例如："我有一只猫""我住在上海"',
  // isPinned 和 updatedAt 不在这里，代表不暴露给 AI
}


export interface L1Profile {
  recentGoals: string
  recentPreferences: string
  currentProject: string
  generatedAt: number
  roundCount: number
}

/** L1 内容的新鲜期：超过 30 天未更新就不再注入 [近期状态]（与 L2 active→aging 边界对齐） */
export const L1_FRESHNESS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

export function isL1Fresh(l1: L1Profile, now = Date.now()): boolean {
  if (!l1.generatedAt) return false
  return now - l1.generatedAt < L1_FRESHNESS_WINDOW_MS
}

export type L2SyncStatus = "pending_sync" | "synced" | "sync_failed"

export interface L2Memory {
  id: string
  content: string
  triggerText: string
  sourceConversationId: string
  createdAt: number
  /** 支持该记忆的原始对话时间；不保存消息 ID，缺失时回退 createdAt。 */
  sourceAt?: number
  /** 多轮共同支持时的来源时间范围终点。 */
  sourceEndAt?: number
  lastAccessedAt: number
  accessCount: number
  weight: number
  isPinned: boolean
  status: L2MemoryStatus
  syncStatus?: L2SyncStatus
  embedding?: number[]
  ragId?: string
  /** 是否为压缩总结条目（由 Reflection 生成） */
  isSummary?: boolean
  /** 被本条压缩的原始条目 id 列表 */
  subEntryIds?: string[]
  /** 冲突标记：与该记忆语义相矛盾的其他条目 ragId 列表 */
  conflictWith?: string[]
  evidenceIds?: string[]
  sourceMessageIds?: string[]
  supersededBy?: string
  mergedInto?: string
  /** 提取时保留的「用户当时说的原话」片段：L2 是浓缩结论，会丢失专有名词/数字等
   * 字面信息；召回注入时附上原文让后续模型看到字面证据（缺失时注入回退 triggerText）。 */
  sourceQuote?: string
  /** 事实有效期起点（迁移时归一化为 createdAt）；缺失视为无下界 */
  validFrom?: number
  /** 事实有效期终点：被纠正/取代时写入；到期后自动检索不再引用，仅工具通道带标记可查 */
  validTo?: number
  /** 类型/主题/实体分面；旧数据升级后先标 pending，再由 MemoryJudge 后台补标。 */
  facets?: MemoryFacets
}

export type L2MemoryStatus = "active" | "aging" | "archived" | "superseded" | "merged"

/**
 * L2 DMAE 工作记忆运行时状态（每条 L2 一份，按 l2Id 索引）。
 * 语义与世界书 DMAE（rag/worldbook.ts EntryState）对齐：
 * - activation 0-100，>= promptThreshold 视为"活跃"，驻留注入
 * - userSilence/modelSilence 为距上次命中的轮数，驱动二次阻力衰减
 * 额外字段服务于驻留去重与饱和抑制（repeatWindow/repeatRho）。
 */
export interface L2DmaeState {
  activation: number
  userSilence: number
  modelSilence: number
  /** 上次注入时的全局轮次；-1 表示从未注入 */
  lastInjectedRound: number
  /** 状态最近一次更新时的全局轮次 */
  round: number
}

export function isL2LocallyRecallable(memory: L2Memory): boolean {
  return (
    (memory.status === "active" || memory.status === "aging") &&
    memory.syncStatus === "synced" &&
    typeof memory.ragId === "string" &&
    memory.ragId.length > 0
  )
}

/**
 * 事实有效期判定（思想源自 MemPalace 的 validity windows）：
 * - validTo 已到期：事实被纠正/取代，自动引用通道关闭
 * - validFrom 在未来：回填条目尚未生效（防御性，正常不出现）
 * 两字段缺失视为无界（旧数据默认永远有效）。
 */
export function isL2Expired(memory: L2Memory, now = Date.now()): boolean {
  if (typeof memory.validTo === "number" && memory.validTo <= now) return true
  if (typeof memory.validFrom === "number" && memory.validFrom > now) return true
  return false
}

export interface ReflectionLog {
  id: string
  createdAt: number
  type: "compression" | "l0_update" | "l1_update"
  summary: string
  details?: string
}

/**
 * 梦境沉淀叙事：被降级记忆在遗忘前蒸馏成的第一人称陪伴叙事。
 * 永不衰减、不进检索，由 always-on 上下文注入最新几条。
 */
export interface DreamNarrative {
  id: string
  createdAt: number
  text: string
}

export interface ConflictLog {
  id: string
  createdAt: number
  status: "candidate" | "pending" | "confirmed" | "dismissed" | "resolved" | "clarification_needed"
  sourceL2Id: string
  targetL2Id: string
  sourceRagId?: string
  targetRagId?: string
  reason: string
  confidence: number
  detector: "local" | "llm" | "manual"
  /** 省略表示传统冲突候选；near_duplicate 表示仅因高相似度进入非破坏式关系裁决。 */
  candidateType?: "conflict" | "near_duplicate" | "state_transition"
  conflictScore?: number
  resolverPriority?: ConflictResolverPriority
  scoringSignals?: ConflictScoringSignals
  resolverStatus?: ConflictResolverStatus
  resolverQueuedAt?: number
  resolverAttemptCount?: number
  resolverStartedAt?: number
  resolverFinishedAt?: number
  resolutionType?: MemoryConflictResolutionType
  resolutionMemoryId?: string
  resolutionReason?: string
  resolutionConfidence?: number
  shouldAskUser?: boolean
  clarificationNeeded?: boolean
}

export type ConflictResolverPriority = "none" | "idle" | "normal" | "high"
export type ConflictResolverStatus = "not_queued" | "queued" | "processing" | "resolved" | "failed"
export type MemoryConflictResolutionType = "unrelated" | "context_difference" | "preference_evolution" | "direct_conflict" | "uncertain"

export interface MemoryConflictResolution {
  resolutionType: MemoryConflictResolutionType
  resolvedSummary?: string
  currentSummary?: string
  historicalSummary?: string
  reason: string
  confidence: number
  actions: {
    createResolvedMemory: boolean
    oldMemoryStatus?: L2MemoryStatus
    newMemoryStatus?: L2MemoryStatus
    shouldUpdateCoreMemory?: boolean
    shouldAskUser?: boolean
    clarificationNeeded?: boolean
  }
}

export interface ConflictScoringSignals {
  correctionIntent?: boolean
  ragCandidate?: boolean
  recentInjection?: boolean
  evidenceAvailable?: boolean
  localContradiction?: boolean
  impactScope?: "low" | "medium" | "high"
  penalties?: string[]
}

export interface MemoryEvidence {
  id: string
  memoryId: string
  quoteSnippet: string
  contextBeforeSnippet?: string
  contextAfterSnippet?: string
  conversationId?: string
  messageIds?: string[]
  createdAt: number
  sourceStatus: "active" | "archived" | "deleted"
}

export interface MemoryCandidate {
  layer: "L0" | "L1" | "L2"
  field?: string
  summary?: string
  content: string
  confidence: number
  triggerText: string
  importance?: "low" | "medium" | "high"
  stability?: "one_off" | "situational" | "stable"
  certainty?: "explicit" | "inferred" | "uncertain"
  attribution?: "user_explicit" | "assistant_inferred" | "mixed"
  evidenceQuotes?: string[]
  contextSummary?: string
  shouldWrite?: boolean
  reason?: string
  forbiddenOverclaims?: string[]
  /** L2 原文对话片段（≤500 字）：judge 与 summary 同批输出，落库到 L2.sourceQuote。 */
  sourceQuote?: string
  /** Judge 本轮临时引用（T1…T8）；仅用于本地换算来源时间，不持久化。 */
  evidenceTurnRefs?: string[]
  /** 由 Scheduler 根据临时轮次引用写入，不由模型直接生成。 */
  sourceAt?: number
  sourceEndAt?: number
  /** 仅回填注入：该事实的原始形成时间；正常提取不填（用写入时刻）。 */
  createdAt?: number
  /** MemoryJudge 与摘要同批输出；缺失或非法时回落为保守的本地标签。 */
  facets?: MemoryFacets
}

export interface MemoryJudgeTurn {
  userInput: string
  assistantReply: string
  userAt?: number
  assistantAt?: number
  conversationId?: string
  userMessageId?: string
  assistantMessageId?: string
  /** true 时，提取前必须回查会话文件确认该轮仍存在。 */
  validateAgainstConversation?: boolean
}

export interface MemoryStore {
  schemaVersion: number
  l0: L0Profile
  l1: L1Profile
  l2: L2Memory[]
  evidence?: MemoryEvidence[]
  reflectionLogs?: ReflectionLog[]
  conflictLogs?: ConflictLog[]
  /** 上次 L2 生命周期衰减的时间戳，用于每日限频 */
  lastDecayAt?: number
  /** 尚未被 MemoryJudge 提取的残余轮次，重启后恢复，避免丢轮 */
  pendingTurns?: MemoryJudgeTurn[]
  /** L2 DMAE 工作记忆状态表（按 l2Id 索引），重启后恢复驻留集 */
  l2DmaeStates?: Record<string, L2DmaeState>
  /** DMAE 全局轮次计数（每次带状态更新的注入轮 +1） */
  l2DmaeRound?: number
  /** 梦境沉淀叙事（永不衰减）；缺失视为空 */
  dreamNarratives?: DreamNarrative[]
  /** @deprecated Use schemaVersion for memory.json migrations. */
  version: number
}
