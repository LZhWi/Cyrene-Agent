import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { beforeEach, describe, expect, it, vi } from "vitest"

const electronMock = vi.hoisted(() => ({
  userDataDir: "",
}))
const REAL_MEMORY_PATH = "C:/Users/ASUS/AppData/Roaming/live2d-cyrene/memory.json"

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

  it("recovers the last valid snapshot when memory.json is truncated", async () => {
    const first = await import("./memory-store")
    await first.memoryStore.addL2Memory({
      content: "不能因半写文件丢失的真实记忆",
      triggerText: "请记住",
      sourceConversationId: "test",
      isPinned: false,
    })
    const memoryPath = path.join(electronMock.userDataDir, "memory.json")
    const lastGoodPath = path.join(electronMock.userDataDir, "memory.last-good.json")
    expect(fs.existsSync(lastGoodPath)).toBe(true)
    fs.writeFileSync(memoryPath, '{"schemaVersion":3,"l2":[', "utf8")

    vi.resetModules()
    const reloaded = await import("./memory-store")
    const recovered = await reloaded.memoryStore.getAllL2()

    expect(recovered.map((item) => item.content)).toContain("不能因半写文件丢失的真实记忆")
    expect(() => JSON.parse(fs.readFileSync(memoryPath, "utf8"))).not.toThrow()
  })

  it.skipIf(!fs.existsSync(REAL_MEMORY_PATH))("recovers an exact copy of the real memory corpus after truncation", async () => {
    const realRaw = fs.readFileSync(REAL_MEMORY_PATH, "utf8")
    const real = JSON.parse(realRaw) as { l2?: unknown[]; evidence?: unknown[] }
    fs.writeFileSync(path.join(electronMock.userDataDir, "memory.json"), '{"schemaVersion":3,"l2":[', "utf8")
    fs.writeFileSync(path.join(electronMock.userDataDir, "memory.last-good.json"), realRaw, "utf8")

    const { memoryStore } = await import("./memory-store")
    const recovered = await memoryStore.load()

    expect(recovered.l2).toHaveLength(real.l2?.length ?? 0)
    expect(recovered.evidence).toHaveLength(real.evidence?.length ?? 0)
    expect(recovered.l2.map((item) => item.id)).toEqual((real.l2 as Array<{ id: string }>).map((item) => item.id))
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

  it("normalizes validFrom from createdAt for legacy L2 entries during migration repair", async () => {
    const { repairMigrations } = await import("./memory-store")

    const repaired = repairMigrations({
      l2: [
        {
          id: "l2_old",
          content: "旧事实",
          triggerText: "旧触发",
          sourceConversationId: "test",
          createdAt: 123,
          lastAccessedAt: 123,
          accessCount: 0,
          weight: 5,
          isPinned: false,
          status: "active",
          ragId: "rag_old",
        } as never,
        {
          id: "l2_new",
          content: "新事实",
          triggerText: "新触发",
          sourceConversationId: "test",
          createdAt: 999,
          lastAccessedAt: 999,
          accessCount: 0,
          weight: 5,
          isPinned: false,
          status: "active",
          ragId: "rag_new",
          validFrom: 500,
          validTo: 800,
        } as never,
      ],
    })

    // 旧条目用 createdAt 补齐 validFrom；validTo 不伪造
    expect(repaired.l2[0].validFrom).toBe(123)
    expect(repaired.l2[0].validTo).toBeUndefined()
    // 已有有效期字段的条目不被覆盖
    expect(repaired.l2[1].validFrom).toBe(500)
    expect(repaired.l2[1].validTo).toBe(800)
  })

  it("treats stale or unset L1 as not fresh", async () => {
    const { isL1Fresh, L1_FRESHNESS_WINDOW_MS } = await import("./memory-types")
    const base = { recentGoals: "g", recentPreferences: "", currentProject: "", roundCount: 0 }

    expect(isL1Fresh({ ...base, generatedAt: 0 })).toBe(false)
    expect(isL1Fresh({ ...base, generatedAt: Date.now() })).toBe(true)
    expect(isL1Fresh({ ...base, generatedAt: Date.now() - L1_FRESHNESS_WINDOW_MS - 1 })).toBe(false)
  })

  it("treats memories past validTo or before validFrom as expired", async () => {
    const { isL2Expired } = await import("./memory-types")
    const base = {
      id: "l2_expiry_probe",
      content: "事实",
      triggerText: "触发",
      sourceConversationId: "test",
      createdAt: 100,
      lastAccessedAt: 100,
      accessCount: 0,
      weight: 0,
      isPinned: false,
      status: "active" as const,
    }
    const now = 1000

    expect(isL2Expired({ ...base }, now)).toBe(false)
    expect(isL2Expired({ ...base, validTo: 1000 }, now)).toBe(true)
    expect(isL2Expired({ ...base, validTo: 1001 }, now)).toBe(false)
    expect(isL2Expired({ ...base, validFrom: 1001 }, now)).toBe(true)
    expect(isL2Expired({ ...base, validFrom: 500, validTo: 900 }, now)).toBe(true)
    expect(isL2Expired({ ...base, validFrom: 500, validTo: 2000 }, now)).toBe(false)
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

  it("refreshes recall stats for the final injected set in one batch", async () => {
    const { memoryStore } = await import("./memory-store")
    const now = 1_700_000_000_000
    const active = await memoryStore.addL2Memory({
      content: "用户喜欢香菇",
      triggerText: "我喜欢香菇",
      sourceConversationId: "test",
      ragId: "rag_batch_active",
      isPinned: false,
    })
    const aging = await memoryStore.addL2Memory({
      content: "用户以前养过猫",
      triggerText: "我养过猫",
      sourceConversationId: "test",
      ragId: "rag_batch_aging",
      isPinned: false,
    })
    const dead = await memoryStore.addL2Memory({
      content: "用户住在旧城区",
      triggerText: "我住旧城区",
      sourceConversationId: "test",
      ragId: "rag_batch_dead",
      isPinned: false,
    })

    // 预置：aging 条目 weight 低于复活线；superseded 条目不应被复活
    const store = await memoryStore.load()
    const agingEntry = store.l2.find((m) => m.id === aging.id)!
    agingEntry.status = "aging"
    agingEntry.weight = 10
    const deadEntry = store.l2.find((m) => m.id === dead.id)!
    deadEntry.status = "superseded"
    deadEntry.weight = 5
    await memoryStore.save(store)

    const changed = await memoryStore.recordL2RecallsBatch([active.id, aging.id, dead.id, "not_exist"], now)
    const all = await memoryStore.getAllL2()
    const a = all.find((item) => item.id === active.id)!
    const b = all.find((item) => item.id === aging.id)!
    const c = all.find((item) => item.id === dead.id)!
    const traceEvents = readTraceEvents()

    expect(changed).toBe(2)
    // active 保持 active，权重 +1
    expect(a.weight).toBe(1)
    expect(a.lastAccessedAt).toBe(now)
    expect(a.accessCount).toBe(1)
    expect(a.status).toBe("active")
    // aging 未到复活线仍是 aging，但统计已刷新（下次衰减不会误伤）
    expect(b.weight).toBe(11)
    expect(b.lastAccessedAt).toBe(now)
    expect(b.status).toBe("aging")
    // superseded 不复活
    expect(c.weight).toBe(5)
    expect(c.status).toBe("superseded")
    expect(traceEvents.some((event) => event.op === "l2.recall.batch")).toBe(true)
  })

  it("supersedes an old L2 memory with validity window and never double-processes", async () => {
    const { memoryStore } = await import("./memory-store")
    const now = 1_700_000_000_000
    const oldMemory = await memoryStore.addL2Memory({
      content: "用户喜欢甜豆浆",
      triggerText: "我喜欢甜豆浆",
      sourceConversationId: "test",
      ragId: "rag_supersede_old",
      isPinned: false,
    })

    expect(await memoryStore.supersedeL2(oldMemory.id, "l2_new_id", now)).toBe(true)
    const updated = (await memoryStore.getAllL2()).find((item) => item.id === oldMemory.id)!
    expect(updated.status).toBe("superseded")
    expect(updated.supersededBy).toBe("l2_new_id")
    expect(updated.validTo).toBe(now)

    // 已 superseded 的条目不再重复处理；不存在的 id 返回 false
    expect(await memoryStore.supersedeL2(oldMemory.id, "l2_other", now + 1)).toBe(false)
    expect(await memoryStore.supersedeL2("not_exist", "l2_x", now)).toBe(false)

    const still = (await memoryStore.getAllL2()).find((item) => item.id === oldMemory.id)!
    expect(still.supersededBy).toBe("l2_new_id")
    expect(still.validTo).toBe(now)
    expect(readTraceEvents().some((event) => event.op === "l2.supersede" && event.l2Id === oldMemory.id)).toBe(true)
  })

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
          facets: { kind: "fact", source: "model", pendingClassification: false },
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

    expect(store.schemaVersion).toBe(6)
    expect(persisted.schemaVersion).toBe(6)
    expect(store.l0.preferredName).toBe("伙伴")
    expect(store.l1.roundCount).toBe(7)
    expect(store.l2[0].syncStatus).toBe("synced")
    expect(store.l2[0].evidenceIds).toEqual([])
    // v3 迁移：旧条目无 validFrom，用 createdAt 归一化；validTo 不伪造
    expect(store.l2[0].validFrom).toBe(1)
    expect(store.l2[0].validTo).toBeUndefined()
    expect(store.l2[0].facets).toEqual({
      primaryKind: "fact",
      retrievalKinds: ["fact"],
      source: "model",
      pendingClassification: false,
    })
    expect(store.evidence).toEqual([])
    expect(store.conflictLogs).toEqual([])
    expect(backups).toHaveLength(1)
    expect(readTraceEvents().some((event) => event.op === "migration.upgrade")).toBe(true)
  })

  it("lets the v2 model backfill replace a migrated legacy single label", async () => {
    const { memoryStore } = await import("./memory-store")
    const memory = await memoryStore.addL2Memory({
      content: "用户计划参加舞会，并答应买完西装拍照给AI看",
      triggerText: "我会买完拍照给你看",
      sourceConversationId: "test",
      isPinned: false,
      facets: { primaryKind: "goal", retrievalKinds: ["goal"], source: "model", pendingClassification: false },
    })

    expect(await memoryStore.updateL2FacetsBatch([{
      id: memory.id,
      facets: { primaryKind: "goal", retrievalKinds: ["goal", "commitment"], source: "model", pendingClassification: false },
    }])).toBe(1)
    expect((await memoryStore.getAllL2()).find((item) => item.id === memory.id)?.facets?.retrievalKinds)
      .toEqual(["goal", "commitment"])
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

  it("round-trips L2 DMAE working-memory states across restart", async () => {
    const { memoryStore } = await import("./memory-store")

    // 默认为空表（存量数据没有 l2DmaeStates 字段也不报错）
    expect(await memoryStore.getL2DmaeSnapshot()).toEqual({ states: {}, round: 0 })

    await memoryStore.setL2DmaeSnapshot(
      {
        l2_topic: { activation: 36, userSilence: 0, modelSilence: 0, lastInjectedRound: 1, round: 1 },
      },
      1,
    )

    // 落盘验证：memory.json 里确实写入了状态表
    const persisted = JSON.parse(
      fs.readFileSync(path.join(electronMock.userDataDir, "memory.json"), "utf8"),
    )
    expect(persisted.l2DmaeStates.l2_topic.activation).toBe(36)
    expect(persisted.l2DmaeRound).toBe(1)

    // 重启（重新 import）后驻留集完整恢复
    vi.resetModules()
    const reloaded = await import("./memory-store")
    const restored = await reloaded.memoryStore.getL2DmaeSnapshot()
    expect(restored.round).toBe(1)
    expect(restored.states.l2_topic.activation).toBe(36)
  })
})
