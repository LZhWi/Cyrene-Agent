import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const projectRoot = process.cwd()
const realUserDataDir = process.env.CYRENE_REAL_USER_DATA_DIR
  || path.join(process.env.APPDATA || "", "live2d-cyrene")
const chatRoot = path.join(realUserDataDir, "cyrene-chats")
const indexPath = path.join(chatRoot, "index.json")
const protectedUserDataRelativePaths = [
  "memory.json",
  path.join("rag-data", "memory-store.json"),
  "entity-graph.json",
  "worldbook-state.json",
  "model-settings.json",
]

function digest(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")
}

const metas = JSON.parse(fs.readFileSync(indexPath, "utf8"))
const sourcePaths = [
  indexPath,
  ...protectedUserDataRelativePaths
    .map((relativePath) => path.join(realUserDataDir, relativePath))
    .filter((filePath) => fs.existsSync(filePath)),
]
const candidates = []
for (const meta of metas) {
  if (typeof meta.id !== "string") continue
  const sessionPath = path.join(chatRoot, "sessions", `${meta.id}.json`)
  if (!fs.existsSync(sessionPath)) continue
  sourcePaths.push(sessionPath)
  const session = JSON.parse(fs.readFileSync(sessionPath, "utf8"))
  const pairs = []
  for (let index = 0; index < (session.messages || []).length - 1; index += 1) {
    const user = session.messages[index]
    const assistant = session.messages[index + 1]
    if (user.role !== "user" || assistant.role !== "model") continue
    if (!user.content?.trim() || !assistant.content?.trim()) continue
    pairs.push({ user, assistant })
    index += 1
  }
  if (pairs.length >= 7) candidates.push({ sessionPath, session, pairs })
}
assert.ok(candidates.length > 0, "真实聊天中没有至少 7 轮的可用会话")

const before = Object.fromEntries(sourcePaths.map((filePath) => [filePath, digest(filePath)]))
const selected = candidates[0]
const selectedPairs = selected.pairs.slice(-7)
const isolatedDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-realtime-memory-"))
const isolatedUserDataDir = path.join(isolatedDir, "userData")
const isolatedSessionPath = path.join(isolatedDir, "session.json")
fs.mkdirSync(isolatedUserDataDir, { recursive: true })
fs.copyFileSync(selected.sessionPath, isolatedSessionPath)
for (const relativePath of protectedUserDataRelativePaths) {
  const sourcePath = path.join(realUserDataDir, relativePath)
  if (!fs.existsSync(sourcePath)) continue
  const targetPath = path.join(isolatedUserDataDir, relativePath)
  fs.mkdirSync(path.dirname(targetPath), { recursive: true })
  fs.copyFileSync(sourcePath, targetPath)
}

let queue = Promise.resolve()
let roundCount = 0
let pendingTurns = []
const judgeCalls = []
let resetRAG
let setAppPathProvider

