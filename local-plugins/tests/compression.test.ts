import { describe, expect, it, vi } from "vitest";
import type { PluginStorage } from "@playa0v0/cyrene-plugin-sdk";
import { createMemory } from "../plugins/companion-memory/src/memory";
import { emptyProfiles } from "../plugins/companion-memory/src/profiles";

function fixture() {
  const entries = [
    { id: "secret-a", content: "用户计划秋天去京都", quote: "秋天想去京都", sourceAt: 100, turnId: "ta", sessionId: "s", pinned: false, status: "active" as const, provenance: "verified" as const },
    { id: "secret-b", content: "用户已预订京都酒店", quote: "京都酒店订好了", sourceAt: 300, turnId: "tb", sessionId: "s", pinned: true, status: "active" as const, provenance: "verified" as const },
  ];
  const evidence = [{ id: "secret-evidence", memoryId: "secret-a", quoteSnippet: "准备秋天出发", createdAt: 110, sourceStatus: "active" as const, provenance: "verified" as const }];
  const map = new Map<string, unknown>([["memory-state", { version: 2, revision: 0, turns: [], processed: [], entries, evidence, profiles: emptyProfiles(), profileChanges: [], entryReviews: [], compressionReviews: [] }]]);
  const storage: PluginStorage = { get: <T>(key: string) => structuredClone(map.get(key)) as T | undefined, set: (key, value) => { map.set(key, structuredClone(value)); }, rootDir: () => "unused" };
  return { memory: createMemory(storage), entries, evidence };
}
function automaticFixture(validTo?: number) {
  const entries = [100, 200, 300].map((sourceAt, index) => ({ id: `aging-${index}`, content: `同一长期计划进展 ${index + 1}`, quote: `进展 ${index + 1}`, sourceAt, turnId: `t${index}`, sessionId: "s", pinned: false, status: "aging" as const, provenance: "verified" as const, ...(validTo === undefined ? {} : { validTo }) }));
  const map = new Map<string, unknown>([["memory-state", { version: 2, revision: 0, turns: [], processed: [], entries, evidence: [], profiles: emptyProfiles(), profileChanges: [], entryReviews: [], compressionReviews: [], lifecycleChanges: [] }]]);
  const storage: PluginStorage = { get: <T>(key: string) => structuredClone(map.get(key)) as T | undefined, set: (key, value) => { map.set(key, structuredClone(value)); }, rootDir: () => "unused" };
  return createMemory(storage);
}
const signal = () => new AbortController().signal;

