import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const projectRoot = process.cwd()
const liveLlmMode = process.argv.includes("--live-llm")
const realUserDataDir = process.env.CYRENE_REAL_USER_DATA_DIR
  || path.join(process.env.APPDATA || "", "live2d-cyrene")
const protectedRelativePaths = [
  "memory.json",
  path.join("rag-data", "memory-store.json"),
  "model-settings.json",
  "entity-graph.json",
]
const sourcePaths = protectedRelativePaths
  .map((relativePath) => path.join(realUserDataDir, relativePath))
  .filter((filePath) => fs.existsSync(filePath))

function digest(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")
}

const before = Object.fromEntries(sourcePaths.map((filePath) => [filePath, digest(filePath)]))
const realMemoryPath = path.join(realUserDataDir, "memory.json")
const realStore = JSON.parse(fs.readFileSync(realMemoryPath, "utf8"))
const badSummary = realStore.l2.find((memory) => (
  memory.isSummary === true
  && memory.content.includes("大boss")
  && memory.content.includes("明天白天")
  && Array.isArray(memory.subEntryIds)
  && memory.subEntryIds.length >= 3
))
assert.ok(badSummary, "真实记忆中找不到截图对应的剧本杀错误压缩总结")
const sourceIds = new Set(badSummary.subEntryIds)
const sourceMemories = realStore.l2.filter((memory) => sourceIds.has(memory.id))
const plan = sourceMemories.find((memory) => memory.facets?.primaryKind === "commitment")
const outcomes = sourceMemories.filter((memory) => memory.facets?.primaryKind === "experience")
assert.ok(plan, "真实压缩子条目中找不到剧本杀 commitment")
assert.equal(outcomes.length, 2, "真实压缩子条目应包含两条剧本杀 experience")

const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-memory-timeline-"))
const isolatedUserDataDir = path.join(isolatedRoot, "userData")
fs.mkdirSync(isolatedUserDataDir, { recursive: true })
for (const relativePath of protectedRelativePaths) {
  const sourcePath = path.join(realUserDataDir, relativePath)
  if (!fs.existsSync(sourcePath)) continue
  const targetPath = path.join(isolatedUserDataDir, relativePath)
  fs.mkdirSync(path.dirname(targetPath), { recursive: true })
  fs.copyFileSync(sourcePath, targetPath)
}

const isolatedMemoryPath = path.join(isolatedUserDataDir, "memory.json")
const isolatedStore = JSON.parse(fs.readFileSync(isolatedMemoryPath, "utf8"))
isolatedStore.l2 = [{
  ...plan,
  status: "active",
  syncStatus: "pending_sync",
  sourceAt: plan.createdAt,
  sourceEndAt: plan.createdAt,
  ragId: undefined,
  conflictWith: undefined,
}]
isolatedStore.evidence = (isolatedStore.evidence || []).filter((evidence) => evidence.memoryId === plan.id)
isolatedStore.conflictLogs = []
isolatedStore.reflectionLogs = []
isolatedStore.pendingTurns = []
isolatedStore.l2DmaeStates = {}
fs.writeFileSync(isolatedMemoryPath, JSON.stringify(isolatedStore, null, 2), "utf8")

