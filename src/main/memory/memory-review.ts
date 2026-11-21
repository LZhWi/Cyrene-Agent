import { deleteL2MemoryForUser, editL2MemoryForUser, L2_USER_EDIT_MAX_LENGTH } from "./l2-user-management"
import { memoryStore, type L0WritableField, type L1WritableField } from "./memory-store"
import { L0_FIELD_DESCRIPTIONS } from "./memory-types"

export async function resolveMemorySemanticReview(
  id: string, expectedContent: string, action: string, content?: string,
): Promise<{ ok: boolean; indexed?: boolean; error?: string }> {
  if (!["keep", "edit", "delete"].includes(action)) return { ok: false, error: "无效的复核操作" }
  const review = (await memoryStore.getSemanticReviews()).find(item => item.id === id)
  if (!review || review.content !== expectedContent) return { ok: false, error: "记忆已变化，请刷新后重试" }
  const replacement = action === "delete" ? "" : content?.trim() ?? ""
  if (action === "edit" && (!replacement || replacement.length > L2_USER_EDIT_MAX_LENGTH)) {
    return { ok: false, error: `记忆内容须为 1～${L2_USER_EDIT_MAX_LENGTH} 个字符` }
  }

  let indexed: boolean | undefined
  if (action !== "keep") {
    if (review.layer === "L2") {
      const result = action === "delete"
        ? await deleteL2MemoryForUser(review.memoryId!)
        : await editL2MemoryForUser(review.memoryId!, replacement)
      if (!result.ok) return result
      if ("indexed" in result) indexed = result.indexed
    } else if (review.layer === "L0" && review.field && Object.hasOwn(L0_FIELD_DESCRIPTIONS, review.field)) {
      await memoryStore.upsertL0Field(review.field as L0WritableField, replacement)
    } else if (review.layer === "L1" && ["recentGoals", "recentPreferences", "currentProject"].includes(review.field ?? "")) {
      await memoryStore.replaceL1Field(review.field as L1WritableField, replacement)
    } else return { ok: false, error: "无效的记忆字段" }
  }
  await memoryStore.dismissSemanticReview(id)
  return { ok: true, ...(indexed !== undefined ? { indexed } : {}) }
}
