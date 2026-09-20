interface InboxItem { id: string; leftId: string; rightId: string; status: "open" | "dismissed"; stale: boolean }

export async function runMaintenanceReviewBatch<T>(raw: any, items: InboxItem[], review: (leftId: string, rightId: string) => Promise<T>, signal: AbortSignal) {
  if (!raw || !Array.isArray(raw.itemIds) || raw.itemIds.length < 1 || raw.itemIds.length > 5 || raw.itemIds.some((id: unknown) => typeof id !== "string") || new Set(raw.itemIds).size !== raw.itemIds.length) throw new Error("批量复核参数无效");
  const byId = new Map(items.map((item) => [item.id, item])), selected: Array<InboxItem | undefined> = raw.itemIds.map((id: string) => byId.get(id));
  if (selected.some((item) => !item || item.status !== "open" || item.stale)) throw new Error("所选维护候选已关闭或来源已变化");
  const results: T[] = [];
  for (const item of selected as InboxItem[]) {
    if (signal.aborted) throw Object.assign(new Error("批量复核已取消"), { completed: results.length });
    results.push(await review(item.leftId, item.rightId));
  }
  return { completed: results.length, results };
}
