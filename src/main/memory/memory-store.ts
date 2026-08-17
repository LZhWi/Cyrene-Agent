import * as fs from "fs"
import * as path from "path"
import { getUserDataDir } from "../runtime/runtime-paths"
import { ConflictLog, DreamNarrative, L0Profile, L1Profile, L2DmaeState, L2Memory, L2SyncStatus, MemoryConflictResolution, MemoryEvidence, MemoryJudgeTurn, MemoryStore, ReflectionLog } from "./memory-types"
import { appendMemoryTrace } from "./memory-trace"

const CURRENT_SCHEMA_VERSION = 3
const QUOTE_SNIPPET_MAX = 300
const DAY_MS = 24 * 60 * 60 * 1000
/** 梦境沉淀叙事保留上限（注入时另取最新几条，见 memory-dream NARRATIVE_INJECT_MAX） */
const DREAM_NARRATIVE_MAX = 8
/** active 闲置满 30 天降为 aging */
const DECAY_AGING_IDLE_MS = 30 * DAY_MS
/** aging 闲置满 90 天降为 archived */
const DECAY_ARCHIVE_IDLE_MS = 90 * DAY_MS
const RESOLVER_PRIORITY_RANK: Record<string, number> = {
  high: 3,
  normal: 2,
  idle: 1,
  none: 0,
}

const DEFAULT_L0: L0Profile = {
  nickname: "",
  preferredName: "",
  occupation: "",
  longTermInterests: "",
  language: "zh-CN",
  permanentNote: "",
  isPinned: false,
  updatedAt: 0,
}

const DEFAULT_L1: L1Profile = {
  recentGoals: "",
  recentPreferences: "",
  currentProject: "",
  generatedAt: 0,
  roundCount: 0,
}

const DEFAULT_STORE: MemoryStore = {
  schemaVersion: CURRENT_SCHEMA_VERSION,
  l0: { ...DEFAULT_L0 },
  l1: { ...DEFAULT_L1 },
  l2: [],
  evidence: [],
  reflectionLogs: [],
  conflictLogs: [],
  lastDecayAt: 0,
  pendingTurns: [],
  version: 1,
}

export type L0WritableField = Exclude<keyof L0Profile, "updatedAt">
export type L1WritableField = keyof L1Profile
export type L2Input = Omit<L2Memory, "id" | "createdAt" | "lastAccessedAt" | "accessCount" | "weight" | "status">

function getMemoryPath(): string {
  return path.join(getUserDataDir(), "memory.json")
}

function cloneDefaultStore(): MemoryStore {
  return {
    ...DEFAULT_STORE,
    l0: { ...DEFAULT_L0 },
    l1: { ...DEFAULT_L1 },
    l2: [],
    evidence: [],
    reflectionLogs: [],
    conflictLogs: [],
    pendingTurns: [],
  }
}

function snippet(text: string | undefined, maxLength: number): string | undefined {
  if (!text) return undefined
  return text.length > maxLength ? text.slice(0, maxLength) : text
}

function backupMemoryFile(filePath: string): void {
  if (!fs.existsSync(filePath)) return
  const dir = path.dirname(filePath)
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
  const backupPath = path.join(dir, `memory.backup.${timestamp}.json`)
  fs.copyFileSync(filePath, backupPath)
}

