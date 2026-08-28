import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const projectRoot = process.cwd()
const applyMode = process.argv.includes("--apply")
const noLlmMode = process.argv.includes("--no-llm")
const realUserDataDir = process.env.CYRENE_REAL_USER_DATA_DIR
  || path.join(process.env.APPDATA || "", "live2d-cyrene")
const realMemoryPath = path.join(realUserDataDir, "memory.json")
const realLastGoodPath = path.join(realUserDataDir, "memory.last-good.json")
const chatRoot = path.join(realUserDataDir, "cyrene-chats")
const chatIndexPath = path.join(chatRoot, "index.json")
const vectorPath = path.join(realUserDataDir, "rag-data", "memory-store.json")
const modelSettingsPath = path.join(realUserDataDir, "model-settings.json")

assert.ok(fs.existsSync(realMemoryPath), `找不到真实记忆文件：${realMemoryPath}`)
assert.ok(fs.existsSync(chatIndexPath), `找不到聊天索引：${chatIndexPath}`)

const digest = (filePath) => createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")
const protectedPaths = [realMemoryPath, realLastGoodPath, chatIndexPath, vectorPath, modelSettingsPath]
  .filter((filePath) => fs.existsSync(filePath))
const index = JSON.parse(fs.readFileSync(chatIndexPath, "utf8"))
const sessionPaths = index
  .map((meta) => path.join(chatRoot, "sessions", `${meta.id}.json`))
  .filter((filePath) => fs.existsSync(filePath))
protectedPaths.push(...sessionPaths)
const beforeHashes = Object.fromEntries(protectedPaths.map((filePath) => [filePath, digest(filePath)]))

const originalRaw = fs.readFileSync(realMemoryPath, "utf8")
const originalHash = digest(realMemoryPath)
const originalStore = JSON.parse(originalRaw)
assert.ok(Array.isArray(originalStore.l2), "memory.json 缺少 L2 数组")
assert.equal(originalStore.l2.length, 86, `预期迁移旧版 86 条 L2，实际为 ${originalStore.l2.length}；拒绝按旧快照假设继续`)

const migrationRoot = path.join(realUserDataDir, "memory-source-time-migrations")
const backupRoot = path.join(realUserDataDir, "memory-source-time-backups")
fs.mkdirSync(migrationRoot, { recursive: true })
fs.mkdirSync(backupRoot, { recursive: true })
const tag = originalHash.slice(0, 12)
const backupPath = path.join(backupRoot, `memory.pre-source-time.${tag}.json`)
const candidatePath = path.join(migrationRoot, `memory.source-time-candidate.${tag}.json`)
const reportPath = path.join(migrationRoot, `report.${tag}.json`)
if (!fs.existsSync(backupPath)) fs.copyFileSync(realMemoryPath, backupPath)
assert.equal(digest(backupPath), originalHash, "旧版86条永久备份与源 memory.json 哈希不一致")

const sessions = sessionPaths.map((filePath) => JSON.parse(fs.readFileSync(filePath, "utf8")))
const userMessages = sessions.flatMap((session) => (session.messages || []).flatMap((message, indexInSession) => {
  if (message.role !== "user" || typeof message.content !== "string" || !Number.isFinite(message.at)) return []
  const previous = session.messages[indexInSession - 1]
  const next = session.messages[indexInSession + 1]
  return [{
    conversationId: session.id,
    at: message.at,
    content: message.content,
    previous: previous ? `${previous.role}：${previous.content || ""}` : "",
    next: next ? `${next.role}：${next.content || ""}` : "",
  }]
}))
assert.ok(userMessages.length > 0, "真实聊天中没有可用于验证的用户消息")

const normalize = (text) => String(text || "").normalize("NFC").replace(/\r\n?/gu, "\n").trim()
const normalizeLoose = (text) => normalize(text).replace(/[\s\p{P}\p{S}]/gu, "")
const finiteTime = (value) => typeof value === "number" && Number.isFinite(value)
const clip = (text, length = 700) => normalize(text).slice(0, length)
const localTime = (value) => new Date(value).toLocaleString("zh-CN", { hour12: false })

