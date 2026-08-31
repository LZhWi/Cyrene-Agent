import { MemoryStore } from "./memory-types"
import {
  CURRENT_MEMORY_SCHEMA_VERSION,
  DEFAULT_L1,
  createDefaultL0,
  extractMemoryKeywords,
} from "./memory-store-defaults"

export function repairMigrations(store: Partial<MemoryStore>): MemoryStore {
  const repaired: MemoryStore = {
    schemaVersion: CURRENT_MEMORY_SCHEMA_VERSION,
    l0: { ...createDefaultL0(), ...store.l0 },
    l1: { ...DEFAULT_L1, ...store.l1 },
    l2: Array.isArray(store.l2) ? store.l2.map((memory) => {
      const keywords = Array.isArray(memory.keywords) && memory.keywords.length > 0
        ? memory.keywords
        : extractMemoryKeywords(`${memory.content} ${memory.triggerText}`)
      return {
        ...memory,
        syncStatus: memory.syncStatus ?? (memory.ragId ? "synced" : "pending_sync"),
        evidenceIds: Array.isArray(memory.evidenceIds) ? memory.evidenceIds : [],
        keywords,
      }
    }) : [],
    evidence: Array.isArray(store.evidence) ? store.evidence : [],
    reflectionLogs: Array.isArray(store.reflectionLogs) ? store.reflectionLogs : [],
    conflictLogs: Array.isArray(store.conflictLogs) ? store.conflictLogs.map((log) => ({
      ...log,
      resolverStatus: log.resolverStatus ?? (log.resolverPriority && log.resolverPriority !== "none" ? "queued" : "not_queued"),
      resolverAttemptCount: typeof log.resolverAttemptCount === "number" ? log.resolverAttemptCount : 0,
    })) : [],
    l2DmaeStates: Array.isArray(store.l2DmaeStates) ? store.l2DmaeStates : [],
    version: typeof store.version === "number" ? store.version : 1,
  }

  // V5 DMAE：为没有 l2DmaeState 的 L2 补初始化
  const stateIds = new Set(repaired.l2DmaeStates?.map((s) => s.l2Id) ?? [])
  for (const memory of repaired.l2) {
    if (!stateIds.has(memory.id)) {
      repaired.l2DmaeStates!.push({
        l2Id: memory.id,
        activation: 0,
        intrinsicValue: 0,
        userSilence: 0,
        modelSilence: 0,
        recentUserHits: [],
        state: memory.status === "archived" ? "archived" : "archived",
      })
    }
  }

  return repaired
}
