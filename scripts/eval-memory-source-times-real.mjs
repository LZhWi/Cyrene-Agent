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
const memoryPath = path.join(realUserDataDir, "memory.json")
const indexPath = path.join(realUserDataDir, "cyrene-chats", "index.json")
const vectorPath = path.join(realUserDataDir, "rag-data", "memory-store.json")
const reportsDir = path.join(realUserDataDir, "memory-source-time-migrations")

const digest = (filePath) => createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")
const reportPath = fs.readdirSync(reportsDir)
  .filter((name) => name.startsWith("report.") && name.endsWith(".json"))
  .map((name) => path.join(reportsDir, name))
  .filter((filePath) => JSON.parse(fs.readFileSync(filePath, "utf8")).applied === true)
  .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0]
assert.ok(reportPath, "找不到已应用的来源时间迁移报告")

const report = JSON.parse(fs.readFileSync(reportPath, "utf8"))
const backupPath = report.backupPath
const index = JSON.parse(fs.readFileSync(indexPath, "utf8"))
const sessionPaths = index
  .map((meta) => path.join(realUserDataDir, "cyrene-chats", "sessions", `${meta.id}.json`))
  .filter((filePath) => fs.existsSync(filePath))
const protectedPaths = [
  memoryPath,
  path.join(realUserDataDir, "memory.last-good.json"),
  vectorPath,
  path.join(realUserDataDir, "model-settings.json"),
  path.join(realUserDataDir, "entity-graph.json"),
  indexPath,
  reportPath,
  backupPath,
  ...sessionPaths,
].filter((filePath) => fs.existsSync(filePath))
const before = Object.fromEntries(protectedPaths.map((filePath) => [filePath, digest(filePath)]))

const store = JSON.parse(fs.readFileSync(memoryPath, "utf8"))
const backup = JSON.parse(fs.readFileSync(backupPath, "utf8"))
assert.ok(store.l2.length >= report.total, "正式记忆不得少于已迁移的旧版条目")
assert.equal(backup.l2.length, 86)
assert.equal(report.total, 86)
assert.equal(report.resolved, 86)
assert.equal(report.unresolved, 0)
assert.equal(report.applied, true)
assert.equal(backup.l2.filter((memory) => Number.isFinite(memory.sourceAt)).length, 0, "旧版备份不应被回填来源时间")
assert.equal(store.l2.filter((memory) => Number.isFinite(memory.sourceAt)).length, store.l2.length, "正式记忆应全部具备来源时间")
assert.equal(store.l2.some((memory) => Array.isArray(memory.sourceMessageIds) && memory.sourceMessageIds.length > 0), false, "迁移不得引入持久化消息ID")

const sessions = sessionPaths.map((filePath) => JSON.parse(fs.readFileSync(filePath, "utf8")))
const userMessages = sessions.flatMap((session) => (session.messages || []).filter((message) => message.role === "user"))
const messagesByTime = new Map(userMessages.map((message) => [message.at, message]))
const memoriesById = new Map(store.l2.map((memory) => [memory.id, memory]))
const recordsById = new Map(report.records.map((record) => [record.id, record]))

for (const record of report.records) {
  assert.equal(record.status, "resolved", `${record.id} 未通过迁移报告验证`)
  const memory = memoriesById.get(record.id)
  assert.ok(memory, `正式记忆缺少 ${record.id}`)
  assert.equal(memory.sourceAt, record.sourceAt)
  assert.equal(memory.sourceEndAt, record.sourceEndAt)
  assert.equal(memory.validFrom, record.sourceAt)
  if (record.method === "derived_summary") {
    const children = (memory.subEntryIds || []).map((id) => recordsById.get(id))
    assert.equal(children.length, memory.subEntryIds.length)
    assert.equal(memory.sourceAt, Math.min(...children.map((child) => child.sourceAt)))
    assert.equal(memory.sourceEndAt, Math.max(...children.map((child) => child.sourceEndAt)))
    continue
  }
  assert.ok(record.evidence.length > 0, `${record.id} 缺少真实消息证据`)
  for (const evidence of record.evidence) {
    const message = messagesByTime.get(evidence.at)
    assert.ok(message, `${record.id} 的证据时间未对应真实用户消息`)
    assert.ok(message.content.normalize("NFC").startsWith(evidence.text.normalize("NFC")), `${record.id} 的证据文本与真实消息不一致`)
  }
  assert.equal(memory.sourceAt, Math.min(...record.evidence.map((evidence) => evidence.at)))
  assert.equal(memory.sourceEndAt, Math.max(...record.evidence.map((evidence) => evidence.at)))
}

