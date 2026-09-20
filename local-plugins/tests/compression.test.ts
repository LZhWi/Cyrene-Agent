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
function automaticFixture() {
  const entries = [100, 200, 300].map((sourceAt, index) => ({ id: `aging-${index}`, content: `同一长期计划进展 ${index + 1}`, quote: `进展 ${index + 1}`, sourceAt, turnId: `t${index}`, sessionId: "s", pinned: false, status: "aging" as const, provenance: "verified" as const }));
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
    expect(() => second.memory.resolveCompression({ id: mergeable.id, action: "apply", revision: 2 })).toThrow("记忆已变化");
  });

  it("自动路径只应用三条以上、高置信且确认完整覆盖的 aging 建议", async () => {
    const memory = automaticFixture();
    const review = await memory.reviewCompression({ entryIds: ["aging-0", "aging-1", "aging-2"], revision: 0 }, vi.fn().mockResolvedValue('{"verdict":"mergeable","summary":"同一长期计划已有三阶段进展。","reason":"完整保留全部阶段","confidence":0.96,"coverageConfirmed":true}'), signal());
    const result = memory.autoApplyCompressionReview({ id: review.id, revision: 1 });
    expect(result).toMatchObject({ applied: true, reason: "applied-lossless-compression", reviewId: review.id, memoryChanged: true });
    expect(memory.view().compressionReviews[0]).toMatchObject({ status: "applied", confidence: 0.96, coverageConfirmed: true, appliedAt: expect.any(Number) });
    expect(memory.view().entries.filter((entry) => entry.status === "merged")).toHaveLength(3);
    const undone = memory.resolveCompression({ id: review.id, action: "undo", revision: 2 });
    expect(undone.entries.filter((entry) => entry.id.startsWith("aging-")).every((entry) => entry.status === "aging")).toBe(true);
    expect(memory.view().compressionReviews[0]).toMatchObject({ status: "undone", appliedAt: expect.any(Number), undoneAt: expect.any(Number) });
  });

  it("置信度达到 0.80 即可自动应用，低于 0.80 仍留给人工", async () => {
    const accepted = automaticFixture();
    const acceptedReview = await accepted.reviewCompression({ entryIds: ["aging-0", "aging-1", "aging-2"], revision: 0 }, vi.fn().mockResolvedValue('{"verdict":"mergeable","summary":"同一计划的完整阶段总结。","reason":"完整覆盖","confidence":0.8,"coverageConfirmed":true}'), signal());
    expect(accepted.autoApplyCompressionReview({ id: acceptedReview.id, revision: 1 })).toMatchObject({ applied: true, reason: "applied-lossless-compression" });

    const rejected = automaticFixture();
    const rejectedReview = await rejected.reviewCompression({ entryIds: ["aging-0", "aging-1", "aging-2"], revision: 0 }, vi.fn().mockResolvedValue('{"verdict":"mergeable","summary":"同一计划的候选总结。","reason":"置信度不足","confidence":0.79,"coverageConfirmed":true}'), signal());
    expect(rejected.autoApplyCompressionReview({ id: rejectedReview.id, revision: 1 })).toMatchObject({ applied: false, reason: "low-confidence" });
    expect(rejected.view().compressionReviews[0].status).toBe("pending");
  });

  it("低置信、未确认覆盖和两条来源建议均留在待确认列表", async () => {
    for (const [confidence, coverageConfirmed] of [[0.79, true], [0.99, false]] as const) {
      const memory = automaticFixture();
      const review = await memory.reviewCompression({ entryIds: ["aging-0", "aging-1", "aging-2"], revision: 0 }, vi.fn().mockResolvedValue(JSON.stringify({ verdict: "mergeable", summary: "候选总结", reason: "仍需人工确认", confidence, coverageConfirmed })), signal());
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
    const review = await memory.reviewCompression({ entryIds: ["aging-0", "aging-1", "aging-2"], revision: 0 }, vi.fn().mockResolvedValue('{"verdict":"mergeable","summary":"候选总结","reason":"可合并","confidence":0.99,"coverageConfirmed":true}'), signal());
    memory.editEntry({ id: "aging-0", content: "已发生后续变化", pinned: false, status: "aging", revision: 1 });
    expect(() => memory.autoApplyCompressionReview({ id: review.id, revision: 2 })).toThrow("记忆已变化");
    expect(memory.view().compressionReviews[0].status).toBe("pending");
  });
});