const records = new Map()
let unresolved = []
for (const memory of originalStore.l2.filter((item) => item.isSummary !== true)) {
  const trigger = normalize(memory.triggerText)
  const exact = trigger.length > 0
    ? userMessages.filter((message) => normalize(message.content).includes(trigger))
    : []
  if (exact.length === 1) {
    records.set(memory.id, resolvedRecord(memory, "exact", exact, 1, "触发片段在真实用户消息中唯一逐字命中"))
    continue
  }
  const looseTrigger = normalizeLoose(trigger)
  const loose = looseTrigger.length >= 4
    ? userMessages.filter((message) => normalizeLoose(message.content).includes(looseTrigger))
    : []
  if (loose.length === 1) {
    records.set(memory.id, resolvedRecord(memory, "normalized_exact", loose, 1, "去除标点和空白后唯一命中真实用户消息"))
    continue
  }
  unresolved.push(memory)
}

if (fs.existsSync(reportPath)) {
  const previousReport = JSON.parse(fs.readFileSync(reportPath, "utf8"))
  if (previousReport.originalMemorySha256 === originalHash && Array.isArray(previousReport.records)) {
    const previousById = new Map(previousReport.records.map((record) => [record.id, record]))
    unresolved = unresolved.filter((memory) => {
      const previous = previousById.get(memory.id)
      if (previous?.status !== "resolved" || previous.method !== "llm_verified" || !Array.isArray(previous.evidence)) return true
      const evidenceStillExists = previous.evidence.every((evidence) => userMessages.some((message) => (
        message.at === evidence.at && normalize(message.content).startsWith(normalize(evidence.text))
      )))
      if (!evidenceStillExists) return true
      records.set(memory.id, previous)
      return false
    })
  }
}

