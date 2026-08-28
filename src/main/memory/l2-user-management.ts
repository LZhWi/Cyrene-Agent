import { addL2MemoryVector, deleteUserMemoryVectors, getEntriesBySource } from "../rag"
import { enqueueLLMTask } from "../llm-queue"
import { l2DmaeManager } from "./dmae-manager"
import { memoryJudge } from "./memory-judge"
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
  id: string,
  content: string,
): Promise<{ ok: boolean; indexed: boolean; error?: string }> {
  const normalizedId = id.trim()
  const normalizedContent = content.trim()
  if (!normalizedId) return { ok: false, indexed: false, error: "记忆 ID 不能为空" }
  if (!normalizedContent) return { ok: false, indexed: false, error: "记忆内容不能为空" }
  if (normalizedContent.length > L2_USER_EDIT_MAX_LENGTH) {
    return { ok: false, indexed: false, error: `记忆内容不能超过 ${L2_USER_EDIT_MAX_LENGTH} 个字符` }
  }

  const updated = await memoryStore.updateL2Content(normalizedId, normalizedContent)
  if (!updated) return { ok: false, indexed: false, error: "记忆不存在或已被删除" }

  await l2DmaeManager.removeMemory(normalizedId)
  try {
    deleteVectorsForL2(normalizedId, updated.oldRagId)
  } catch (error) {
    console.warn("[L2UserManagement] 清理旧向量失败，旧向量已因映射失效而不可召回:", error)
  }

  try {
    let vectorFacets = updated.memory.facets
    try {
      const classified = await enqueueLLMTask("MemoryKindUserEdit", () => memoryJudge.classifyMemoryFacetsBatch([{
        id: updated.memory.id,
        text: `${updated.memory.content}\n原始线索：${updated.memory.sourceQuote || updated.memory.triggerText || ""}`.slice(0, 1600),
        context: "user-edited L2 summary memory",
      }]))
      const result = classified.find((item) => item.id === updated.memory.id)
      if (!result) throw new Error("L2 kind classifier returned incomplete IDs")
      await memoryStore.updateL2FacetsBatch([result])
      vectorFacets = result.facets
    } catch (error) {
      console.warn("[L2UserManagement] 编辑后即时分类失败，将由启动回填任务重试:", error)
    }

    const ragId = await addL2MemoryVector(updated.memory.content, updated.memory.id, {
      triggerText: updated.memory.triggerText,
      facets: vectorFacets,
      source: "user_edit",
    }, { createdAt: updated.memory.createdAt })
    await memoryStore.markL2SyncStatus(updated.memory.id, "synced", ragId)
    return { ok: true, indexed: true }
  } catch (error) {
    await memoryStore.markL2SyncStatus(updated.memory.id, "sync_failed", undefined, error)
    return {
      ok: true,
      indexed: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export async function deleteL2MemoryForUser(
  id: string,
): Promise<{ ok: boolean; deleted: boolean; deletedVectors: number; error?: string }> {
  const normalizedId = id.trim()
  if (!normalizedId) return { ok: false, deleted: false, deletedVectors: 0, error: "记忆 ID 不能为空" }

  const deleted = (await memoryStore.getAllL2()).find((memory) => memory.id === normalizedId)
  if (!deleted) return { ok: false, deleted: false, deletedVectors: 0, error: "记忆不存在或已被删除" }
  await memoryStore.deleteL2(normalizedId)

  await l2DmaeManager.removeMemory(normalizedId)
  let deletedVectors = 0
  try {
    deletedVectors = deleteVectorsForL2(normalizedId, deleted.ragId)
  } catch (error) {
    console.warn("[L2UserManagement] 删除向量失败，孤立向量不会再被 L2 检索引用:", error)
  }
  return { ok: true, deleted: true, deletedVectors }
}