let resetRAG
let setAppPathProvider
let flushTokenUsage
let compressionSourceIds = new Set()
try {
  ;({ setAppPathProvider } = require(path.join(projectRoot, "dist/main/main/runtime/runtime-paths.js")))
  setAppPathProvider({
    getPath: (name) => name === "userData" ? isolatedUserDataDir : isolatedRoot,
    getAppPath: () => projectRoot,
  })
  const { getUserDataDir } = require(path.join(projectRoot, "dist/main/main/runtime/runtime-paths.js"))
  assert.equal(path.resolve(getUserDataDir()), path.resolve(isolatedUserDataDir), "隔离 userData 路由未生效，拒绝运行")
  assert.notEqual(path.resolve(getUserDataDir()), path.resolve(realUserDataDir), "隔离 userData 不得指向真实目录")
  const rag = require(path.join(projectRoot, "dist/main/main/rag/index.js"))
  ;({ resetRAG } = rag)
  const { memoryStore } = require(path.join(projectRoot, "dist/main/main/memory/memory-store.js"))
  const { memoryManager } = require(path.join(projectRoot, "dist/main/main/memory/memory-manager.js"))
  const { callLLM, compressMemories, parseCompressionDecision } = require(path.join(projectRoot, "dist/main/main/memory/memory-compressor.js"))
  ;({ flush: flushTokenUsage } = require(path.join(projectRoot, "dist/main/main/token-usage-store.js")))
  const modelSettings = JSON.parse(fs.readFileSync(path.join(isolatedUserDataDir, "model-settings.json"), "utf8"))
  const embeddingModel = modelSettings.embeddingModel === "bgem3" ? "bgem3" : "minilm"
  await rag.initRAG("local", undefined, undefined, embeddingModel)
  assert.equal(rag.isUserMemoryVectorStoreReady(), true, `本地 embedding 模型 ${embeddingModel} 未就绪`)

  const planRagId = await rag.addL2MemoryVector(plan.content, plan.id, {
    triggerText: plan.triggerText,
    facets: plan.facets,
  }, { createdAt: plan.createdAt })
  await memoryStore.markL2SyncStatus(plan.id, "synced", planRagId)

  for (const outcome of outcomes.sort((a, b) => a.createdAt - b.createdAt)) {
    await memoryManager.writeMemory([{
      layer: "L2",
      content: outcome.content,
      confidence: 0.95,
      triggerText: outcome.triggerText,
      sourceQuote: outcome.sourceQuote,
      sourceAt: outcome.createdAt,
      sourceEndAt: outcome.createdAt,
      facets: outcome.facets,
    }])
  }

  const transitionLogs = (await memoryStore.getConflictLogs()).filter((log) => log.candidateType === "state_transition")
  assert.ok(transitionLogs.some((log) => log.targetL2Id === plan.id && log.resolverStatus === "queued"), "真实剧本杀计划与结果未进入状态推进 Resolver 队列")
  compressionSourceIds = new Set((await memoryStore.getAllL2()).map((memory) => memory.id))
  assert.equal(compressionSourceIds.size, 3, "压缩前应有三条真实内容来源记忆")

  const compressionPrompts = []
  let liveDecision = null
  const compressorLlm = liveLlmMode ? async (messages, maxTokens) => {
    compressionPrompts.push(messages[1].content)
    const raw = await callLLM(messages, maxTokens)
    liveDecision = parseCompressionDecision(raw)
    return raw
  } : async (messages) => {
    compressionPrompts.push(messages[1].content)
    return JSON.stringify({
      shouldCompress: true,
      summary: "用户已参加与同学约好的剧本杀并拿到大boss隐藏身份，全程未被发现，事后分享了这次体验。",
      reason: "按来源时间可判断后续经历是早先剧本杀约定的结果，不应继续保留为未来计划。",
    })
  }
  const compressed = await compressMemories(compressorLlm)
  assert.equal(compressionPrompts.length, 1)
  assert.ok(compressionPrompts[0].includes(new Date(plan.createdAt).toISOString()), "压缩输入缺少旧计划来源时间")
  assert.ok(compressionPrompts[0].includes("类型：commitment"))
  assert.ok(compressionPrompts[0].includes("类型：experience"))

  rag.flushVectorStoreSync()
  const finalStore = JSON.parse(fs.readFileSync(isolatedMemoryPath, "utf8"))
  const summary = finalStore.l2.find((memory) => memory.isSummary === true && memory.content.includes("大boss"))
  if (liveLlmMode) {
    assert.ok(liveDecision, "真实 compressor LLM 未返回合法的结构化判定")
    assert.equal(compressed, liveDecision.shouldCompress ? 3 : 0, "真实 compressor 的判定与落盘行为不一致")
  } else {
    assert.equal(compressed, 3, "真实三条剧本杀记忆应完成一次时间感知压缩")
  }
  if (compressed === 3) {
    assert.ok(summary, "隔离 memory.json 中找不到时间感知压缩总结")
    assert.equal(/另(?:已)?约好明天|明天白天与同学去玩|届时将分享体验/u.test(summary.content), false, "压缩总结错误保留了已经兑现的未来计划")
    assert.equal(summary.sourceAt, Math.min(plan.createdAt, ...outcomes.map((memory) => memory.createdAt)))
    assert.equal(summary.sourceEndAt, Math.max(plan.createdAt, ...outcomes.map((memory) => memory.createdAt)))
    assert.equal(summary.syncStatus, "synced")
    assert.equal(summary.sourceMessageIds, undefined, "隔离结果不应引入持久化消息 ID")
    assert.equal(finalStore.l2.filter((memory) => compressionSourceIds.has(memory.id) && memory.status === "archived").length, 3, "压缩成功后必须归档三条来源记忆")
  } else {
    assert.equal(summary, undefined, "compressor 拒绝压缩时不应创建总结")
    assert.equal(finalStore.l2.filter((memory) => compressionSourceIds.has(memory.id) && memory.status === "active").length, 3, "compressor 拒绝压缩时必须保留全部原记忆")
  }
  assertSourceFilesUnchanged()
  console.log(`[MemoryTimelineEval] ${liveLlmMode ? "真实 compressor LLM" : "确定性 compressor"} 隔离验证通过；真实剧本杀 1 条 commitment + 2 条 experience 已生成状态推进候选；压缩结果 ${compressed === 3 ? "完成态总结" : "保守拒绝"}；模型 ${embeddingModel}；源文件 ${sourcePaths.length} 个哈希一致`)
} finally {
  if (resetRAG) resetRAG()
  if (flushTokenUsage) flushTokenUsage()
  if (setAppPathProvider) setAppPathProvider(null)
  assertSourceFilesUnchanged()
  if (path.dirname(isolatedRoot) === os.tmpdir()) fs.rmSync(isolatedRoot, { recursive: true, force: true })
}

function assertSourceFilesUnchanged() {
  const after = Object.fromEntries(sourcePaths.map((filePath) => [filePath, digest(filePath)]))
  if (JSON.stringify(after) === JSON.stringify(before)) return

  const realNow = JSON.parse(fs.readFileSync(realMemoryPath, "utf8"))
  const leakedIds = (realNow.l2 || [])
    .filter((memory) => compressionSourceIds.has(memory.id) && !sourceIds.has(memory.id))
    .map((memory) => memory.id)
  assert.equal(leakedIds.length, 0, `隔离测试生成的记忆 ID 泄漏到真实 memory.json：${leakedIds.join(", ")}`)
  assert.deepEqual(after, before, "真实数据在测试期间被外部进程修改；未发现隔离测试 ID 泄漏。请完全退出 Cyrene 后重跑，以完成严格哈希校验")
}