let setAppPathProvider
let resetEmbeddingProvider
let flushTokenUsage
let isolatedRoot
try {
  if (unresolved.length > 0 && !noLlmMode) {
    isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-memory-source-time-"))
    const isolatedUserData = path.join(isolatedRoot, "userData")
    fs.mkdirSync(isolatedUserData, { recursive: true })
    if (fs.existsSync(modelSettingsPath)) fs.copyFileSync(modelSettingsPath, path.join(isolatedUserData, "model-settings.json"))

    ;({ setAppPathProvider } = require(path.join(projectRoot, "dist/main/main/runtime/runtime-paths.js")))
    setAppPathProvider({
      getPath: (name) => name === "userData" ? isolatedUserData : isolatedRoot,
      getAppPath: () => projectRoot,
    })
    const embeddingModule = require(path.join(projectRoot, "dist/main/main/rag/embedding.js"))
    resetEmbeddingProvider = embeddingModule.resetEmbeddingProvider
    const modelSettings = fs.existsSync(modelSettingsPath)
      ? JSON.parse(fs.readFileSync(modelSettingsPath, "utf8"))
      : {}
    const embeddingModel = modelSettings.embeddingModel === "bgem3" ? "bgem3" : "minilm"
    const provider = embeddingModule.getEmbeddingProvider("local", undefined, undefined, embeddingModel)
    assert.ok(provider, `本地 embedding 模型 ${embeddingModel} 不可用`)
    const { callLLM } = require(path.join(projectRoot, "dist/main/main/memory/memory-compressor.js"))
    ;({ flush: flushTokenUsage } = require(path.join(projectRoot, "dist/main/main/token-usage-store.js")))

    const messageVectors = await provider.embedBatch(userMessages.map((message) => clip(message.content, 1500)))
    for (const memory of unresolved) {
      const queryVector = await provider.embed(`${memory.content}\n原始触发片段：${memory.triggerText}`)
      const semantic = userMessages
        .map((message, indexInMessages) => ({ message, score: cosine(queryVector, messageVectors[indexInMessages]) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 8)
      const nearest = userMessages
        .map((message) => ({ message, score: 0, distance: Math.abs(message.at - memory.createdAt) }))
        .sort((a, b) => a.distance - b.distance)
        .slice(0, 4)
      const candidates = []
      const seen = new Set()
      for (const entry of [...semantic, ...nearest]) {
        const key = `${entry.message.conversationId}:${entry.message.at}`
        if (seen.has(key)) continue
        seen.add(key)
        candidates.push({ ...entry, ref: `C${candidates.length + 1}` })
      }

      let located = await locateWithLlm(callLLM, memory, candidates)
      if (!located) {
        const widerTimeline = userMessages
          .map((message) => ({ message, score: 0, distance: Math.abs(message.at - memory.createdAt) }))
          .sort((a, b) => a.distance - b.distance)
          .slice(0, 10)
          .sort((a, b) => a.message.at - b.message.at)
          .map((entry, index) => ({
            ...entry,
            message: { ...entry.message, previous: "", next: "" },
            ref: `W${index + 1}`,
          }))
        located = await locateWithLlm(callLLM, memory, widerTimeline, true)
        if (located) {
          candidates.splice(0, candidates.length, ...widerTimeline)
        }
      }
      if (!located) {
        records.set(memory.id, unresolvedRecord(memory, "LLM未能从现存真实消息中确认来源"))
        continue
      }
      const selected = located.refs.map((ref) => candidates.find((candidate) => candidate.ref === ref)).filter(Boolean)
      const verified = await verifyWithLlm(callLLM, memory, selected)
      if (!verified) {
        records.set(memory.id, unresolvedRecord(memory, "独立验证未确认候选消息完整支持该记忆"))
        continue
      }
      records.set(memory.id, resolvedRecord(
        memory,
        "llm_verified",
        selected.map((entry) => entry.message),
        Math.min(located.confidence, verified.confidence),
        `${located.reason}；复核：${verified.reason}`,
      ))
    }
  } else {
    for (const memory of unresolved) records.set(memory.id, unresolvedRecord(memory, "未启用LLM定位"))
  }

  const byId = new Map(originalStore.l2.map((memory) => [memory.id, memory]))
  const resolveSummary = (memory, stack = new Set()) => {
    if (records.has(memory.id)) return records.get(memory.id)
    if (stack.has(memory.id)) return unresolvedRecord(memory, "压缩父子关系存在循环")
    stack.add(memory.id)
    const children = (memory.subEntryIds || []).map((id) => byId.get(id)).filter(Boolean)
    if (children.length !== (memory.subEntryIds || []).length || children.length === 0) {
      const record = unresolvedRecord(memory, "压缩总结缺少完整 subEntryIds 来源")
      records.set(memory.id, record)
      return record
    }
    const childRecords = children.map((child) => child.isSummary === true ? resolveSummary(child, new Set(stack)) : records.get(child.id))
    if (childRecords.some((record) => !record || record.status !== "resolved")) {
      const record = unresolvedRecord(memory, "至少一条压缩子记忆的来源时间无法验证")
      records.set(memory.id, record)
      return record
    }
    const times = childRecords.flatMap((record) => [record.sourceAt, record.sourceEndAt]).filter(finiteTime)
    const record = {
      id: memory.id,
      status: "resolved",
      method: "derived_summary",
      sourceAt: Math.min(...times),
      sourceEndAt: Math.max(...times),
      confidence: Math.min(...childRecords.map((record) => record.confidence)),
      reason: "由全部已验证 subEntryIds 的来源时间范围推导",
      evidence: childRecords.map((record) => ({ id: record.id, sourceAt: record.sourceAt, sourceEndAt: record.sourceEndAt })),
    }
    records.set(memory.id, record)
    return record
  }
  for (const memory of originalStore.l2.filter((item) => item.isSummary === true)) resolveSummary(memory)

  const candidateStore = structuredClone(originalStore)
  for (const memory of candidateStore.l2) {
    const record = records.get(memory.id)
    if (record?.status !== "resolved") continue
    memory.sourceAt = record.sourceAt
    memory.sourceEndAt = record.sourceEndAt
    memory.validFrom = record.sourceAt
  }
  assertOnlySourceTimesChanged(originalStore, candidateStore)

  const reportRecords = originalStore.l2.map((memory) => records.get(memory.id) ?? unresolvedRecord(memory, "未生成迁移记录"))
  const resolvedCount = reportRecords.filter((record) => record.status === "resolved").length
  const report = {
    schemaVersion: 1,
    generatedAt: Date.now(),
    originalMemorySha256: originalHash,
    backupPath,
    total: originalStore.l2.length,
    resolved: resolvedCount,
    unresolved: originalStore.l2.length - resolvedCount,
    applied: false,
    records: reportRecords,
  }
  fs.writeFileSync(candidatePath, JSON.stringify(candidateStore, null, 2), "utf8")
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8")

  assertProtectedFilesUnchanged(beforeHashes)
  if (applyMode) {
    assert.equal(resolvedCount, originalStore.l2.length, `仍有 ${originalStore.l2.length - resolvedCount} 条无法验证，拒绝覆盖正式记忆`)
    assert.equal(digest(realMemoryPath), originalHash, "正式 memory.json 在迁移期间发生变化，拒绝覆盖")
    writeJsonAtomically(realLastGoodPath, candidateStore)
    writeJsonAtomically(realMemoryPath, candidateStore)
    assert.equal(digest(realMemoryPath), digest(candidatePath), "正式 memory.json 与已验证候选版本不一致")
    assert.equal(digest(backupPath), originalHash, "旧版永久备份在迁移后发生变化")
    report.applied = true
    report.appliedAt = Date.now()
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8")
  }

  console.log(`[MemorySourceTimeMigration] ${applyMode ? "正式迁移完成" : "候选生成完成"}；已验证 ${resolvedCount}/${originalStore.l2.length}；未验证 ${originalStore.l2.length - resolvedCount}；旧版备份 ${backupPath}；报告 ${reportPath}`)
  if (resolvedCount !== originalStore.l2.length) process.exitCode = 2
} finally {
  if (flushTokenUsage) flushTokenUsage()
  if (resetEmbeddingProvider) resetEmbeddingProvider()
  if (setAppPathProvider) setAppPathProvider(null)
  if (isolatedRoot && path.dirname(isolatedRoot) === os.tmpdir()) fs.rmSync(isolatedRoot, { recursive: true, force: true })
}

function resolvedRecord(memory, method, messages, confidence, reason) {
  const times = messages.map((message) => message.at).filter(finiteTime)
  return {
    id: memory.id,
    status: "resolved",
    method,
    sourceAt: Math.min(...times),
    sourceEndAt: Math.max(...times),
    confidence,
    reason,
    evidence: messages.map((message) => ({ at: message.at, localTime: localTime(message.at), text: clip(message.content) })),
  }
}

function unresolvedRecord(memory, reason) {
  return { id: memory.id, status: "unresolved", method: "none", confidence: 0, reason, evidence: [] }
}

function cosine(a, b) {
  let dot = 0
  let aa = 0
  let bb = 0
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    dot += a[index] * b[index]
    aa += a[index] * a[index]
    bb += b[index] * b[index]
  }
  return aa > 0 && bb > 0 ? dot / Math.sqrt(aa * bb) : 0
}

function parseJsonObject(raw) {
  const cleaned = String(raw || "").replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "").trim()
  const start = cleaned.indexOf("{")
  const end = cleaned.lastIndexOf("}")
  if (start < 0 || end <= start) return null
  try { return JSON.parse(cleaned.slice(start, end + 1)) } catch { return null }
}