export function repairMigrations(store: Partial<MemoryStore>): MemoryStore {
  const l1 = { ...DEFAULT_L1, ...store.l1 }
  // 历史数据没有写过 generatedAt：有内容但时间戳为 0 时从当前时刻起算新鲜期，
  // 避免存量 L1 被立刻判为过期。
  if (!l1.generatedAt && (l1.recentGoals || l1.recentPreferences || l1.currentProject)) {
    l1.generatedAt = Date.now()
  }
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    l0: { ...DEFAULT_L0, ...store.l0 },
    l1,
    l2: Array.isArray(store.l2) ? store.l2.map((memory) => ({
      ...memory,
      syncStatus: memory.syncStatus ?? (memory.ragId ? "synced" : "pending_sync"),
      evidenceIds: Array.isArray(memory.evidenceIds) ? memory.evidenceIds : [],
      // v3 迁移：有效期起点归一化。旧数据没有 validFrom，用 createdAt 补齐，
      // 让时间维判定（isL2Expired / 未来时间邻近 boost）有统一字段可读；
      // validTo 不伪造——缺失即"未被纠正/取代"，旧事实默认继续有效。
      validFrom: typeof memory.validFrom === "number"
        ? memory.validFrom
        : (typeof memory.createdAt === "number" ? memory.createdAt : 0),
    })) : [],
    evidence: Array.isArray(store.evidence) ? store.evidence : [],
    reflectionLogs: Array.isArray(store.reflectionLogs) ? store.reflectionLogs : [],
    conflictLogs: Array.isArray(store.conflictLogs) ? store.conflictLogs.map((log) => ({
      ...log,
      resolverStatus: log.resolverStatus ?? (log.resolverPriority && log.resolverPriority !== "none" ? "queued" : "not_queued"),
      resolverAttemptCount: typeof log.resolverAttemptCount === "number" ? log.resolverAttemptCount : 0,
    })) : [],
    lastDecayAt: typeof store.lastDecayAt === "number" ? store.lastDecayAt : 0,
    pendingTurns: Array.isArray(store.pendingTurns) ? store.pendingTurns.filter(
      (turn) => turn && typeof turn.userInput === "string" && typeof turn.assistantReply === "string",
    ) : [],
    // DMAE 状态属于运行时缓存：损坏/缺失时重建为空表即可，不影响记忆本体。
    l2DmaeStates: store.l2DmaeStates && typeof store.l2DmaeStates === "object" ? store.l2DmaeStates : {},
    l2DmaeRound: typeof store.l2DmaeRound === "number" ? store.l2DmaeRound : 0,
    // 梦境叙事为新增可选字段：旧数据缺失视为空，已有条目只保留结构合法的项。
    dreamNarratives: Array.isArray(store.dreamNarratives)
      ? store.dreamNarratives.filter(
        (n) => n && typeof n.text === "string" && n.text.length > 0 && typeof n.createdAt === "number",
      )
      : [],
    version: typeof store.version === "number" ? store.version : 1,
  }
}

class MemoryStoreManager {
  private cache: MemoryStore | null = null

