import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

const userDataDir = process.env.CYRENE_REAL_USER_DATA_DIR
  || path.join(process.env.APPDATA || "", "live2d-cyrene")
const memoryPath = path.join(userDataDir, "memory.json")
const lastGoodPath = path.join(userDataDir, "memory.last-good.json")
const migrationDir = path.join(userDataDir, "memory-source-time-migrations")
const backupDir = path.join(userDataDir, "memory-source-time-backups")

const digest = (filePath) => createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")
const finiteTime = (value) => typeof value === "number" && Number.isFinite(value)
const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, "utf8"))

assert.ok(fs.existsSync(memoryPath), `找不到正式记忆文件：${memoryPath}`)
assert.ok(fs.existsSync(migrationDir), `找不到迁移候选目录：${migrationDir}`)

const originalHash = digest(memoryPath)
const originalStore = readJson(memoryPath)
assert.ok(Array.isArray(originalStore.l2), "memory.json 缺少 L2 数组")
const originalById = new Map(originalStore.l2.map((memory) => [memory.id, memory]))

const candidateFiles = fs.readdirSync(migrationDir)
  .filter((name) => /^memory\.source-time-candidate\..+\.json$/u.test(name))
  .map((name) => path.join(migrationDir, name))
  .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)

const candidatePath = candidateFiles.find((filePath) => {
  const store = readJson(filePath)
  return Array.isArray(store.l2)
    && store.l2.length > 0
    && store.l2.every((memory) => (
      originalById.has(memory.id)
      && finiteTime(memory.sourceAt)
      && finiteTime(memory.sourceEndAt)
    ))
})
assert.ok(candidatePath, "没有找到可完整合并到当前正式记忆的已验证来源时间候选")

const candidateStore = readJson(candidatePath)
const candidateById = new Map(candidateStore.l2.map((memory) => [memory.id, memory]))
const mergedStore = structuredClone(originalStore)
for (const memory of mergedStore.l2) {
  const candidate = candidateById.get(memory.id)
  if (!candidate) continue
  memory.sourceAt = candidate.sourceAt
  memory.sourceEndAt = candidate.sourceEndAt
  memory.validFrom = candidate.validFrom ?? candidate.sourceAt
}

assert.equal(candidateById.size, candidateStore.l2.length, "迁移候选中存在重复 L2 ID")
assert.equal(
  mergedStore.l2.filter((memory) => finiteTime(memory.sourceAt)).length,
  originalStore.l2.length,
  "合并后仍有 L2 缺少 sourceAt，拒绝写入",
)
for (let index = 0; index < originalStore.l2.length; index += 1) {
  const before = structuredClone(originalStore.l2[index])
  const after = structuredClone(mergedStore.l2[index])
  for (const memory of [before, after]) {
    delete memory.sourceAt
    delete memory.sourceEndAt
    delete memory.validFrom
  }
  assert.deepEqual(after, before, `合并越界修改了 ${originalStore.l2[index].id} 的非时间字段`)
}

fs.mkdirSync(backupDir, { recursive: true })
const tag = originalHash.slice(0, 12)
const memoryBackupPath = path.join(backupDir, `memory.pre-source-time-reapply.${tag}.json`)
if (!fs.existsSync(memoryBackupPath)) fs.copyFileSync(memoryPath, memoryBackupPath)
assert.equal(digest(memoryBackupPath), originalHash, "当前88条备份与写入前 memory.json 哈希不一致")

let lastGoodBackupPath
if (fs.existsSync(lastGoodPath)) {
  const lastGoodHash = digest(lastGoodPath)
  lastGoodBackupPath = path.join(backupDir, `memory.last-good.pre-source-time-reapply.${lastGoodHash.slice(0, 12)}.json`)
  if (!fs.existsSync(lastGoodBackupPath)) fs.copyFileSync(lastGoodPath, lastGoodBackupPath)
  assert.equal(digest(lastGoodBackupPath), lastGoodHash, "memory.last-good.json 备份哈希不一致")
}

assert.equal(digest(memoryPath), originalHash, "正式 memory.json 在合并准备期间发生变化，拒绝写入")
writeJsonAtomically(lastGoodPath, mergedStore)
writeJsonAtomically(memoryPath, mergedStore)

const writtenStore = readJson(memoryPath)
assert.equal(writtenStore.l2.length, originalStore.l2.length)
assert.equal(writtenStore.l2.filter((memory) => finiteTime(memory.sourceAt)).length, originalStore.l2.length)
assert.deepEqual(writtenStore, mergedStore, "正式 memory.json 与合并结果不一致")

console.log(JSON.stringify({
  updated: candidateStore.l2.length,
  total: writtenStore.l2.length,
  candidatePath,
  memoryBackupPath,
  lastGoodBackupPath,
  memorySha256Before: originalHash,
  memorySha256After: digest(memoryPath),
}, null, 2))

function writeJsonAtomically(filePath, value) {
  const tempPath = `${filePath}.source-time-reapply-${process.pid}.tmp`
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), "utf8")
  fs.renameSync(tempPath, filePath)
}