async function locateWithLlm(callLLM, memory, candidates, chronologicalWindow = false) {
  const candidateText = candidates.map((candidate) => [
    `${candidate.ref}：用户时间 ${new Date(candidate.message.at).toISOString()}（本地 ${localTime(candidate.message.at)}）`,
    `用户消息：${clip(candidate.message.content)}`,
    !chronologicalWindow && candidate.message.previous ? `前一条：${clip(candidate.message.previous, 400)}` : "",
    !chronologicalWindow && candidate.message.next ? `后一条：${clip(candidate.message.next, 400)}` : "",
  ].filter(Boolean).join("\n")).join("\n\n")
  const raw = await callLLM([
    { role: "system", content: "你是保守的记忆来源定位器。可以组合多个连续用户轮次来支持一条聚合记忆，但 sourceRefs 只能指向直接提供事实的真实用户消息；同主题、时间接近或AI回复中的推测都不算证据。若现存消息不足以证明完整记忆，必须返回空 sourceRefs。只输出JSON。" },
    { role: "user", content: `待定位记忆：${memory.content}\n旧触发片段：${memory.triggerText}\n旧写入时间：${localTime(memory.createdAt)}\n候选组织方式：${chronologicalWindow ? "围绕旧写入时间的连续用户轮次，按时间排序" : "语义候选与时间邻近候选"}\n\n候选：\n${candidateText}\n\n输出：{"sourceRefs":["${chronologicalWindow ? "W1" : "C1"}"],"confidence":0.95,"reason":"为什么这些用户消息组合后直接支持完整记忆"}` },
  ], 4096)
  const parsed = parseJsonObject(raw)
  if (!parsed || !Array.isArray(parsed.sourceRefs) || !Number.isFinite(parsed.confidence) || parsed.confidence < 0.85) return null
  const refs = [...new Set(parsed.sourceRefs.filter((ref) => candidates.some((candidate) => candidate.ref === ref)))].slice(0, 6)
  if (refs.length === 0) return null
  return { refs, confidence: parsed.confidence, reason: clip(parsed.reason, 500) }
}