  async load(): Promise<MemoryStore> {
    if (this.cache) return this.cache
    const filePath = getMemoryPath()
    try {
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, "utf8")
        const parsed = JSON.parse(raw) as Partial<MemoryStore>
        const needsMigration = parsed.schemaVersion !== CURRENT_SCHEMA_VERSION
        this.cache = repairMigrations(parsed)
        if (needsMigration) {
          backupMemoryFile(filePath)
          await this.save(this.cache)
          appendMemoryTrace({
            op: "migration.upgrade",
            layer: "migration",
            status: "ok",
            details: { schemaVersion: CURRENT_SCHEMA_VERSION },
          })
        }
      } else {
        this.cache = cloneDefaultStore()
        await this.save(this.cache)
        appendMemoryTrace({
          op: "store.init",
          layer: "store",
          status: "ok",
          details: { schemaVersion: CURRENT_SCHEMA_VERSION },
        })
      }
    } catch (err) {
      try {
        backupMemoryFile(filePath)
      } catch {
        // 如果连备份也失败，仍然生成干净默认文件，避免主流程被记忆文件阻塞。
      }
      this.cache = cloneDefaultStore()
      await this.save(this.cache)
      appendMemoryTrace({
        op: "migration.recoverDefault",
        layer: "migration",
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      })
    }
    return this.cache
  }

  async save(store: MemoryStore): Promise<void> {
    const filePath = getMemoryPath()
    const dir = path.dirname(filePath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(filePath, JSON.stringify(store, null, 2), "utf8")
    this.cache = store
  }

  async getL0(): Promise<L0Profile> {
    const store = await this.load()
    return store.l0
  }

  async upsertL0Field(field: L0WritableField, value: L0Profile[L0WritableField]): Promise<void> {
    const store = await this.load()
    store.l0 = { ...store.l0, [field]: value, updatedAt: Date.now() }
    await this.save(store)
    appendMemoryTrace({
      op: "l0.update",
      layer: "L0",
      status: "ok",
      details: { fields: [field] },
    })
  }

  async updateL0(patch: Partial<L0Profile>): Promise<void> {
    for (const [field, value] of Object.entries(patch) as Array<[keyof L0Profile, L0Profile[keyof L0Profile]]>) {
      if (field === "updatedAt") continue
      await this.upsertL0Field(field, value as L0Profile[L0WritableField])
    }
  }

  async getL1(): Promise<L1Profile> {
    const store = await this.load()
    return store.l1
  }

  async replaceL1Field(field: L1WritableField, value: L1Profile[L1WritableField]): Promise<void> {
    const store = await this.load()
    store.l1 = { ...store.l1, [field]: value }
    // 内容字段更新时刷新新鲜度时间戳；roundCount 等计数字段不算内容更新。
    if (field === "recentGoals" || field === "recentPreferences" || field === "currentProject") {
      store.l1.generatedAt = Date.now()
    }
    await this.save(store)
    appendMemoryTrace({
      op: "l1.update",
      layer: "L1",
      status: "ok",
      details: { fields: [field] },
    })
  }

  async updateL1(patch: Partial<L1Profile>): Promise<void> {
    for (const [field, value] of Object.entries(patch) as Array<[L1WritableField, L1Profile[L1WritableField]]>) {
      await this.replaceL1Field(field, value)
    }
  }

  async addL2Memory(input: L2Input, opts?: { createdAt?: number }): Promise<L2Memory> {
    const store = await this.load()
    const memory: L2Memory = {
      ...input,
      id: `l2_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      createdAt: opts?.createdAt ?? Date.now(),
      lastAccessedAt: Date.now(),
      accessCount: 0,
      weight: 0,
      status: "active",
      syncStatus: input.syncStatus ?? (input.ragId ? "synced" : "pending_sync"),
      evidenceIds: Array.isArray(input.evidenceIds) ? input.evidenceIds : [],
    }
    const evidence = this.createEvidence(memory, input)
    memory.evidenceIds = [...(memory.evidenceIds ?? []), evidence.id]
    store.l2.push(memory)
    if (!store.evidence) store.evidence = []
    store.evidence.push(evidence)
    await this.save(store)
    appendMemoryTrace({
      op: "l2.add",
      layer: "L2",
      status: "ok",
      l2Id: memory.id,
      ragId: memory.ragId,
      details: { isSummary: memory.isSummary === true, syncStatus: memory.syncStatus },
    })
    appendMemoryTrace({
      op: "evidence.add",
      layer: "L2",
      status: "ok",
      l2Id: memory.id,
      details: { evidenceId: evidence.id, sourceStatus: evidence.sourceStatus },
    })
    return memory
  }

  private createEvidence(memory: L2Memory, input: L2Input): MemoryEvidence {
    return {
      id: `ev_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      memoryId: memory.id,
      quoteSnippet: snippet(input.triggerText || input.content, QUOTE_SNIPPET_MAX) ?? "",
      conversationId: input.sourceConversationId || undefined,
      messageIds: input.sourceMessageIds,
      createdAt: Date.now(),
      sourceStatus: "active",
    }
  }

  async addL2(input: L2Input): Promise<L2Memory> {
    return this.addL2Memory(input)
  }

  async updateL2RecallStats(id: string, delta = 1): Promise<void> {
    const store = await this.load()
    const mem = store.l2.find((m) => m.id === id)
    if (!mem) return
    if (mem.status !== "active" && mem.status !== "aging") {
      appendMemoryTrace({
        op: "l2.weight.update",
        layer: "L2",
        status: "skip",
        l2Id: mem.id,
        ragId: mem.ragId,
        details: { delta, memoryStatus: mem.status, reason: "not_recallable" },
      })
      return
    }
    const previousStatus = mem.status
    mem.weight = Math.max(0, Math.min(100, mem.weight + delta))
    mem.lastAccessedAt = Date.now()
    mem.accessCount += 1
    if (mem.isPinned || previousStatus === "active") {
      mem.status = "active"
    } else if (mem.weight >= 30) {
      mem.status = "active"
    } else {
      mem.status = "aging"
    }
    await this.save(store)
    appendMemoryTrace({
      op: "l2.weight.update",
      layer: "L2",
      status: "ok",
      l2Id: mem.id,
      ragId: mem.ragId,
      details: { delta, weight: mem.weight, accessCount: mem.accessCount, memoryStatus: mem.status },
    })
  }

  async pinL2(id: string, pinned: boolean): Promise<void> {
    const store = await this.load()
    const mem = store.l2.find((m) => m.id === id)
    if (!mem) return
    mem.isPinned = pinned
    if (pinned) {
      mem.status = "active"
    } else if (mem.weight > 60) {
      mem.status = "active"
    } else if (mem.weight >= 30) {
      mem.status = "active"
    } else if (mem.weight >= 10) {
      mem.status = "aging"
    } else {
      mem.status = "archived"
    }
    await this.save(store)
    appendMemoryTrace({
      op: "l2.pin",
      layer: "L2",
      status: "ok",
      l2Id: mem.id,
      ragId: mem.ragId,
      details: { pinned, memoryStatus: mem.status },
    })
  }

  async deleteL2(id: string): Promise<void> {
    const store = await this.load()
    store.l2 = store.l2.filter((m) => m.id !== id)
    store.evidence = (store.evidence ?? []).filter((evidence) => evidence.memoryId !== id)
    await this.save(store)
    appendMemoryTrace({
      op: "l2.delete",
      layer: "L2",
      status: "ok",
      l2Id: id,
    })
  }

  async updateL2Weight(id: string, delta: number): Promise<void> {
    await this.updateL2RecallStats(id, delta)
  }

  /**
   * 批量召回刷新（reconsolidation，思想源自 Herta 的"召回即重巩固"）：
   * 最终注入进上下文的条目统一 +1 权重、刷新 lastAccessedAt，
   * 让常用记忆不被闲置衰减误伤。单次 load/save，避免逐条写盘。
   * 与 updateL2RecallStats 同款状态迁移规则；已废弃条目不复活。
   */
  async recordL2RecallsBatch(ids: string[], now = Date.now()): Promise<number> {
    const store = await this.load()
    const idSet = new Set(ids)
    let changed = 0
    for (const mem of store.l2) {
      if (!idSet.has(mem.id)) continue
      if (mem.status !== "active" && mem.status !== "aging") continue
      const previousStatus = mem.status
      mem.weight = Math.max(0, Math.min(100, mem.weight + 1))
      mem.lastAccessedAt = now
      mem.accessCount += 1
      if (mem.isPinned || previousStatus === "active") {
        mem.status = "active"
      } else if (mem.weight >= 30) {
        mem.status = "active"
      } else {
        mem.status = "aging"
      }
      changed += 1
    }
    if (changed > 0) {
      await this.save(store)
    }
    appendMemoryTrace({
      op: "l2.recall.batch",
      layer: "L2",
      status: changed > 0 ? "ok" : "skip",
      details: { requested: ids.length, changed },
    })
    return changed
  }

  /**
   * 纠正/取代失效（validity window 的写入端）：旧条目标 superseded + validTo=now，
   * 并指向取代它的新条目。自动检索通道据此关闭旧事实引用；条目本体与证据保留，
   * 工具通道仍可带标记查阅。已废弃/归档条目不重复处理。
   */
  async supersedeL2(oldId: string, newId: string, now = Date.now()): Promise<boolean> {
    const store = await this.load()
    const old = store.l2.find((m) => m.id === oldId)
    if (!old) return false
    if (old.status === "superseded" || old.status === "merged" || old.status === "archived") return false
    old.status = "superseded"
    old.supersededBy = newId
    old.validTo = now
    await this.save(store)
    appendMemoryTrace({
      op: "l2.supersede",
      layer: "L2",
      status: "ok",
      l2Id: oldId,
      ragId: old.ragId,
      details: { supersededBy: newId, validTo: now },
    })
    return true
  }

  async markL2SyncStatus(id: string, syncStatus: L2SyncStatus, ragId?: string, error?: unknown): Promise<L2Memory | null> {
    const store = await this.load()
    const mem = store.l2.find((m) => m.id === id)
    if (!mem) return null
    mem.syncStatus = syncStatus
    if (ragId) mem.ragId = ragId
    await this.save(store)
    appendMemoryTrace({
      op: syncStatus === "synced" ? "l2.sync.success" : syncStatus === "sync_failed" ? "l2.sync.failure" : "l2.sync.pending",
      layer: "L2",
      status: syncStatus === "sync_failed" ? "error" : "ok",
      l2Id: mem.id,
      ragId: mem.ragId,
      details: { syncStatus },
      error: error instanceof Error ? error.message : error ? String(error) : null,
    })
    return mem
  }

  async markL2Conflict(id: string, conflictRagId: string): Promise<L2Memory | null> {
    const store = await this.load()
    const mem = store.l2.find((m) => m.id === id)
    if (!mem) return null
    const conflicts = mem.conflictWith ?? []
    if (conflicts.includes(conflictRagId)) return null

    mem.conflictWith = [...conflicts, conflictRagId]
    if (!mem.isPinned && mem.status === "active") {
      mem.status = "aging"
    }

    await this.save(store)
    appendMemoryTrace({
      op: "l2.conflict.mark",
      layer: "L2",
      status: "ok",
      l2Id: mem.id,
      ragId: mem.ragId,
      details: { conflictRagId, memoryStatus: mem.status },
    })
    return mem
  }

  async getAllL2(): Promise<L2Memory[]> {
    const store = await this.load()
    return store.l2
  }

  async getEvidenceByMemoryId(memoryId: string): Promise<MemoryEvidence[]> {
    const store = await this.load()
    return (store.evidence ?? []).filter((evidence) => evidence.memoryId === memoryId)
  }

  async appendReflectionLog(log: Omit<ReflectionLog, "id" | "createdAt">): Promise<void> {
    const store = await this.load()
    const entry: ReflectionLog = {
      ...log,
      id: `ref_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      createdAt: Date.now(),
    }
    if (!store.reflectionLogs) store.reflectionLogs = []
    store.reflectionLogs.push(entry)
    // 最多保留 50 条日志，防止文件膨胀
    if (store.reflectionLogs.length > 50) {
      store.reflectionLogs = store.reflectionLogs.slice(-50)
    }
    await this.save(store)
    appendMemoryTrace({
      op: "reflection.log.add",
      layer: "reflection",
      status: "ok",
      details: { type: entry.type, id: entry.id },
    })
  }

  async addReflectionLog(log: Omit<ReflectionLog, "id" | "createdAt">): Promise<void> {
    await this.appendReflectionLog(log)
  }

  async getReflectionLogs(): Promise<ReflectionLog[]> {
    const store = await this.load()
    return store.reflectionLogs ?? []
  }

  async appendConflictLog(log: Omit<ConflictLog, "id" | "createdAt">): Promise<ConflictLog> {
    const store = await this.load()
    const entry: ConflictLog = {
      ...log,
      id: `conf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      createdAt: Date.now(),
    }
    if (!store.conflictLogs) store.conflictLogs = []
    store.conflictLogs.push(entry)
    if (store.conflictLogs.length > 100) {
      store.conflictLogs = store.conflictLogs.slice(-100)
    }
    await this.save(store)
    appendMemoryTrace({
      op: "conflict.log.add",
      layer: "L2",
      status: "ok",
      l2Id: entry.sourceL2Id,
      ragId: entry.sourceRagId,
      details: {
        conflictLogId: entry.id,
        targetL2Id: entry.targetL2Id,
        detector: entry.detector,
        conflictStatus: entry.status,
      },
    })
    return entry
  }

  async getConflictLogs(): Promise<ConflictLog[]> {
    const store = await this.load()
    return store.conflictLogs ?? []
  }

  async scoreConflictLog(
    id: string,
    score: Pick<ConflictLog, "conflictScore" | "resolverPriority" | "scoringSignals">,
  ): Promise<ConflictLog | null> {
    const store = await this.load()
    const log = (store.conflictLogs ?? []).find((entry) => entry.id === id)
    if (!log) return null

    log.conflictScore = score.conflictScore
    log.resolverPriority = score.resolverPriority
    log.scoringSignals = score.scoringSignals
    const shouldQueue = log.status === "candidate" && score.resolverPriority !== "none"
    const didQueue = shouldQueue && log.resolverStatus !== "queued"
    if (shouldQueue) {
      log.resolverStatus = "queued"
      log.resolverQueuedAt = log.resolverQueuedAt ?? Date.now()
      log.resolverAttemptCount = log.resolverAttemptCount ?? 0
    } else {
      log.resolverStatus = "not_queued"
      log.resolverQueuedAt = undefined
      log.resolverAttemptCount = log.resolverAttemptCount ?? 0
    }

    await this.save(store)
    appendMemoryTrace({
      op: "conflict.score",
      layer: "L2",
      status: "ok",
      l2Id: log.sourceL2Id,
      ragId: log.sourceRagId,
      details: {
        conflictLogId: log.id,
        targetL2Id: log.targetL2Id,
        conflictScore: log.conflictScore,
        resolverPriority: log.resolverPriority,
        scoringSignals: log.scoringSignals,
      },
    })
    if (didQueue) {
      appendMemoryTrace({
        op: "resolver.queue.add",
        layer: "L2",
        status: "ok",
        l2Id: log.sourceL2Id,
        ragId: log.sourceRagId,
        details: {
          conflictLogId: log.id,
          targetL2Id: log.targetL2Id,
          resolverPriority: log.resolverPriority,
          conflictScore: log.conflictScore,
        },
      })
    }
    return log
  }

  async getResolverQueue(limit = 20): Promise<ConflictLog[]> {
    const store = await this.load()
    return (store.conflictLogs ?? [])
      .filter((log) => (
        log.status === "candidate" &&
        // failed 条目允许带重试：历史故障（小预算导致 invalid json）曾把 4 条冲突
        // 永久卡在 failed，队列过滤只认 queued 导致修复后也不会再被裁决。
        // 上限 3 次，避免真坏数据无限重试；节奏由调用方 60s 间隔 + 每 5 轮一次控制。
        (log.resolverStatus === "queued" || (
          log.resolverStatus === "failed" && (log.resolverAttemptCount ?? 0) < 3
        )) &&
        log.resolverPriority !== undefined &&
        log.resolverPriority !== "none"
      ))
      .sort((a, b) => {
        const priorityDiff = RESOLVER_PRIORITY_RANK[b.resolverPriority ?? "none"] - RESOLVER_PRIORITY_RANK[a.resolverPriority ?? "none"]
        if (priorityDiff !== 0) return priorityDiff
        return (a.resolverQueuedAt ?? a.createdAt) - (b.resolverQueuedAt ?? b.createdAt)
      })
      .slice(0, limit)
  }

  async applyResolverResolution(conflictLogId: string, resolution: MemoryConflictResolution): Promise<ConflictLog | null> {
    const store = await this.load()
    const log = (store.conflictLogs ?? []).find((entry) => entry.id === conflictLogId)
    if (!log) return null
    const newMemory = store.l2.find((memory) => memory.id === log.sourceL2Id)
    const oldMemory = store.l2.find((memory) => memory.id === log.targetL2Id)
    if (!newMemory || !oldMemory) return null

    let resolutionMemoryId: string | undefined
    const shouldCreateResolved = resolution.actions.createResolvedMemory && Boolean(resolution.resolvedSummary?.trim())
    if (shouldCreateResolved) {
      const resolved: L2Memory = {
        content: resolution.resolvedSummary!.trim(),
        triggerText: resolution.reason,
        sourceConversationId: newMemory.sourceConversationId || oldMemory.sourceConversationId,
        sourceMessageIds: [
          ...(oldMemory.sourceMessageIds ?? []),
          ...(newMemory.sourceMessageIds ?? []),
        ],
        isPinned: false,
        syncStatus: "pending_sync",
        evidenceIds: [
          ...(oldMemory.evidenceIds ?? []),
          ...(newMemory.evidenceIds ?? []),
        ],
        id: `l2_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        createdAt: Date.now(),
        lastAccessedAt: Date.now(),
        accessCount: 0,
        weight: 0,
        status: "active",
      }
      store.l2.push(resolved)
      resolutionMemoryId = resolved.id
    }

    if (resolution.actions.oldMemoryStatus) {
      oldMemory.status = resolution.actions.oldMemoryStatus
      if (resolution.actions.oldMemoryStatus === "superseded" && resolutionMemoryId) {
        oldMemory.supersededBy = resolutionMemoryId
      }
      if (resolution.actions.oldMemoryStatus === "merged" && resolutionMemoryId) {
        oldMemory.mergedInto = resolutionMemoryId
      }
    }
    if (resolution.actions.newMemoryStatus) {
      newMemory.status = resolution.actions.newMemoryStatus
      if (resolution.actions.newMemoryStatus === "superseded" && resolutionMemoryId) {
        newMemory.supersededBy = resolutionMemoryId
      }
      if (resolution.actions.newMemoryStatus === "merged" && resolutionMemoryId) {
        newMemory.mergedInto = resolutionMemoryId
      }
    }

    log.resolverStatus = "resolved"
    log.resolverFinishedAt = Date.now()
    log.resolutionType = resolution.resolutionType
    log.resolutionMemoryId = resolutionMemoryId
    log.resolutionReason = resolution.reason
    log.resolutionConfidence = resolution.confidence
    log.shouldAskUser = resolution.actions.shouldAskUser === true
    log.clarificationNeeded = resolution.actions.clarificationNeeded === true

    if (resolution.resolutionType === "unrelated") {
      log.status = "dismissed"
    } else if (resolution.actions.clarificationNeeded || resolution.actions.shouldAskUser) {
      log.status = "clarification_needed"
    } else {
      log.status = "resolved"
    }

    await this.save(store)
    appendMemoryTrace({
      op: "resolver.resolution.apply",
      layer: "L2",
      status: "ok",
      l2Id: log.sourceL2Id,
      ragId: log.sourceRagId,
      details: {
        conflictLogId: log.id,
        targetL2Id: log.targetL2Id,
        resolutionType: log.resolutionType,
        resolutionMemoryId,
        conflictStatus: log.status,
      },
    })
    return log
  }

  /** 批量更新 L2 条目的 status */
  async updateL2Status(ids: string[], status: L2Memory["status"]): Promise<void> {
    const store = await this.load()
    for (const mem of store.l2) {
      if (ids.includes(mem.id)) {
        mem.status = status
      }
    }
    await this.save(store)
    appendMemoryTrace({
      op: "l2.status.batch",
      layer: "L2",
      status: "ok",
      details: { ids, memoryStatus: status },
    })
  }

  /**
   * 梦境蒸馏合并落账：源条目标 merged 并指向合并后的总结条目。
   * 与 archived 不同，merged 保留"被谁吸收"的血缘，工具通道可溯源。
   */
  async mergeL2Batch(ids: string[], mergedIntoId: string): Promise<void> {
    const store = await this.load()
    const idSet = new Set(ids)
    for (const mem of store.l2) {
      if (!idSet.has(mem.id)) continue
      mem.status = "merged"
      mem.mergedInto = mergedIntoId
    }
    await this.save(store)
    appendMemoryTrace({
      op: "l2.merge.batch",
      layer: "L2",
      status: "ok",
      details: { ids, mergedInto: mergedIntoId },
    })
  }

  async archiveL2Batch(ids: string[]): Promise<void> {
    await this.updateL2Status(ids, "archived")
  }

  /**
   * L2 生命周期衰减：weight 逐次递减（仅作召回热度信号，不再驱动状态），
   * 状态降级只看闲置时长且一次最多降一级：active 闲置满 30 天转 aging，
   * aging 闲置满 90 天转 archived。召回会刷新 lastAccessedAt，常用记忆不受影响。
   * 只处理 active/aging；superseded/merged/archived 一律不碰，避免已废弃条目被复活。
   */
  async decayL2Weights(delta = 1, now = Date.now()): Promise<number> {
    const store = await this.load()
    let changed = 0

    for (const mem of store.l2) {
      if (mem.isPinned || (mem.status !== "active" && mem.status !== "aging")) continue

      let touched = false
      if (mem.weight > 0) {
        mem.weight = Math.max(0, mem.weight - delta)
        touched = true
      }

      const idleMs = now - Math.max(mem.lastAccessedAt || 0, mem.createdAt || 0)
      if (mem.status === "active" && idleMs >= DECAY_AGING_IDLE_MS) {
        mem.status = "aging"
        touched = true
      } else if (mem.status === "aging" && idleMs >= DECAY_ARCHIVE_IDLE_MS) {
        mem.status = "archived"
        touched = true
      }

      if (touched) changed += 1
    }

    // 无论本轮是否有条目变化，都记录运行时间，供调度层每日限频。
    store.lastDecayAt = now
    await this.save(store)
    appendMemoryTrace({
      op: "l2.decay",
      layer: "L2",
      status: changed > 0 ? "ok" : "skip",
      details: { delta, changed },
    })
    return changed
  }

  async getLastDecayAt(): Promise<number> {
    const store = await this.load()
    return store.lastDecayAt ?? 0
  }

  /** 读取重启前尚未提取的残余轮次 */
  async getPendingTurns(): Promise<MemoryJudgeTurn[]> {
    const store = await this.load()
    return (store.pendingTurns ?? []).map((turn) => ({ ...turn }))
  }

  /** 固化尚未提取的残余轮次；单段文本截断，避免长文档粘贴撞大 memory.json 体积 */
  async setPendingTurns(turns: MemoryJudgeTurn[]): Promise<void> {
    const store = await this.load()
    store.pendingTurns = turns.map((turn) => ({
      userInput: snippet(turn.userInput, 4000) ?? "",
      assistantReply: snippet(turn.assistantReply, 4000) ?? "",
    }))
    await this.save(store)
  }

  /** 批量插入新的 L2 条目（压缩总结用） */
  async addL2Batch(inputs: L2Input[]): Promise<L2Memory[]> {
    const store = await this.load()
    const results: L2Memory[] = []
    for (const input of inputs) {
      const memory: L2Memory = {
        ...input,
        id: `l2_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        createdAt: Date.now(),
        lastAccessedAt: Date.now(),
        accessCount: 0,
        weight: 0,
        status: "active",
        syncStatus: input.syncStatus ?? (input.ragId ? "synced" : "pending_sync"),
        evidenceIds: Array.isArray(input.evidenceIds) ? input.evidenceIds : [],
      }
      const evidence = this.createEvidence(memory, input)
      memory.evidenceIds = [...(memory.evidenceIds ?? []), evidence.id]
      store.l2.push(memory)
      if (!store.evidence) store.evidence = []
      store.evidence.push(evidence)
      results.push(memory)
    }
    await this.save(store)
    appendMemoryTrace({
      op: "l2.add.batch",
      layer: "L2",
      status: "ok",
      details: { ids: results.map((item) => item.id), count: results.length },
    })
    for (const memory of results) {
      const evidenceId = memory.evidenceIds?.[memory.evidenceIds.length - 1]
      appendMemoryTrace({
        op: "evidence.add",
        layer: "L2",
        status: "ok",
        l2Id: memory.id,
        details: { evidenceId, sourceStatus: "active" },
      })
    }
    return results
  }

  /** 读取 L2 DMAE 工作记忆状态表（重启恢复驻留集用） */
  async getL2DmaeSnapshot(): Promise<{ states: Record<string, L2DmaeState>; round: number }> {
    const store = await this.load()
    return { states: { ...(store.l2DmaeStates ?? {}) }, round: store.l2DmaeRound ?? 0 }
  }

  /** 整表替换 L2 DMAE 状态；调用方（dmae-manager）负责防抖，这里不做限频 */
  async setL2DmaeSnapshot(states: Record<string, L2DmaeState>, round: number): Promise<void> {
    const store = await this.load()
    store.l2DmaeStates = { ...states }
    store.l2DmaeRound = round
    await this.save(store)
  }

  /** 追加一段梦境沉淀叙事（永不衰减）；上限 8 条，超出滚动丢弃最旧。 */
  async appendDreamNarrative(text: string): Promise<DreamNarrative> {
    const store = await this.load()
    const entry: DreamNarrative = {
      id: `dream_narrative_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      createdAt: Date.now(),
      text,
    }
    store.dreamNarratives = [...(store.dreamNarratives ?? []), entry].slice(-DREAM_NARRATIVE_MAX)
    await this.save(store)
    appendMemoryTrace({
      op: "dream.narrative.add",
      layer: "L2",
      status: "ok",
      details: { id: entry.id, length: text.length },
    })
    return entry
  }

  /** 读取全部梦境叙事（按写入顺序，最新在末尾） */
  async getDreamNarratives(): Promise<DreamNarrative[]> {
    const store = await this.load()
    return [...(store.dreamNarratives ?? [])]
  }
}

export const memoryStore = new MemoryStoreManager()