const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-memory-source-time-eval-"))
const isolatedUserData = path.join(isolatedRoot, "userData")
fs.mkdirSync(isolatedUserData, { recursive: true })
for (const relativePath of [
  "memory.json",
  "memory.last-good.json",
  path.join("rag-data", "memory-store.json"),
  "model-settings.json",
  "entity-graph.json",
]) {
  const source = path.join(realUserDataDir, relativePath)
  if (!fs.existsSync(source)) continue
  const target = path.join(isolatedUserData, relativePath)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(source, target)
}

let setAppPathProvider
let resetRAG
try {
  ;({ setAppPathProvider } = require(path.join(projectRoot, "dist/main/main/runtime/runtime-paths.js")))
  setAppPathProvider({
    getPath: (name) => name === "userData" ? isolatedUserData : isolatedRoot,
    getAppPath: () => projectRoot,
  })
  const rag = require(path.join(projectRoot, "dist/main/main/rag/index.js"))
  resetRAG = rag.resetRAG
  const modelSettings = JSON.parse(fs.readFileSync(path.join(isolatedUserData, "model-settings.json"), "utf8"))
  const embeddingModel = modelSettings.embeddingModel === "bgem3" ? "bgem3" : "minilm"
  await rag.initRAG("local", undefined, undefined, embeddingModel)
  const { buildMemoryInjection } = require(path.join(projectRoot, "dist/main/main/orchestrator/index.js"))
  const target = store.l2.find((memory) => (
    memory.status === "active"
    && memory.ragId
    && new Date(memory.sourceAt).getHours() !== new Date(memory.createdAt).getHours()
  ))
  assert.ok(target, "找不到来源小时与写入小时不同的 active L2 用于实链验证")
  const context = await buildMemoryInjection(target.content, {
    trackState: false,
    retrievalPlan: {
      scope: "normal",
      semanticResults: 5,
      kindResults: 0,
      maxResults: 5,
      candidateDepth: 20,
      characterBudget: 4000,
      queryKinds: [],
    },
  })
  const sourceHour = `${new Date(target.sourceAt).getFullYear()}/${new Date(target.sourceAt).getMonth() + 1}/${new Date(target.sourceAt).getDate()} ${String(new Date(target.sourceAt).getHours()).padStart(2, "0")}时`
  assert.ok(context.includes(target.content), "实际记忆注入未召回验证目标")
  assert.ok(context.includes(`记录于 ${sourceHour}`), "实际回复模型注入未使用来源小时")
  assert.ok(context.includes("相对时间，一律以同条「记录于」时间为参照"), "实际回复模型注入缺少相对时间锚定规则")
  assert.deepEqual(Object.fromEntries(protectedPaths.map((filePath) => [filePath, digest(filePath)])), before)
  console.log(`[MemorySourceTimeEval] 真实数据只读隔离验证通过；迁移旧记忆 ${report.total}/${report.total} 证据与消息时间一致；正式记忆 ${store.l2.length}/${store.l2.length} 具备来源时间；旧版备份保留；实际RAG注入使用来源小时 ${sourceHour} 且包含相对时间锚定规则；源文件 ${protectedPaths.length} 个哈希一致`)
} finally {
  if (resetRAG) resetRAG()
  if (setAppPathProvider) setAppPathProvider(null)
  assert.deepEqual(Object.fromEntries(protectedPaths.map((filePath) => [filePath, digest(filePath)])), before)
  if (path.dirname(isolatedRoot) === os.tmpdir()) fs.rmSync(isolatedRoot, { recursive: true, force: true })
}
