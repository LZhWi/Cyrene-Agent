import { describe, expect, it, vi } from "vitest";
import type { PluginStorage } from "@playa0v0/cyrene-plugin-sdk";
import { createMemory } from "../plugins/companion-memory/src/memory";

async function fixture() {
  const map = new Map<string, any>();
  const storage: PluginStorage = { get: (k) => structuredClone(map.get(k)), set: (k, v) => { map.set(k, structuredClone(v)); }, rootDir: () => "unused" };
  const memory = createMemory(storage);
  const texts = ["我喜欢咖啡", "我不喜欢咖啡", "不应发送的第三条", "其他", "其他", "其他", "其他", "其他", "其他", "其他"];
  texts.forEach((user, i) => memory.ingest({ id: `t${i}`, sessionId: "s", user, assistant: "好", userAt: i + 1, assistantAt: i + 2 }));
  await memory.maintain(async () => JSON.stringify(texts.slice(0, 3).map((text, i) => ({ content: text, quote: text, turnId: `t${i}` }))), new AbortController().signal);
  const [left, right] = memory.view().entries;
  const raw = () => ({ leftId: left.id, rightId: right.id, revision: memory.view().revision });
  return { memory, raw, left, right, storage, map };
}
const signal = () => new AbortController().signal;
const result = JSON.stringify({ verdict: "conflict", reason: "可能是偏好发生变化，需确认时间" });
const resolverResult = JSON.stringify({ resolutionType: "preference_evolution", confidence: 0.92, resolvedSummary: "用户的咖啡偏好由喜欢变为不喜欢", reason: "两条证据时间不同且表述相反", actions: { createResolvedMemory: true, leftStatus: "superseded", rightStatus: "merged", shouldAskUser: false, clarificationNeeded: false } });
describe("L2 双条复核", () => {
  it("只发送选中两条；模型不能自行归档，用户决定保留证据并可恢复", async () => {
    const { memory, raw, left, right, storage } = await fixture();
    const generate = vi.fn(async (_prompt: string) => result);
    const review = await memory.reviewEntries(raw(), generate, signal());
    expect(generate.mock.calls[0][0]).toContain(left.quote);
    expect(generate.mock.calls[0][0]).toContain(right.quote);
    expect(generate.mock.calls[0][0]).not.toContain("不应发送的第三条");
    expect(memory.view().entries.every((e) => e.status === "active")).toBe(true);
    memory.resolveEntryReview({ id: review.id, action: "archive-left", revision: memory.view().revision });
    expect(memory.view().entries[0]).toEqual({ ...left, status: "archived" });
    expect(createMemory(storage).view().entryReviews[0]).toEqual({ ...review, status: "archive-left" });
    memory.editEntry({ ...left, status: "active", revision: memory.view().revision });
    expect(memory.view().entries[0]).toEqual(left);
  });
  it("旧决定不能影响已编辑的任一侧，但可关闭记录", async () => {
    const { memory, raw, right } = await fixture();
    const review = await memory.reviewEntries(raw(), async () => result, signal());
    memory.editEntry({ ...right, content: "手动确认后的内容", revision: memory.view().revision });
    expect(() => memory.resolveEntryReview({ id: review.id, action: "archive-left", revision: memory.view().revision })).toThrow("已变化");
    memory.resolveEntryReview({ id: review.id, action: "keep-both", revision: memory.view().revision });
    expect(memory.view().entries.every((e) => e.status === "active")).toBe(true);
    expect(() => memory.resolveEntryReview({ id: review.id, action: "archive-right", revision: memory.view().revision })).toThrow("无效");
  });
  it("结构化 Resolver 计划只在确认后原子应用，并可严格撤销", async () => {
    const { memory, raw, left, right, storage } = await fixture();
    const review = await memory.reviewEntries(raw(), async () => resolverResult, signal());
    expect(review).toMatchObject({ verdict: "conflict", status: "pending", resolverPlan: { resolutionType: "preference_evolution", confidence: 0.92, actions: { createResolvedMemory: true, leftStatus: "superseded", rightStatus: "merged" } } });
    expect(memory.view().entries).toEqual(expect.arrayContaining([left, right]));
    const applied = memory.resolveEntryReview({ id: review.id, action: "apply-plan", revision: memory.view().revision });
    const createdId = (applied as any).resolverChange.createdId;
    expect(applied.entries.find((entry) => entry.id === left.id)).toEqual({ ...left, status: "superseded", supersededBy: createdId });
    expect(applied.entries.find((entry) => entry.id === right.id)).toEqual({ ...right, status: "merged", mergedInto: createdId });
    expect(applied.entries.find((entry) => entry.id === createdId)).toMatchObject({ content: "用户的咖啡偏好由喜欢变为不喜欢", status: "active", provenance: "derived-reviewed", subEntryIds: [left.id, right.id] });
    expect(createMemory(storage).view().entryReviews.find((item) => item.id === review.id)).toMatchObject({ status: "plan-applied", resultId: createdId });
    const undone = memory.resolveEntryReview({ id: review.id, action: "undo-plan", revision: memory.view().revision });
    expect(undone.entries.find((entry) => entry.id === createdId)).toBeUndefined();
    expect(undone.entries.find((entry) => entry.id === left.id)).toEqual(left);
    expect(undone.entries.find((entry) => entry.id === right.id)).toEqual(right);
    expect(undone.entryReviews.find((item) => item.id === review.id)?.status).toBe("plan-undone");
  });
  it("需澄清计划不能携带变更，过期计划也不能作用于后续编辑", async () => {
    const { memory, raw, left } = await fixture();
    const unsafe = JSON.stringify({ resolutionType: "uncertain", confidence: 0.4, reason: "证据不足", actions: { createResolvedMemory: false, leftStatus: "archived", shouldAskUser: true, clarificationNeeded: true } });
    await expect(memory.reviewEntries(raw(), async () => unsafe, signal())).rejects.toThrow("不能修改记忆");
    const clarification = JSON.stringify({ resolutionType: "uncertain", confidence: 0.4, reason: "需要用户澄清", actions: { createResolvedMemory: false, shouldAskUser: true, clarificationNeeded: true } });
    const clarificationReview = await memory.reviewEntries(raw(), async () => clarification, signal());
    expect(() => memory.resolveEntryReview({ id: clarificationReview.id, action: "apply-plan", revision: memory.view().revision })).toThrow("需要用户澄清");
    const review = await memory.reviewEntries(raw(), async () => resolverResult, signal());
    memory.editEntry({ ...left, pinned: true, revision: memory.view().revision });
    expect(() => memory.resolveEntryReview({ id: review.id, action: "apply-plan", revision: memory.view().revision })).toThrow("记忆已变化");
  });
  it("自动应用仅接受高置信无变更结论或完整偏好演进，直接冲突保留人工确认", async () => {
    const evolution = await fixture();
    const evolutionReview = await evolution.memory.reviewEntries(evolution.raw(), async () => resolverResult, signal());
    expect(evolution.memory.autoApplyResolverReview({ id: evolutionReview.id, revision: evolution.memory.view().revision })).toMatchObject({ applied: true, reason: "applied-evolution", memoryChanged: true });
    expect(evolution.memory.view().entryReviews.find((item) => item.id === evolutionReview.id)?.status).toBe("plan-applied");

    const unrelated = await fixture();
    const unrelatedResult = JSON.stringify({ resolutionType: "unrelated", confidence: 0.95, reason: "对象不同", actions: { createResolvedMemory: false, shouldAskUser: false, clarificationNeeded: false } });
    const unrelatedReview = await unrelated.memory.reviewEntries(unrelated.raw(), async () => unrelatedResult, signal());
    expect(unrelated.memory.autoApplyResolverReview({ id: unrelatedReview.id, revision: unrelated.memory.view().revision })).toMatchObject({ applied: true, reason: "closed-no-change", memoryChanged: false });
    expect(unrelated.memory.view().entryReviews.find((item) => item.id === unrelatedReview.id)?.status).toBe("keep-both");

    const conflict = await fixture();
    const conflictResult = JSON.stringify({ resolutionType: "direct_conflict", confidence: 0.99, reason: "直接相反", actions: { createResolvedMemory: false, leftStatus: "archived", shouldAskUser: false, clarificationNeeded: false } });
    const conflictReview = await conflict.memory.reviewEntries(conflict.raw(), async () => conflictResult, signal());
    expect(conflict.memory.autoApplyResolverReview({ id: conflictReview.id, revision: conflict.memory.view().revision })).toMatchObject({ applied: false, reason: "manual-confirmation-required" });
    expect(conflict.memory.view().entryReviews.find((item) => item.id === conflictReview.id)?.status).toBe("pending");
  });
  it.each(["not json", '{"verdict":"delete","reason":"x"}', '{"verdict":"conflict","reason":""}'])("无效结果不落库 %s", async (value) => {
    const { memory, raw } = await fixture(), before = memory.view();
    await expect(memory.reviewEntries(raw(), async () => value, signal())).rejects.toThrow("无效");
    expect(memory.view()).toEqual(before);
  });
  it("取消、并发编辑和存储失败不保留迟到复核", async () => {
    const { memory, raw, storage, left } = await fixture();
    const controller = new AbortController();
    await expect(memory.reviewEntries(raw(), async () => { controller.abort(); return result; }, controller.signal)).rejects.toThrow("取消");
    await expect(memory.reviewEntries(raw(), async () => { memory.editEntry({ ...left, pinned: true, revision: memory.view().revision }); return result; }, signal())).rejects.toThrow("刷新");
    vi.spyOn(storage, "set").mockImplementationOnce(() => { throw new Error("磁盘失败"); });
    await expect(memory.reviewEntries(raw(), async () => result, signal())).rejects.toThrow("磁盘失败");
    expect(memory.view().entryReviews).toEqual([]); expect(memory.view().reviewing).toBe(false);
  });
  it("禁止同条/归档条目/旧版本，加载兼容旧数据且拒绝损坏记录", async () => {
    const { memory, raw, left, map, storage } = await fixture();
    const generate = vi.fn(async () => result);
    await expect(memory.reviewEntries({ ...raw(), rightId: left.id }, generate, signal())).rejects.toThrow("不同");
    await expect(memory.reviewEntries({ ...raw(), revision: 0 }, generate, signal())).rejects.toThrow("刷新");
    memory.editEntry({ ...left, status: "archived", revision: memory.view().revision });
    await expect(memory.reviewEntries(raw(), generate, signal())).rejects.toThrow("有效");
    expect(generate).not.toHaveBeenCalled();
    delete map.get("memory-state").entryReviews;
    expect(createMemory(storage).view().entryReviews).toEqual([]);
    expect(map.get("memory-state")).not.toHaveProperty("entryReviews");
    map.get("memory-state").entryReviews = [{}];
    expect(() => createMemory(storage)).toThrow("损坏");
  });
});