describe("可撤销 L2 压缩事务", () => {
  it("模型只生成建议，用户应用后保留原条目并可严格撤销", async () => {
    const { memory, evidence } = fixture(), generate = vi.fn().mockResolvedValue('{"verdict":"mergeable","summary":"用户秋天计划去京都，酒店已预订。","reason":"同一旅行计划的进展"}');
    const review = await memory.reviewCompression({ entryIds: ["secret-a", "secret-b"], revision: 0 }, generate, signal());
    expect(review).toMatchObject({ verdict: "mergeable", status: "pending" });
    expect(memory.view().entries.every((entry) => entry.status === "active")).toBe(true);
    const prompt = generate.mock.calls[0][0];
    expect(prompt).toContain("用户计划秋天去京都"); expect(prompt).toContain("准备秋天出发");
    expect(prompt).not.toContain("secret-a"); expect(prompt).not.toContain("secret-evidence");

    const applied = memory.resolveCompression({ id: review.id, action: "apply", revision: 1 });
    const createdId = applied.compressionChange.createdId;
    expect(applied.entries.filter((entry) => ["secret-a", "secret-b"].includes(entry.id)).every((entry) => entry.status === "merged" && entry.mergedInto === createdId)).toBe(true);
    expect(applied.entries.find((entry) => entry.id === createdId)).toMatchObject({ content: "用户秋天计划去京都，酒店已预订。", sourceAt: 100, sourceEndAt: 300, pinned: true, provenance: "derived-reviewed", isSummary: true, subEntryIds: ["secret-a", "secret-b"] });
    expect(memory.search("京都")).toContain("用户确认的多来源总结");

    const undone = memory.resolveCompression({ id: review.id, action: "undo", revision: 2 });
    expect(undone.compressionChange.removedId).toBe(createdId);
    expect(undone.entries.some((entry) => entry.id === createdId)).toBe(false);
    expect(undone.entries.filter((entry) => ["secret-a", "secret-b"].includes(entry.id)).every((entry) => entry.status === "active" && !entry.mergedInto)).toBe(true);
    expect(undone.evidence).toEqual(evidence);
  });

  it("非合并结论不能应用，复核后条目变化会使旧建议失效", async () => {
    const first = fixture(), different = await first.memory.reviewCompression({ entryIds: ["secret-a", "secret-b"], revision: 0 }, vi.fn().mockResolvedValue('{"verdict":"different","reason":"不同事项"}'), signal());
    expect(() => first.memory.resolveCompression({ id: different.id, action: "apply", revision: 1 })).toThrow("不能执行压缩");
    const second = fixture(), mergeable = await second.memory.reviewCompression({ entryIds: ["secret-a", "secret-b"], revision: 0 }, vi.fn().mockResolvedValue('{"verdict":"mergeable","summary":"总结","reason":"可合并"}'), signal());
    const state = second.memory.view(); second.memory.editEntry({ id: "secret-a", content: "已改变", pinned: false, status: "active", revision: state.revision });
    expect(second.memory.resolveCompression({ id: mergeable.id, action: "apply", revision: 2 }).compressionChange).toMatchObject({ stale: true, staleReason: "source-changed", retryEntryIds: ["secret-a", "secret-b"] });
    expect(second.memory.view().compressionReviews.find((item) => item.id === mergeable.id)).toMatchObject({ status: "stale", staleReason: "source-changed" });
  });

  it("自动路径只应用三条以上、高置信且确认完整覆盖的 aging 建议", async () => {
    const memory = automaticFixture();
    const review = await memory.reviewCompression({ entryIds: ["aging-0", "aging-1", "aging-2"], kind: "dream", revision: 0 }, vi.fn().mockResolvedValue('{"verdict":"mergeable","summary":"同一长期计划已有三阶段进展。","reason":"完整保留全部阶段","confidence":0.96,"coverageConfirmed":true}'), signal());
    const result = memory.autoApplyCompressionReview({ id: review.id, revision: 1 });
    expect(result).toMatchObject({ applied: true, reason: "applied-lossless-compression", reviewId: review.id, memoryChanged: true });
    expect(memory.view().compressionReviews[0]).toMatchObject({ status: "applied", confidence: 0.96, coverageConfirmed: true, appliedAt: expect.any(Number) });
    const createdId = result.createdId;
    expect(memory.view().entries.filter((entry) => entry.id.startsWith("aging-")).every((entry) => entry.status === "merged" && entry.mergedInto === createdId)).toBe(true);
    const undone = memory.resolveCompression({ id: review.id, action: "undo", revision: 2 });
    expect(undone.entries.filter((entry) => entry.id.startsWith("aging-")).every((entry) => entry.status === "aging")).toBe(true);
    expect(memory.view().compressionReviews[0]).toMatchObject({ status: "undone", appliedAt: expect.any(Number), undoneAt: expect.any(Number) });
  });

  it("置信度达到 0.80 即可自动应用，低于 0.80 仍留给人工", async () => {
    const accepted = automaticFixture();
    const acceptedReview = await accepted.reviewCompression({ entryIds: ["aging-0", "aging-1", "aging-2"], kind: "dream", revision: 0 }, vi.fn().mockResolvedValue('{"verdict":"mergeable","summary":"同一计划的完整阶段总结。","reason":"完整覆盖","confidence":0.8,"coverageConfirmed":true}'), signal());
    expect(accepted.autoApplyCompressionReview({ id: acceptedReview.id, revision: 1 })).toMatchObject({ applied: true, reason: "applied-lossless-compression" });

    const rejected = automaticFixture();
    const rejectedReview = await rejected.reviewCompression({ entryIds: ["aging-0", "aging-1", "aging-2"], kind: "dream", revision: 0 }, vi.fn().mockResolvedValue('{"verdict":"mergeable","summary":"同一计划的候选总结。","reason":"置信度不足","confidence":0.79,"coverageConfirmed":true}'), signal());
    expect(rejected.autoApplyCompressionReview({ id: rejectedReview.id, revision: 1 })).toMatchObject({ applied: false, reason: "low-confidence" });
    expect(rejected.view().compressionReviews[0].status).toBe("pending");
  });

  it("低置信、未确认覆盖和两条来源建议均留在待确认列表", async () => {
    for (const [confidence, coverageConfirmed] of [[0.79, true], [0.99, false]] as const) {
      const memory = automaticFixture();
      const review = await memory.reviewCompression({ entryIds: ["aging-0", "aging-1", "aging-2"], kind: "dream", revision: 0 }, vi.fn().mockResolvedValue(JSON.stringify({ verdict: "mergeable", summary: "候选总结", reason: "仍需人工确认", confidence, coverageConfirmed })), signal());
      expect(memory.autoApplyCompressionReview({ id: review.id, revision: 1 }).applied).toBe(false);
      expect(memory.view().compressionReviews[0].status).toBe("pending");
    }
    const two = fixture();
    const review = await two.memory.reviewCompression({ entryIds: ["secret-a", "secret-b"], revision: 0 }, vi.fn().mockResolvedValue('{"verdict":"mergeable","summary":"候选总结","reason":"来源太少","confidence":0.99,"coverageConfirmed":true}'), signal());
    expect(two.memory.autoApplyCompressionReview({ id: review.id, revision: 1 })).toMatchObject({ applied: false, reason: "too-few-sources" });
    expect(two.memory.view().compressionReviews[0].status).toBe("pending");
  });

  it("自动执行前任一来源变化都会拒绝旧计划", async () => {
    const memory = automaticFixture();
    const review = await memory.reviewCompression({ entryIds: ["aging-0", "aging-1", "aging-2"], kind: "dream", revision: 0 }, vi.fn().mockResolvedValue('{"verdict":"mergeable","summary":"候选总结","reason":"可合并","confidence":0.99,"coverageConfirmed":true}'), signal());
    memory.editEntry({ id: "aging-0", content: "已发生后续变化", pinned: false, status: "aging", revision: 1 });
    expect(memory.autoApplyCompressionReview({ id: review.id, revision: 2 })).toMatchObject({ applied: false, reason: "stale-plan", stale: true, staleReason: "source-changed", retryEntryIds: ["aging-0", "aging-1", "aging-2"] });
    expect(memory.view().compressionReviews[0].status).toBe("stale");
  });

  it("应用前来源刚超过有效期会使计划失效且不创建总结", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const memory = automaticFixture(1_100);
      const review = await memory.reviewCompression({ entryIds: ["aging-0", "aging-1", "aging-2"], kind: "dream", revision: 0 }, vi.fn().mockResolvedValue('{"verdict":"mergeable","summary":"候选总结","reason":"完整覆盖","confidence":0.99,"coverageConfirmed":true}'), signal());
      vi.setSystemTime(1_200);
      expect(memory.autoApplyCompressionReview({ id: review.id, revision: 1 })).toMatchObject({ applied: false, reason: "stale-plan", stale: true, staleReason: "source-expired", retryEntryIds: [] });
      expect(memory.view().entries.some((entry) => entry.isSummary)).toBe(false);
      expect(memory.view().compressionReviews[0]).toMatchObject({ status: "stale", staleReason: "source-expired", staleAt: 1_200 });
    } finally { vi.useRealTimers(); }
  });

  it("常规二十轮压缩按本地语义归档来源，并保留严格撤销", async () => {
    const { memory } = fixture();
    const initial = memory.view();
    // fixture 只有两条，直接补一条同类 active 叶子用于常规压缩事务。
    const imported = structuredClone(initial);
    expect(imported.entries).toHaveLength(2);
    const map = new Map<string, unknown>([["memory-state", {
      ...imported,
      revision: 0,
      entries: [...imported.entries.map((entry) => ({ ...entry, pinned: false })), {
        id: "secret-c", content: "用户已确定京都出发日期", quote: "日期确定了", sourceAt: 400,
        turnId: "tc", sessionId: "s", pinned: false, status: "active", provenance: "verified",
      }],
    }]]);
    const storage: PluginStorage = { get: <T>(key: string) => structuredClone(map.get(key)) as T | undefined, set: (key, value) => { map.set(key, structuredClone(value)); }, rootDir: () => "unused" };
    const regular = createMemory(storage);
    const review = await regular.reviewCompression({ entryIds: ["secret-a", "secret-b", "secret-c"], kind: "regular", revision: 0 }, vi.fn().mockResolvedValue('{"shouldCompress":true,"summary":"用户已完成京都行程准备。","reason":"同一计划的连续进展"}'), signal());

    expect(regular.autoApplyCompressionReview({ id: review.id, revision: 1 })).toMatchObject({ applied: true, memoryChanged: true });
    expect(regular.view().entries.filter((entry) => entry.id.startsWith("secret-")).every((entry) => entry.status === "archived" && !entry.mergedInto)).toBe(true);
    const undone = regular.resolveCompression({ id: review.id, action: "undo", revision: 2 });
    expect(undone.entries.filter((entry) => entry.id.startsWith("secret-")).every((entry) => entry.status === "active")).toBe(true);
  });

  it("常规提案与 dream 不会对同一组条目重复落地", async () => {
    const entries = [100, 200, 300].map((sourceAt, index) => ({
      id: `shared-${index}`, content: `同一事件阶段 ${index + 1}`, quote: `阶段 ${index + 1}`,
      sourceAt, turnId: `t${index}`, sessionId: "s", pinned: false,
      status: "active" as const, provenance: "verified" as const,
    }));
    const map = new Map<string, unknown>([["memory-state", {
      version: 2, revision: 0, turns: [], processed: [], entries, evidence: [], profiles: emptyProfiles(),
      profileChanges: [], entryReviews: [], compressionReviews: [], lifecycleChanges: [],
    }]]);
    const storage: PluginStorage = { get: <T>(key: string) => structuredClone(map.get(key)) as T | undefined, set: (key, value) => { map.set(key, structuredClone(value)); }, rootDir: () => "unused" };
    const memory = createMemory(storage);
    const regular = await memory.reviewCompression({ entryIds: entries.map((entry) => entry.id), kind: "regular", revision: 0 }, vi.fn().mockResolvedValue('{"shouldCompress":true,"summary":"常规候选总结","reason":"同一事件"}'), signal());

    // 生命周期先把来源交给 dream；此前基于 active 快照生成的常规提案立即失效。
    memory.transitionLifecyclePlan({ agingEntryIds: entries.map((entry) => entry.id), archivedEntryIds: [], revision: 1 });
    expect(memory.autoApplyCompressionReview({ id: regular.id, revision: 2 })).toMatchObject({ applied: false, reason: "stale-plan", stale: true, staleReason: "source-changed", retryEntryIds: [] });

    const dream = await memory.reviewCompression({ entryIds: entries.map((entry) => entry.id), kind: "dream", revision: 3 }, vi.fn().mockResolvedValue('{"verdict":"mergeable","summary":"梦境候选总结","reason":"完整覆盖","confidence":0.9,"coverageConfirmed":true}'), signal());
    expect(memory.autoApplyCompressionReview({ id: dream.id, revision: 4 })).toMatchObject({ applied: true });
    const snapshot = memory.view();
    const summary = snapshot.entries.find((entry) => entry.isSummary)!;
    expect(snapshot.entries.filter((entry) => entry.id.startsWith("shared-")).every((entry) => entry.status === "merged" && entry.mergedInto === summary.id)).toBe(true);
    expect(snapshot.entries.filter((entry) => entry.isSummary)).toHaveLength(1);
  });
});
