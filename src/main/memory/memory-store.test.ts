import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { beforeEach, describe, expect, it, vi } from "vitest"

const electronMock = vi.hoisted(() => ({
  userDataDir: "",
}))

vi.mock("electron", () => ({
  app: {
    getPath: () => electronMock.userDataDir,
  },
}))

function readTraceEvents(): Array<Record<string, unknown>> {
  const tracePath = path.join(electronMock.userDataDir, "memory-trace.log")
  if (!fs.existsSync(tracePath)) return []
  return fs.readFileSync(tracePath, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe("memoryStore", () => {
  beforeEach(() => {
    electronMock.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-"))
    vi.resetModules()
  })

  it("persists L2 conflict markers and status changes", async () => {
    const { memoryStore } = await import("./memory-store")
    const existing = await memoryStore.addL2Memory({
      content: "用户喜欢香菇",
      triggerText: "我喜欢香菇",
      sourceConversationId: "test",
      ragId: "rag_existing",
      isPinned: false,
    })

    const marked = await memoryStore.markL2Conflict(existing.id, "rag_new")

    expect(marked?.conflictWith).toEqual(["rag_new"])
    expect(marked?.status).toBe("aging")

    const persisted = JSON.parse(
      fs.readFileSync(path.join(electronMock.userDataDir, "memory.json"), "utf8"),
    )
    expect(persisted.l2[0].conflictWith).toEqual(["rag_new"])
    expect(persisted.l2[0].status).toBe("aging")

    const traceEvents = readTraceEvents()
    expect(traceEvents.some((event) => event.op === "l2.add" && event.l2Id === existing.id)).toBe(true)
    expect(traceEvents.some((event) => event.op === "l2.conflict.mark" && event.l2Id === existing.id)).toBe(true)
  })

  it("keeps pinned L2 memories active when marking conflicts", async () => {
    const { memoryStore } = await import("./memory-store")
    const existing = await memoryStore.addL2Memory({
      content: "用户喜欢平菇",
      triggerText: "我喜欢平菇",
      sourceConversationId: "test",
      ragId: "rag_existing",
      isPinned: true,
    })

    const marked = await memoryStore.markL2Conflict(existing.id, "rag_new")

    expect(marked?.conflictWith).toEqual(["rag_new"])
    expect(marked?.status).toBe("active")
  })

  it("decays weight without changing status for recently used memories", async () => {
    const { memoryStore } = await import("./memory-store")
    const active = await memoryStore.addL2Memory({
      content: "用户正在练琴",
      triggerText: "我最近在练琴",
      sourceConversationId: "test",
      ragId: "rag_active",
      isPinned: false,
    })
    const pinned = await memoryStore.addL2Memory({
      content: "用户固定喜欢中文",
      triggerText: "我一直用中文",
      sourceConversationId: "test",
      ragId: "rag_pinned",
      isPinned: true,
    })

    const store = await memoryStore.load()
    const activeEntry = store.l2.find((m) => m.id === active.id)!
    const pinnedEntry = store.l2.find((m) => m.id === pinned.id)!
    activeEntry.weight = 10
    pinnedEntry.weight = 10
    await memoryStore.save(store)

    const changed = await memoryStore.decayL2Weights()
    const persisted = JSON.parse(
      fs.readFileSync(path.join(electronMock.userDataDir, "memory.json"), "utf8"),
    )

    expect(changed).toBe(1)
    // 刚写入/刚召回的记忆只掉 weight，状态不受 weight 影响
    expect(persisted.l2.find((m: { id: string }) => m.id === active.id).weight).toBe(9)
    expect(persisted.l2.find((m: { id: string }) => m.id === active.id).status).toBe("active")
    expect(persisted.l2.find((m: { id: string }) => m.id === pinned.id).weight).toBe(10)
    expect(persisted.l2.find((m: { id: string }) => m.id === pinned.id).status).toBe("active")
  })

  it("downgrades idle memories one stage at a time and never touches superseded entries", async () => {
    const { memoryStore } = await import("./memory-store")
    const DAY = 24 * 60 * 60 * 1000
    const now = Date.now()
    const staleActive = await memoryStore.addL2Memory({
      content: "用户去年在学法语",
      triggerText: "我在学法语",
      sourceConversationId: "test",
      ragId: "rag_stale_active",
      isPinned: false,
    })
    const staleAging = await memoryStore.addL2Memory({
      content: "用户曾经想养鸟",
      triggerText: "我想养鸟",
      sourceConversationId: "test",
      ragId: "rag_stale_aging",
      isPinned: false,
    })
    const superseded = await memoryStore.addL2Memory({
      content: "用户住在旧城区",
      triggerText: "我住旧城区",
      sourceConversationId: "test",
      ragId: "rag_superseded",
      isPinned: false,
    })

    const store = await memoryStore.load()
    const a = store.l2.find((m) => m.id === staleActive.id)!
    a.createdAt = now - 120 * DAY
    a.lastAccessedAt = now - 120 * DAY
    const b = store.l2.find((m) => m.id === staleAging.id)!
    b.status = "aging"
    b.createdAt = now - 200 * DAY
    b.lastAccessedAt = now - 120 * DAY
    const c = store.l2.find((m) => m.id === superseded.id)!
    c.status = "superseded"
    c.weight = 35
    c.lastAccessedAt = now - 120 * DAY
    await memoryStore.save(store)

    await memoryStore.decayL2Weights(1, now)
    const persisted = JSON.parse(
      fs.readFileSync(path.join(electronMock.userDataDir, "memory.json"), "utf8"),
    )

    // active 闲置超 90 天也只降一级到 aging，不跳级归档
    expect(persisted.l2.find((m: { id: string }) => m.id === staleActive.id).status).toBe("aging")
    // aging 闲置超 90 天才归档
    expect(persisted.l2.find((m: { id: string }) => m.id === staleAging.id).status).toBe("archived")
    // superseded 不参与衰减，也不会被复活
    expect(persisted.l2.find((m: { id: string }) => m.id === superseded.id).status).toBe("superseded")
    expect(persisted.l2.find((m: { id: string }) => m.id === superseded.id).weight).toBe(35)
    // 运行时间持久化，供调度层限频
    expect(persisted.lastDecayAt).toBe(now)
    expect(await memoryStore.getLastDecayAt()).toBe(now)
  })

  it("refreshes L1 freshness timestamp on content updates but not on roundCount", async () => {
    const { memoryStore } = await import("./memory-store")

    await memoryStore.replaceL1Field("roundCount", 3)
    expect((await memoryStore.getL1()).generatedAt).toBe(0)

    await memoryStore.replaceL1Field("recentGoals", "学法语")
    const l1 = await memoryStore.getL1()
    expect(l1.generatedAt).toBeGreaterThan(0)
    expect(l1.recentGoals).toBe("学法语")
  })

  it("grants legacy L1 content a fresh window during migration repair", async () => {
    const { repairMigrations } = await import("./memory-store")

    const legacy = repairMigrations({
      l1: { recentGoals: "旧目标", recentPreferences: "", currentProject: "", generatedAt: 0, roundCount: 10 },
    })
    expect(legacy.l1.generatedAt).toBeGreaterThan(0)

    // 没有内容的 L1 不伪造时间戳
    const empty = repairMigrations({})
    expect(empty.l1.generatedAt).toBe(0)
  })

  it("treats stale or unset L1 as not fresh", async () => {
    const { isL1Fresh, L1_FRESHNESS_WINDOW_MS } = await import("./memory-types")
    const base = { recentGoals: "g", recentPreferences: "", currentProject: "", roundCount: 0 }

    expect(isL1Fresh({ ...base, generatedAt: 0 })).toBe(false)
    expect(isL1Fresh({ ...base, generatedAt: Date.now() })).toBe(true)
    expect(isL1Fresh({ ...base, generatedAt: Date.now() - L1_FRESHNESS_WINDOW_MS - 1 })).toBe(false)
  })

  it("updates L0 and L2 through atomic write APIs", async () => {
    const { memoryStore } = await import("./memory-store")
    await memoryStore.upsertL0Field("preferredName", "伙伴")
    const memory = await memoryStore.addL2Memory({
      content: "用户最近在做记忆系统重构",
      triggerText: "我们重构记忆系统",
      sourceConversationId: "test",
      ragId: "rag_memory_refactor",
      isPinned: false,
    })
    await memoryStore.updateL2RecallStats(memory.id, 12)

    const l0 = await memoryStore.getL0()
    const allL2 = await memoryStore.getAllL2()
    const updated = allL2.find((item) => item.id === memory.id)!
    const traceEvents = readTraceEvents()

    expect(l0.preferredName).toBe("伙伴")
    expect(l0.updatedAt).toBeGreaterThan(0)
    expect(updated.weight).toBe(12)
    expect(updated.accessCount).toBe(1)
    expect(updated.status).toBe("active")
    expect(traceEvents.some((event) => event.op === "l0.update")).toBe(true)
    expect(traceEvents.some((event) => event.op === "l2.weight.update" && event.l2Id === memory.id)).toBe(true)
  })

  it("does not downgrade an active memory when recording a recall", async () => {
    const { memoryStore } = await import("./memory-store")
    const memory = await memoryStore.addL2Memory({
      content: "用户喜欢香菇",
      triggerText: "我喜欢香菇",
      sourceConversationId: "test",
      ragId: "rag_active_recall",
      isPinned: false,
    })

    await memoryStore.updateL2RecallStats(memory.id, 1)

    const updated = (await memoryStore.getAllL2()).find((item) => item.id === memory.id)!
    expect(updated.weight).toBe(1)
    expect(updated.status).toBe("active")
  })

  it.each(["archived", "superseded", "merged"] as const)(
    "does not let recall statistics reactivate %s L2 memories",
    async (status) => {
      const { memoryStore } = await import("./memory-store")
      const memory = await memoryStore.addL2Memory({
        content: `终止状态 ${status}`,
        triggerText: "测试终止状态",
        sourceConversationId: "test",
        ragId: `rag_${status}`,
        isPinned: false,
      })
      await memoryStore.updateL2Status([memory.id], status)

      await memoryStore.updateL2RecallStats(memory.id, 50)

      const persisted = (await memoryStore.getAllL2()).find((item) => item.id === memory.id)!
      expect(persisted.status).toBe(status)
      expect(persisted.weight).toBe(0)
      expect(persisted.accessCount).toBe(0)
    },
  )

  it("creates evidence for new L2 memories with bounded snippets", async () => {
    const { memoryStore } = await import("./memory-store")
    const longTrigger = "证据".repeat(180)
    const memory = await memoryStore.addL2Memory({
      content: "用户希望记忆系统保留证据链",
      triggerText: longTrigger,
      sourceConversationId: "conv_evidence",
      sourceMessageIds: ["msg_1", "msg_2"],
      ragId: "rag_evidence",
      isPinned: false,
    })

    const evidence = await memoryStore.getEvidenceByMemoryId(memory.id)
    const traceEvents = readTraceEvents()

    expect(memory.evidenceIds).toHaveLength(1)
    expect(evidence).toHaveLength(1)
    expect(evidence[0].id).toBe(memory.evidenceIds?.[0])
    expect(evidence[0].quoteSnippet.length).toBe(300)
    expect(evidence[0].conversationId).toBe("conv_evidence")
    expect(evidence[0].messageIds).toEqual(["msg_1", "msg_2"])
    expect(evidence[0].sourceStatus).toBe("active")
    expect(traceEvents.some((event) => event.op === "evidence.add" && event.l2Id === memory.id)).toBe(true)
  })

  it("deletes evidence together with a rolled-back L2 memory", async () => {
    const { memoryStore } = await import("./memory-store")
    const memory = await memoryStore.addL2Memory({
      content: "临时压缩摘要",
      triggerText: "compression",
      sourceConversationId: "test",
      isPinned: false,
      isSummary: true,
      syncStatus: "pending_sync",
    })

    await memoryStore.deleteL2(memory.id)

    const store = await memoryStore.load()
    expect(store.l2.some((item) => item.id === memory.id)).toBe(false)
    expect((store.evidence ?? []).some((item) => item.memoryId === memory.id)).toBe(false)
  })

  it("marks L2 sync status and persists rag ids", async () => {
    const { memoryStore } = await import("./memory-store")
    const memory = await memoryStore.addL2Memory({
      content: "用户喜欢可靠的长期记忆",
      triggerText: "长期记忆要可靠",
      sourceConversationId: "test",
      isPinned: false,
      syncStatus: "pending_sync",
    })

    const synced = await memoryStore.markL2SyncStatus(memory.id, "synced", "rag_synced")
    const persisted = JSON.parse(
      fs.readFileSync(path.join(electronMock.userDataDir, "memory.json"), "utf8"),
    )
    const traceEvents = readTraceEvents()

    expect(synced?.syncStatus).toBe("synced")
    expect(synced?.ragId).toBe("rag_synced")
    expect(persisted.l2[0].syncStatus).toBe("synced")
    expect(persisted.l2[0].ragId).toBe("rag_synced")
    expect(traceEvents.some((event) => event.op === "l2.sync.success" && event.l2Id === memory.id)).toBe(true)
  })

  it("stores conflict logs separately from reflection logs with a capped history", async () => {
    const { memoryStore } = await import("./memory-store")
    for (let i = 0; i < 101; i++) {
      await memoryStore.appendConflictLog({
        status: "candidate",
        sourceL2Id: `source_${i}`,
        targetL2Id: `target_${i}`,
        sourceRagId: `rag_source_${i}`,
        targetRagId: `rag_target_${i}`,
        reason: "test conflict",
        confidence: 0.7,
        detector: "local",
      })
    }

    const conflictLogs = await memoryStore.getConflictLogs()
    const reflectionLogs = await memoryStore.getReflectionLogs()
    const persisted = JSON.parse(
      fs.readFileSync(path.join(electronMock.userDataDir, "memory.json"), "utf8"),
    )

    expect(conflictLogs).toHaveLength(100)
    expect(conflictLogs[0].sourceL2Id).toBe("source_1")
    expect(reflectionLogs).toHaveLength(0)
    expect(persisted.conflictLogs).toHaveLength(100)
  })

  it("persists conflict scores and emits conflict.score trace", async () => {
    const { memoryStore } = await import("./memory-store")
    const log = await memoryStore.appendConflictLog({
      status: "candidate",
      sourceL2Id: "source",
      targetL2Id: "target",
      sourceRagId: "rag_source",
      targetRagId: "rag_target",
      reason: "rag candidate",
      confidence: 0.7,
      detector: "local",
    })

    const scored = await memoryStore.scoreConflictLog(log.id, {
      conflictScore: 55,
      resolverPriority: "normal",
      scoringSignals: {
        ragCandidate: true,
        evidenceAvailable: true,
        localContradiction: true,
        impactScope: "medium",
        penalties: [],
      },
    })

    const conflictLogs = await memoryStore.getConflictLogs()
    const traceEvents = readTraceEvents()

    expect(scored?.conflictScore).toBe(55)
    expect(conflictLogs[0].resolverPriority).toBe("normal")
    expect(conflictLogs[0].scoringSignals).toMatchObject({
      ragCandidate: true,
      evidenceAvailable: true,
      localContradiction: true,
      impactScope: "medium",
    })
    expect(traceEvents.some((event) => event.op === "conflict.score" && event.l2Id === "source")).toBe(true)
  })

  it("queues resolver-eligible conflict logs when scoring priority is not none", async () => {
    const { memoryStore } = await import("./memory-store")
    const log = await memoryStore.appendConflictLog({
      status: "candidate",
      sourceL2Id: "source",
      targetL2Id: "target",
      reason: "resolver eligible",
      confidence: 0.8,
      detector: "local",
    })

    await memoryStore.scoreConflictLog(log.id, {
      conflictScore: 75,
      resolverPriority: "high",
      scoringSignals: {
        ragCandidate: true,
        evidenceAvailable: true,
        localContradiction: true,
        penalties: [],
      },
    })

    const queue = await memoryStore.getResolverQueue()
    const traceEvents = readTraceEvents()

    expect(queue).toHaveLength(1)
    expect(queue[0]).toMatchObject({
      id: log.id,
      resolverStatus: "queued",
      resolverPriority: "high",
      resolverAttemptCount: 0,
    })
    expect(queue[0].resolverQueuedAt).toBeGreaterThan(0)
    expect(traceEvents.some((event) => event.op === "resolver.queue.add" && event.l2Id === "source")).toBe(true)
  })

  it("does not queue conflict logs with none resolver priority", async () => {
    const { memoryStore } = await import("./memory-store")
    const log = await memoryStore.appendConflictLog({
      status: "candidate",
      sourceL2Id: "source",
      targetL2Id: "target",
      reason: "low score",
      confidence: 0.35,
      detector: "local",
    })

    await memoryStore.scoreConflictLog(log.id, {
      conflictScore: 20,
      resolverPriority: "none",
      scoringSignals: {
        ragCandidate: false,
        localContradiction: true,
        penalties: [],
      },
    })

    const conflictLogs = await memoryStore.getConflictLogs()
    const queue = await memoryStore.getResolverQueue()

    expect(conflictLogs[0].resolverStatus).toBe("not_queued")
    expect(queue).toHaveLength(0)
  })

  it("returns queued resolver logs by priority and age", async () => {
    const { memoryStore } = await import("./memory-store")
    const idle = await memoryStore.appendConflictLog({
      status: "candidate",
      sourceL2Id: "idle_source",
      targetL2Id: "idle_target",
      reason: "idle",
      confidence: 0.4,
      detector: "local",
    })
    const high = await memoryStore.appendConflictLog({
      status: "candidate",
      sourceL2Id: "high_source",
      targetL2Id: "high_target",
      reason: "high",
      confidence: 0.9,
      detector: "local",
    })

    await memoryStore.scoreConflictLog(idle.id, {
      conflictScore: 40,
      resolverPriority: "idle",
      scoringSignals: { ragCandidate: true, penalties: [] },
    })
    await memoryStore.scoreConflictLog(high.id, {
      conflictScore: 80,
      resolverPriority: "high",
      scoringSignals: { ragCandidate: true, penalties: [] },
    })

    const queue = await memoryStore.getResolverQueue()

    expect(queue.map((entry) => entry.id)).toEqual([high.id, idle.id])
  })

  it("applies preference evolution by creating resolved memory and marking old entries", async () => {
    const { memoryStore } = await import("./memory-store")
    const oldMemory = await memoryStore.addL2Memory({
      content: "用户喜欢跑步",
      triggerText: "我喜欢跑步",
      sourceConversationId: "test",
      ragId: "rag_old",
      isPinned: false,
    })
    const newMemory = await memoryStore.addL2Memory({
      content: "用户不喜欢跑步",
      triggerText: "我现在不喜欢跑步",
      sourceConversationId: "test",
      ragId: "rag_new",
      isPinned: false,
    })
    const log = await memoryStore.appendConflictLog({
      status: "candidate",
      sourceL2Id: newMemory.id,
      targetL2Id: oldMemory.id,
      reason: "test",
      confidence: 0.8,
      detector: "local",
    })

    const applied = await memoryStore.applyResolverResolution(log.id, {
      resolutionType: "preference_evolution",
      resolvedSummary: "用户过去喜欢跑步，但现在不喜欢跑步。",
      reason: "用户表达了当前偏好变化。",
      confidence: 0.88,
      actions: {
        createResolvedMemory: true,
        oldMemoryStatus: "superseded",
        newMemoryStatus: "merged",
        shouldAskUser: false,
        clarificationNeeded: false,
      },
    })

    const allL2 = await memoryStore.getAllL2()
    const conflictLogs = await memoryStore.getConflictLogs()
    const resolvedMemory = allL2.find((memory) => memory.id === applied?.resolutionMemoryId)

    expect(resolvedMemory?.content).toBe("用户过去喜欢跑步，但现在不喜欢跑步。")
    expect(allL2.find((memory) => memory.id === oldMemory.id)?.status).toBe("superseded")
    expect(allL2.find((memory) => memory.id === newMemory.id)?.status).toBe("merged")
    expect(conflictLogs[0]).toMatchObject({
      status: "resolved",
      resolverStatus: "resolved",
      resolutionType: "preference_evolution",
      resolutionConfidence: 0.88,
    })
  })

  it("marks direct conflicts as clarification needed without creating resolved memory", async () => {
    const { memoryStore } = await import("./memory-store")
    const oldMemory = await memoryStore.addL2Memory({
      content: "用户喜欢被叫 Playa",
      triggerText: "叫我 Playa",
      sourceConversationId: "test",
      ragId: "rag_old",
      isPinned: false,
    })
    const newMemory = await memoryStore.addL2Memory({
      content: "用户不喜欢被叫 Playa",
      triggerText: "别叫我 Playa",
      sourceConversationId: "test",
      ragId: "rag_new",
      isPinned: false,
    })
    const log = await memoryStore.appendConflictLog({
      status: "candidate",
      sourceL2Id: newMemory.id,
      targetL2Id: oldMemory.id,
      reason: "test",
      confidence: 0.8,
      detector: "local",
    })

    await memoryStore.applyResolverResolution(log.id, {
      resolutionType: "direct_conflict",
      reason: "称呼偏好直接冲突，需要自然澄清。",
      confidence: 0.82,
      actions: {
        createResolvedMemory: false,
        shouldAskUser: true,
        clarificationNeeded: true,
      },
    })

    const allL2 = await memoryStore.getAllL2()
    const conflictLogs = await memoryStore.getConflictLogs()

    expect(allL2).toHaveLength(2)
    expect(conflictLogs[0]).toMatchObject({
      status: "clarification_needed",
      resolverStatus: "resolved",
      shouldAskUser: true,
      clarificationNeeded: true,
    })
  })

  it("caps reflection logs separately from conflict logs", async () => {
    const { memoryStore } = await import("./memory-store")
    await memoryStore.appendConflictLog({
      status: "candidate",
      sourceL2Id: "source",
      targetL2Id: "target",
      reason: "test conflict",
      confidence: 0.35,
      detector: "local",
    })

    for (let i = 0; i < 51; i++) {
      await memoryStore.appendReflectionLog({
        type: "l1_update",
        summary: `reflection ${i}`,
      })
    }

    const reflectionLogs = await memoryStore.getReflectionLogs()
    const conflictLogs = await memoryStore.getConflictLogs()
    const traceEvents = readTraceEvents()

    expect(reflectionLogs).toHaveLength(50)
    expect(reflectionLogs[0].summary).toBe("reflection 1")
    expect(conflictLogs).toHaveLength(1)
    expect(traceEvents.some((event) => event.op === "reflection.log.add")).toBe(true)
    expect(traceEvents.some((event) => event.op === "conflict.log.add")).toBe(true)
  })

  it("migrates legacy memory files with a backup", async () => {
    const memoryPath = path.join(electronMock.userDataDir, "memory.json")
    fs.writeFileSync(
      memoryPath,
      JSON.stringify({
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
          status: "active",
          ragId: "rag_legacy",
        }],
        evidence: [],
        reflectionLogs: [],
        version: 1,
      }),
      "utf8",
    )

    const { memoryStore } = await import("./memory-store")
    const store = await memoryStore.load()
    const persisted = JSON.parse(fs.readFileSync(memoryPath, "utf8"))
    const backups = fs.readdirSync(electronMock.userDataDir).filter((name) => name.startsWith("memory.backup."))

    expect(store.schemaVersion).toBe(2)
    expect(persisted.schemaVersion).toBe(2)
    expect(store.l0.preferredName).toBe("伙伴")
    expect(store.l1.roundCount).toBe(7)
    expect(store.l2[0].syncStatus).toBe("synced")
    expect(store.l2[0].evidenceIds).toEqual([])
    expect(store.evidence).toEqual([])
    expect(store.conflictLogs).toEqual([])
    expect(backups).toHaveLength(1)
    expect(readTraceEvents().some((event) => event.op === "migration.upgrade")).toBe(true)
  })

  it("round-trips pending turns and truncates oversized text", async () => {
    const { memoryStore } = await import("./memory-store")

    // 默认为空（含存量数据无 pendingTurns 字段的情况）
    expect(await memoryStore.getPendingTurns()).toEqual([])

    await memoryStore.setPendingTurns([
      { userInput: "我在学钢琴", assistantReply: "好厉害！" },
      { userInput: "x".repeat(5000), assistantReply: "ok" },
    ])

    const restored = await memoryStore.getPendingTurns()
    expect(restored).toHaveLength(2)
    expect(restored[0]).toEqual({ userInput: "我在学钢琴", assistantReply: "好厉害！" })
    expect(restored[1].userInput).toHaveLength(4000)

    // 落盘验证：重启（重新 import）后仍能读到
    const persisted = JSON.parse(
      fs.readFileSync(path.join(electronMock.userDataDir, "memory.json"), "utf8"),
    )
    expect(persisted.pendingTurns).toHaveLength(2)

    // 清空
    await memoryStore.setPendingTurns([])
    expect(await memoryStore.getPendingTurns()).toEqual([])
  })
})
