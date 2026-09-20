import { describe, expect, it, vi } from "vitest";
import { runMaintenanceReviewBatch } from "../plugins/companion-memory/src/maintenance-batch";

const items = [
  { id: "i1", leftId: "a", rightId: "b", status: "open" as const, stale: false },
  { id: "i2", leftId: "c", rightId: "d", status: "open" as const, stale: false },
  { id: "closed", leftId: "e", rightId: "f", status: "dismissed" as const, stale: false },
  { id: "stale", leftId: "g", rightId: "h", status: "open" as const, stale: true },
];

describe("维护候选批量模型复核", () => {
  it("严格串行处理最多五对且保留顺序", async () => {
    const order: string[] = [], review = vi.fn(async (left: string, right: string) => { order.push(`${left}-${right}`); return `${left}/${right}`; });
    const result = await runMaintenanceReviewBatch({ itemIds: ["i2", "i1"] }, items, review, new AbortController().signal);
    expect(result).toEqual({ completed: 2, results: ["c/d", "a/b"] });
    expect(order).toEqual(["c-d", "a-b"]);
  });

  it("拒绝关闭、失效、重复和超过上限的候选", async () => {
    const review = vi.fn();
    await expect(runMaintenanceReviewBatch({ itemIds: ["closed"] }, items, review, new AbortController().signal)).rejects.toThrow("已关闭或来源已变化");
    await expect(runMaintenanceReviewBatch({ itemIds: ["stale"] }, items, review, new AbortController().signal)).rejects.toThrow("已关闭或来源已变化");
    await expect(runMaintenanceReviewBatch({ itemIds: ["i1", "i1"] }, items, review, new AbortController().signal)).rejects.toThrow("参数无效");
    await expect(runMaintenanceReviewBatch({ itemIds: ["1", "2", "3", "4", "5", "6"] }, items, review, new AbortController().signal)).rejects.toThrow("参数无效");
    expect(review).not.toHaveBeenCalled();
  });

  it("轮次之间响应取消，不发送尚未开始的候选", async () => {
    const controller = new AbortController(), review = vi.fn(async () => { controller.abort(); return "done"; });
    await expect(runMaintenanceReviewBatch({ itemIds: ["i1", "i2"] }, items, review, controller.signal)).rejects.toMatchObject({ message: "批量复核已取消", completed: 1 });
    expect(review).toHaveBeenCalledTimes(1);
  });
});