try {
  ;({ setAppPathProvider } = require(path.join(projectRoot, "dist/main/main/runtime/runtime-paths.js")))
  setAppPathProvider({
    getPath: (name) => name === "userData" ? isolatedUserDataDir : isolatedDir,
    getAppPath: () => projectRoot,
  })
  const { MemoryScheduler } = require(path.join(projectRoot, "dist/main/main/memory/memory-scheduler.js"))
  const scheduler = new MemoryScheduler({
    ingestEntity: () => {},
    enqueueTask: (_label, task) => {
      const run = queue.then(task)
      queue = run.then(() => undefined, () => undefined)
      return run
    },
    judgeMemory: async (turns, conversationId) => {
      judgeCalls.push({ turns, conversationId })
      return []
    },
    writeMemory: async () => {},
    getL1: async () => ({ recentGoals: "", recentPreferences: "", currentProject: "", generatedAt: 0, roundCount }),
    replaceL1Field: async (_field, value) => { roundCount = value },
    runReflectionAndCompression: async () => {},
    runResolverQueueOnce: async () => {},
    getLastDecayAt: async () => Date.now(),
    runDecay: async () => {},
    loadPendingTurns: async () => pendingTurns.map((turn) => ({ ...turn })),
    savePendingTurns: async (turns) => { pendingTurns = turns.map((turn) => ({ ...turn })) },
    loadConversationMessages: async () => {
      const session = JSON.parse(fs.readFileSync(isolatedSessionPath, "utf8"))
      return session.messages
    },
  })

  const schedule = (pair) => scheduler.scheduleMemoryWrite(pair.user.content, pair.assistant.content, {
    conversationId: selected.session.id,
    userMessageId: pair.user.id,
    assistantMessageId: pair.assistant.id,
    userAt: pair.user.at,
    assistantAt: pair.assistant.at,
    validateAgainstConversation: true,
  })

  selectedPairs.slice(0, 5).forEach(schedule)
  await queue

  const isolated = JSON.parse(fs.readFileSync(isolatedSessionPath, "utf8"))
  const deletedIds = new Set([selectedPairs[1].user.id, selectedPairs[1].assistant.id])
  isolated.messages = isolated.messages.filter((message) => !deletedIds.has(message.id))
  fs.writeFileSync(isolatedSessionPath, JSON.stringify(isolated), "utf8")

  schedule(selectedPairs[5])
  await queue
  assert.equal(judgeCalls.length, 0, "删除后只剩 5 个新增用户消息 ID，不应触发 MemoryJudge")

  schedule(selectedPairs[6])
  await queue
  assert.equal(judgeCalls.length, 1, "第 6 个仍存在的新增用户消息 ID 应触发一次 MemoryJudge")
  const input = judgeCalls[0].turns
  assert.ok(input.length <= 8, "MemoryJudge 输入不能超过最近 8 轮")
  assert.equal(input.some((turn) => deletedIds.has(turn.userMessageId) || deletedIds.has(turn.assistantMessageId)), false)
  for (const pair of selectedPairs.filter((_pair, index) => index !== 1)) {
    const turn = input.find((item) => item.userMessageId === pair.user.id)
    assert.ok(turn, "每个仍存在的新增轮次都应出现在提取窗口")
    assert.equal(turn.userAt, pair.user.at)
    assert.equal(turn.assistantAt, pair.assistant.at)
  }
  assert.equal(pendingTurns.length, 0, "成功判断后应清空本会话已消费的消息 ID")

  fs.copyFileSync(selected.sessionPath, isolatedSessionPath)
  let raceQueue = Promise.resolve()
  let raceRoundCount = 0
  let racePendingTurns = []
  let raceWrites = 0
  let resolveRaceJudge
  let notifyRaceJudgeStarted
  const raceJudgeStarted = new Promise((resolve) => { notifyRaceJudgeStarted = resolve })
  const raceJudgeResult = new Promise((resolve) => { resolveRaceJudge = resolve })
  const raceJudgeCalls = []
  const raceScheduler = new MemoryScheduler({
    ingestEntity: () => {},
    enqueueTask: (_label, task) => {
      const run = raceQueue.then(task)
      raceQueue = run.then(() => undefined, () => undefined)
      return run
    },
    judgeMemory: async (turns, conversationId) => {
      raceJudgeCalls.push({ turns, conversationId })
      if (raceJudgeCalls.length === 1) {
        notifyRaceJudgeStarted()
        return raceJudgeResult
      }
      return [{ layer: "L2", content: "隔离测试候选", confidence: 0.9, triggerText: "隔离测试" }]
    },
    writeMemory: async () => { raceWrites += 1 },
    getL1: async () => ({ recentGoals: "", recentPreferences: "", currentProject: "", generatedAt: 0, roundCount: raceRoundCount }),
    replaceL1Field: async (_field, value) => { raceRoundCount = value },
    runReflectionAndCompression: async () => {},
    runResolverQueueOnce: async () => {},
    getLastDecayAt: async () => Date.now(),
    runDecay: async () => {},
    loadPendingTurns: async () => racePendingTurns.map((turn) => ({ ...turn })),
    savePendingTurns: async (turns) => { racePendingTurns = turns.map((turn) => ({ ...turn })) },
    loadConversationMessages: async () => JSON.parse(fs.readFileSync(isolatedSessionPath, "utf8")).messages,
  })
  const scheduleRace = (pair) => raceScheduler.scheduleMemoryWrite(pair.user.content, pair.assistant.content, {
    conversationId: selected.session.id,
    userMessageId: pair.user.id,
    assistantMessageId: pair.assistant.id,
    userAt: pair.user.at,
    assistantAt: pair.assistant.at,
    validateAgainstConversation: true,
  })

  selectedPairs.slice(0, 6).forEach(scheduleRace)
  await raceJudgeStarted
  const raceIsolated = JSON.parse(fs.readFileSync(isolatedSessionPath, "utf8"))
  const raceDeletedIds = new Set([selectedPairs[1].user.id, selectedPairs[1].assistant.id])
  raceIsolated.messages = raceIsolated.messages.filter((message) => !raceDeletedIds.has(message.id))
  fs.writeFileSync(isolatedSessionPath, JSON.stringify(raceIsolated), "utf8")
  resolveRaceJudge([{ layer: "L2", content: "不应落盘的候选", confidence: 0.9, triggerText: "已删除轮次" }])
  await raceQueue

  assert.equal(raceWrites, 0, "Judge 运行期间删除来源轮次后，本批候选不应落盘")
  assert.deepEqual(racePendingTurns.map((turn) => turn.userMessageId), [
    selectedPairs[0].user.id,
    selectedPairs[2].user.id,
    selectedPairs[3].user.id,
    selectedPairs[4].user.id,
    selectedPairs[5].user.id,
  ])

  scheduleRace(selectedPairs[6])
  await raceQueue
  assert.equal(raceJudgeCalls.length, 2, "保留的 5 轮加下一轮后应重新提取")
  assert.equal(raceWrites, 1, "重新提取成功后才允许写入")
  assert.equal(raceJudgeCalls[1].turns.some((turn) => raceDeletedIds.has(turn.userMessageId)), false)

  fs.copyFileSync(selected.sessionPath, isolatedSessionPath)
  const rag = require(path.join(projectRoot, "dist/main/main/rag/index.js"))
  ;({ resetRAG } = rag)
  const { memoryManager } = require(path.join(projectRoot, "dist/main/main/memory/memory-manager.js"))
  const { memoryStore } = require(path.join(projectRoot, "dist/main/main/memory/memory-store.js"))
  const modelSettingsPath = path.join(isolatedUserDataDir, "model-settings.json")
  const modelSettings = fs.existsSync(modelSettingsPath)
    ? JSON.parse(fs.readFileSync(modelSettingsPath, "utf8"))
    : {}
  const embeddingModel = modelSettings.embeddingModel === "bgem3" ? "bgem3" : "minilm"
  await rag.initRAG("local", undefined, undefined, embeddingModel)
  assert.equal(rag.isUserMemoryVectorStoreReady(), true, `本地 embedding 模型 ${embeddingModel} 未就绪`)

  const l2CountBefore = (await memoryStore.getAllL2()).length
  const positiveJudgeCalls = []
  let positiveQueue = Promise.resolve()
  let positiveRoundCount = 0
  let positivePendingTurns = []
  const uniqueMarker = `readonly-e2e-${Date.now()}-${process.pid}`
  const positiveContent = `隔离链路验证：${selectedPairs[0].user.content.slice(0, 160)} [${uniqueMarker}]`
  const fallbackContent = `隔离创建时间兜底验证 [${uniqueMarker}]`
  const positiveScheduler = new MemoryScheduler({
    ingestEntity: () => {},
    enqueueTask: (_label, task) => {
      const run = positiveQueue.then(task)
      positiveQueue = run.then(() => undefined, () => undefined)
      return run
    },
    judgeMemory: async (turns, conversationId) => {
      positiveJudgeCalls.push({ turns, conversationId })
      return [
        {
          layer: "L2",
          content: positiveContent,
          confidence: 0.99,
          triggerText: selectedPairs[0].user.content.slice(0, 300),
          sourceQuote: selectedPairs[0].user.content.slice(0, 300),
          evidenceTurnRefs: ["T6"],
        },
        {
          layer: "L2",
          content: fallbackContent,
          confidence: 0.99,
          triggerText: `本批对话中不存在且无法唯一定位的片段-${uniqueMarker}`,
          evidenceTurnRefs: ["T9"],
        },
      ]
    },
    writeMemory: (candidates) => memoryManager.writeMemory(candidates),
    getL1: async () => ({ recentGoals: "", recentPreferences: "", currentProject: "", generatedAt: 0, roundCount: positiveRoundCount }),
    replaceL1Field: async (_field, value) => { positiveRoundCount = value },
    runReflectionAndCompression: async () => {},
    runResolverQueueOnce: async () => {},
    getLastDecayAt: async () => Date.now(),
    runDecay: async () => {},
    loadPendingTurns: async () => positivePendingTurns.map((turn) => ({ ...turn })),
    savePendingTurns: async (turns) => { positivePendingTurns = turns.map((turn) => ({ ...turn })) },
    loadConversationMessages: async () => JSON.parse(fs.readFileSync(isolatedSessionPath, "utf8")).messages,
  })
  const schedulePositive = (pair) => positiveScheduler.scheduleMemoryWrite(pair.user.content, pair.assistant.content, {
    conversationId: selected.session.id,
    userMessageId: pair.user.id,
    assistantMessageId: pair.assistant.id,
    userAt: pair.user.at,
    assistantAt: pair.assistant.at,
    validateAgainstConversation: true,
  })
  selectedPairs.slice(0, 6).forEach(schedulePositive)
  await positiveQueue
  rag.flushVectorStoreSync()

  assert.equal(positiveJudgeCalls.length, 1, "正常的 6 个完整轮次应触发一次 MemoryJudge")
  assert.ok(positiveJudgeCalls[0].turns.length <= 8, "正常路径的 Judge 输入不能超过最近 8 轮")
  for (const pair of selectedPairs.slice(0, 6)) {
    assert.ok(
      positiveJudgeCalls[0].turns.some((turn) => turn.userMessageId === pair.user.id),
      "触发提取的 6 个新增完整轮次必须全部出现在 Judge 输入中",
    )
  }
  assert.equal(positivePendingTurns.length, 0, "正常写入成功后应消费对应的待处理轮次")
  const isolatedMemory = JSON.parse(fs.readFileSync(path.join(isolatedUserDataDir, "memory.json"), "utf8"))
  assert.equal(isolatedMemory.l2.length, l2CountBefore + 2, "正式 MemoryManager 应在隔离 memory.json 新增两条 L2")
  const persistedL2 = isolatedMemory.l2.find((memory) => memory.content === positiveContent)
  assert.ok(persistedL2, "隔离 memory.json 中找不到新生成的 L2")
  assert.equal(persistedL2.syncStatus, "synced", "新 L2 必须完成向量同步")
  assert.ok(typeof persistedL2.ragId === "string" && persistedL2.ragId.length > 0, "新 L2 必须绑定 ragId")
  assert.equal(persistedL2.sourceAt, selectedPairs[0].user.at, "合法但指错的 T6 应被触发片段纠正为 T1 用户时间")
  assert.equal(persistedL2.sourceEndAt, selectedPairs[0].user.at, "单轮证据的来源时间范围应收敛为同一时刻")
  assert.equal(persistedL2.sourceMessageIds, undefined, "来源时间链不应持久化消息 ID")
  const fallbackL2 = isolatedMemory.l2.find((memory) => memory.content === fallbackContent)
  assert.ok(fallbackL2, "隔离 memory.json 中找不到创建时间兜底 L2")
  assert.equal(fallbackL2.sourceAt, fallbackL2.createdAt, "无法唯一定位时 sourceAt 应使用记忆创建时间")
  assert.equal(fallbackL2.sourceEndAt, fallbackL2.createdAt, "无法唯一定位时 sourceEndAt 应使用记忆创建时间")
  assert.equal(fallbackL2.sourceMessageIds, undefined, "创建时间兜底不应持久化消息 ID")
  const isolatedVectors = JSON.parse(fs.readFileSync(path.join(isolatedUserDataDir, "rag-data", "memory-store.json"), "utf8"))
  assert.ok(
    isolatedVectors.some((entry) => entry.id === persistedL2.ragId && entry.metadata?.l2Id === persistedL2.id),
    "隔离向量库中找不到与新 L2 对应的正式向量",
  )
  assert.deepEqual(Object.fromEntries(sourcePaths.map((filePath) => [filePath, digest(filePath)])), before)
  console.log(`[RealtimeMemoryEval] 隔离验证通过；哈希保护文件 ${sourcePaths.length} 个，Judge 输入上限实测 ${input.length} 轮，错误 Tn 已按触发片段纠正，无法唯一定位已回退创建时间，正常 6 轮已写入 L2 并同步 ${embeddingModel} 向量`)
} finally {
  if (resetRAG) resetRAG()
  if (setAppPathProvider) setAppPathProvider(null)
  assert.deepEqual(Object.fromEntries(sourcePaths.map((filePath) => [filePath, digest(filePath)])), before)
  if (path.dirname(isolatedDir) === os.tmpdir()) fs.rmSync(isolatedDir, { recursive: true, force: true })
}
