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
const compiledRuntimePath = path.join(projectRoot, "dist/main/main/runtime/runtime-paths.js")
const protectedRelativePaths = [
  "memory.json",
  "memory.last-good.json",
  "rag-data/memory-store.json",
  "entity-graph.json",
  "worldbook-state.json",
  "model-settings.json",
]
const copiedRelativePaths = protectedRelativePaths.filter((relativePath) => relativePath !== "model-settings.json")

if (!fs.existsSync(compiledRuntimePath)) {
  throw new Error("请先运行 npm.cmd run build:main")
}

function digestIfPresent(filePath) {
  return fs.existsSync(filePath)
    ? createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")
    : null
}

function sourceDigests() {
  return Object.fromEntries(protectedRelativePaths.map((relativePath) => [
    relativePath,
    digestIfPresent(path.join(realUserDataDir, relativePath)),
  ]))
}

function copyIfPresent(relativePath, destinationRoot) {
  const source = path.join(realUserDataDir, relativePath)
  if (!fs.existsSync(source)) return
  const destination = path.join(destinationRoot, relativePath)
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.copyFileSync(source, destination)
}

const before = sourceDigests()
assert.ok(before["memory.json"], "真实 memory.json 不存在")
assert.ok(before["rag-data/memory-store.json"], "真实向量库不存在")

const isolatedUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-l2-user-management-"))
copiedRelativePaths.forEach((relativePath) => copyIfPresent(relativePath, isolatedUserDataDir))

let rag
try {
  const { setAppPathProvider } = require(compiledRuntimePath)
  setAppPathProvider({
    getPath(name) {
      if (name === "userData") return isolatedUserDataDir
      if (name === "home") return os.homedir()
      if (name === "temp") return os.tmpdir()
      return path.join(isolatedUserDataDir, name)
    },
    getAppPath: () => projectRoot,
  })

  const settingsPath = path.join(realUserDataDir, "model-settings.json")
  const settings = fs.existsSync(settingsPath)
    ? JSON.parse(fs.readFileSync(settingsPath, "utf8"))
    : {}
  const embeddingModel = settings.embeddingModel === "bgem3" ? "bgem3" : "minilm"

  rag = require(path.join(projectRoot, "dist/main/main/rag/index.js"))
  await rag.initRAG("auto", undefined, undefined, embeddingModel)

  // 本测试只验证真实存储和真实 embedding 链，不向外部分类模型发送真实记忆。
  const { memoryJudge } = require(path.join(projectRoot, "dist/main/main/memory/memory-judge.js"))
  memoryJudge.classifyMemoryFacetsBatch = async (items) => items.map(({ id }) => ({
    id,
    facets: {
      primaryKind: "fact",
      retrievalKinds: ["fact"],
      source: "model",
      pendingClassification: false,
    },
  }))

  const { memoryStore } = require(path.join(projectRoot, "dist/main/main/memory/memory-store.js"))
  const memories = await memoryStore.getAllL2()
  const vectors = rag.getEntriesBySource("user_memory")
  const vectorByL2Id = new Map(vectors.flatMap((entry) => (
    typeof entry.metadata?.l2Id === "string" ? [[entry.metadata.l2Id, entry]] : []
  )))
  const target = memories.find((memory) => (
    (memory.status === "active" || memory.status === "aging")
    && memory.syncStatus === "synced"
    && memory.content.length < 1900
    && vectorByL2Id.has(memory.id)
  ))
  assert.ok(target, "真实数据中没有可用于隔离测试的已同步 L2")

  const oldVectorId = vectorByL2Id.get(target.id)?.id
  const originalTrigger = target.triggerText
  const editedContent = `${target.content}（隔离编辑验证）`
  const { editL2MemoryForUser, deleteL2MemoryForUser } = require(
    path.join(projectRoot, "dist/main/main/memory/l2-user-management.js"),
  )

  assert.deepEqual(await editL2MemoryForUser(target.id, editedContent), { ok: true, indexed: true })
  const afterEdit = (await memoryStore.getAllL2()).find((memory) => memory.id === target.id)
  assert.equal(afterEdit?.content, editedContent)
  assert.equal(afterEdit?.triggerText, originalTrigger)
  assert.equal(afterEdit?.syncStatus, "synced")
  assert.equal(afterEdit?.facets?.source, "model")
  assert.notEqual(afterEdit?.ragId, oldVectorId)
  assert.equal(rag.getEntriesBySource("user_memory").some((entry) => entry.id === oldVectorId), false)
  assert.equal(rag.getEntriesBySource("user_memory").filter((entry) => entry.metadata?.l2Id === target.id).length, 1)

  const deleted = await deleteL2MemoryForUser(target.id)
  assert.equal(deleted.ok, true)
  assert.equal((await memoryStore.getAllL2()).some((memory) => memory.id === target.id), false)
  assert.equal(rag.getEntriesBySource("user_memory").some((entry) => entry.metadata?.l2Id === target.id), false)
  const isolatedStore = await memoryStore.load()
  assert.equal((isolatedStore.evidence || []).some((evidence) => evidence.memoryId === target.id), false)
  assert.equal(isolatedStore.l2DmaeStates?.[target.id], undefined)
  rag.flushVectorStoreSync()

  console.log(`[L2UserManagementEval] 隔离验证通过；真实 L2 总数 ${memories.length}，真实向量总数 ${vectors.length}`)
} finally {
  rag?.resetRAG()
  assert.deepEqual(sourceDigests(), before, "真实用户数据在隔离测试期间发生变化")
  if (path.dirname(isolatedUserDataDir) === os.tmpdir()) {
    fs.rmSync(isolatedUserDataDir, { recursive: true, force: true })
  }
}
