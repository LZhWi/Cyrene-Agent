import { describe, expect, it } from "vitest"
import { repairMigrations } from "./memory-store-migrations"

describe("repairMigrations", () => {
  it("repairs a legacy store missing keywords, syncStatus, evidenceIds and dmae states", () => {
    const legacy = {
      l0: { preferredName: "伙伴" },
      l1: { roundCount: 7 },
      l2: [{
        id: "l2_legacy",
        content: "旧记忆",
        triggerText: "旧触发",
        sourceConversationId: "test",
        createdAt: 1,
        lastAccessedAt: 1,
        accessCount: 0,
        weight: 0,
        isPinned: false,
        status: "active" as const,
        ragId: "rag_legacy",
      }],
      evidence: [],
      reflectionLogs: [],
      conflictLogs: [],
      version: 1,
    }

    const repaired = repairMigrations(legacy)
    expect(repaired.schemaVersion).toBe(2)
    expect(repaired.l2[0].syncStatus).toBe("synced")
    expect(repaired.l2[0].evidenceIds).toEqual([])
    expect(repaired.l2[0].keywords.length).toBeGreaterThan(0)
    expect(repaired.l2DmaeStates).toEqual([expect.objectContaining({
      l2Id: "l2_legacy",
      state: "archived",
    })])
  })

  it("repairs a legacy store without a ragId as pending_sync", () => {
    const legacy = {
      l0: {},
      l1: {},
      l2: [{
        id: "l2_unsynced",
        content: "咖啡记忆",
        triggerText: "我喝咖啡",
        sourceConversationId: "test",
        createdAt: 1,
        lastAccessedAt: 1,
        accessCount: 0,
        weight: 0,
        isPinned: false,
        status: "active" as const,
      }],
      version: 1,
    }

    const repaired = repairMigrations(legacy)
    expect(repaired.schemaVersion).toBe(2)
    expect(repaired.l2[0].syncStatus).toBe("pending_sync")
    expect(repaired.l2DmaeStates).toHaveLength(1)
  })

  it("backfills conflict log resolver fields with the exact fallbacks", () => {
    const repaired = repairMigrations({
      l0: {},
      l1: {},
      l2: [],
      conflictLogs: [
        {
          id: "conf_1",
          createdAt: 1,
          status: "candidate",
          sourceL2Id: "source",
          targetL2Id: "target",
          reason: "test",
          confidence: 0.7,
          detector: "local",
          resolverPriority: "high",
        },
        {
          id: "conf_2",
          createdAt: 2,
          status: "candidate",
          sourceL2Id: "source",
          targetL2Id: "target",
          reason: "test",
          confidence: 0.7,
          detector: "local",
          resolverStatus: "resolved",
          resolverAttemptCount: 3,
        },
      ] as never,
      version: 1,
    })

    expect(repaired.conflictLogs).toHaveLength(2)
    expect(repaired.conflictLogs?.[0]).toMatchObject({
      resolverStatus: "queued",
      resolverAttemptCount: 0,
    })
    expect(repaired.conflictLogs?.[1]).toMatchObject({
      resolverStatus: "resolved",
      resolverAttemptCount: 3,
    })
  })
})