async function verifyWithLlm(callLLM, memory, selected) {
  const evidence = selected.map((candidate) => [
    `用户时间：${new Date(candidate.message.at).toISOString()}（本地 ${localTime(candidate.message.at)}）`,
    `用户消息：${clip(candidate.message.content)}`,
    candidate.message.previous ? `前一条：${clip(candidate.message.previous, 400)}` : "",
    candidate.message.next ? `后一条：${clip(candidate.message.next, 400)}` : "",
  ].filter(Boolean).join("\n")).join("\n\n")
  const raw = await callLLM([
    { role: "system", content: "你是独立证据复核器。判断所选用户消息是否直接支持待验证记忆的全部关键事实。不得因为主题相似、时间接近、AI曾提及或常识推断而通过。证据不完整时 supported=false。只输出JSON。" },
    { role: "user", content: `待验证记忆：${memory.content}\n\n所选真实对话证据：\n${evidence}\n\n输出：{"supported":true,"confidence":0.95,"reason":"逐项说明"}` },
  ], 4096)
  const parsed = parseJsonObject(raw)
  if (!parsed || parsed.supported !== true || !Number.isFinite(parsed.confidence) || parsed.confidence < 0.9) return null
  return { confidence: parsed.confidence, reason: clip(parsed.reason, 500) }
}

function assertOnlySourceTimesChanged(before, after) {
  assert.equal(after.l2.length, before.l2.length)
  for (let index = 0; index < before.l2.length; index += 1) {
    const oldMemory = structuredClone(before.l2[index])
    const newMemory = structuredClone(after.l2[index])
    for (const memory of [oldMemory, newMemory]) {
      delete memory.sourceAt
      delete memory.sourceEndAt
      delete memory.validFrom
    }
    assert.deepEqual(newMemory, oldMemory, `迁移越界修改了 ${before.l2[index].id} 的非时间字段`)
  }
}

function assertProtectedFilesUnchanged(expected) {
  assert.deepEqual(Object.fromEntries(Object.keys(expected).map((filePath) => [filePath, digest(filePath)])), expected, "真实聊天、记忆、向量或模型配置在候选生成期间发生变化")
}

function writeJsonAtomically(filePath, value) {
  const tempPath = `${filePath}.source-time-${process.pid}.tmp`
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), "utf8")
  fs.renameSync(tempPath, filePath)
}
