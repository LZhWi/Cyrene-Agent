import { addL2MemoryVector, deleteUserMemoryVectors, getEntriesBySource } from "../rag"
import { l2DmaeManager } from "./l2-dmae-manager"
import { memoryStore } from "./memory-store"

export const L2_USER_EDIT_MAX_LENGTH = 2000

function vectorIdsForL2(l2Id: string, ragId?: string): string[] {
  const ids = getEntriesBySource("user_memory")
    .filter((entry) => entry.metadata?.l2Id === l2Id)
    .map((entry) => entry.id)
  if (ragId) ids.push(ragId)
  return [...new Set(ids)]
}

function deleteVectorsForL2(l2Id: string, ragId?: string): number {
  return deleteUserMemoryVectors(vectorIdsForL2(l2Id, ragId))
}

export async function editL2MemoryForUser(
  rawId: unknown,
  rawContent: unknown,
): Promise<{ ok: boolean; indexed: boolean; error?: string }> {
  const id = typeof rawId === "string" ? rawId.trim() : ""
  const content = typeof rawContent === "string" ? rawContent.trim() : ""
  if (!id) return { ok: false, indexed: false, error: "记忆 ID 不能为空" }
  if (!content) return { ok: false, indexed: false, error: "记忆内容不能为空" }
  if (content.length > L2_USER_EDIT_MAX_LENGTH) {
    return { ok: false, indexed: false, error: `记忆内容不能超过 ${L2_USER_EDIT_MAX_LENGTH} 个字符` }
  }

  const before = (await memoryStore.getAllL2()).find((memory) => memory.id === id)
  if (!before) return { ok: false, indexed: false, error: "记忆不存在或已被删除" }
  const updated = await memoryStore.updateL2Content(id, content)
  if (!updated) return { ok: false, indexed: false, error: "记忆不存在或已被删除" }

  await l2DmaeManager.removeMemory(id)
  try {
    deleteVectorsForL2(id, before.ragId)
  } catch (error) {
    console.warn("[L2UserManagement] 清理旧向量失败，旧向量已因映射失效而不可召回:", error)
  }

  try {
    const ragId = await addL2MemoryVector(updated.content, updated.id, {
      triggerText: updated.triggerText,
      source: "user_edit",
    })
    await memoryStore.markL2SyncStatus(updated.id, "synced", ragId)
    return { ok: true, indexed: true }
  } catch (error) {
    await memoryStore.markL2SyncStatus(updated.id, "sync_failed", undefined, error)
    return { ok: true, indexed: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function deleteL2MemoryForUser(
  rawId: unknown,
): Promise<{ ok: boolean; deleted: boolean; deletedVectors: number; error?: string }> {
  const id = typeof rawId === "string" ? rawId.trim() : ""
  if (!id) return { ok: false, deleted: false, deletedVectors: 0, error: "记忆 ID 不能为空" }

  const deleted = (await memoryStore.getAllL2()).find((memory) => memory.id === id)
  if (!deleted) return { ok: false, deleted: false, deletedVectors: 0, error: "记忆不存在或已被删除" }
  await memoryStore.deleteL2(id)
  await l2DmaeManager.removeMemory(id)

  let deletedVectors = 0
  try {
    deletedVectors = deleteVectorsForL2(id, deleted.ragId)
  } catch (error) {
    console.warn("[L2UserManagement] 删除向量失败，孤立向量不会再被 L2 检索引用:", error)
  }
  return { ok: true, deleted: true, deletedVectors }
}
