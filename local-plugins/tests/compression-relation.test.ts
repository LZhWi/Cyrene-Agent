import { describe, expect, it, vi } from "vitest";
import type { PluginStorage } from "@playa0v0/cyrene-plugin-sdk";
import { createMemory } from "../plugins/companion-memory/src/memory";
import { emptyProfiles } from "../plugins/companion-memory/src/profiles";

function fixture(kind: "regular" | "dream") {
  const entries = ["全息装置随身携带", "全息装置是连接彼此的窗子", "会针线活，给小摆件织丝带"].map((content, i) => ({
    id: `e${i}`, content, quote: content, sourceAt: 100 + i * 100, turnId: `t${i}`, sessionId: "s",
    pinned: false, status: kind === "regular" ? "active" as const : "aging" as const, provenance: "verified" as const,
  }));
  const map = new Map<string, unknown>([["memory-state", { version: 2, revision: 0, turns: [], processed: [], entries,
    evidence: [], profiles: emptyProfiles(), profileChanges: [], entryReviews: [], compressionReviews: [] }]]);
  const storage: PluginStorage = { get: <T>(key: string) => structuredClone(map.get(key)) as T | undefined,
    set: (key, value) => { map.set(key, structuredClone(value)); }, rootDir: () => "unused" };
  return { memory: createMemory(storage), map, storage, raw: { kind, entryIds: entries.map(e => e.id), revision: 0 } };
}

describe.each(["dream", "regular"] as const)("%s 先审查事件关系", kind => {
  it.each(["unrelated", "uncertain"])("%s 不请求摘要，原样保留条目", async relation => {
    const { memory, raw } = fixture(kind), before = memory.view();
    const generate = vi.fn().mockResolvedValue(JSON.stringify({ relation, reason: "候选含不同事项" }));
    const review = await memory.reviewCompression(raw, generate, new AbortController().signal);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(review.verdict).toBe(relation === "unrelated" ? "different" : "uncertain");
    expect(memory.autoApplyCompressionReview({ id: review.id, revision: memory.view().revision }).applied).toBe(false);
    expect(memory.view().entries).toEqual(before.entries);
    expect(memory.view().evidence).toEqual(before.evidence);
  });

  it.each(["{}", "可以合并", '{"relation":"same_event","reason":""}'])("关系回复异常时不生成摘要、不写复核记录：%s", async response => {
    const { memory, raw } = fixture(kind), before = memory.view();
    const generate = vi.fn().mockResolvedValue(response);
    await expect(memory.reviewCompression(raw, generate, new AbortController().signal)).rejects.toThrow();
    expect(generate).toHaveBeenCalledTimes(1);
    expect(memory.view()).toEqual(before);
  });

  it.each(["same_event", "same_series"])("确认 %s 后才生成摘要，并保留时间范围", async relation => {
    const { memory, raw } = fixture(kind);
    const summary = kind === "regular" ? { shouldCompress: true, summary: "用户旅游去过 A、B、C。", reason: "同一旅游系列" }
      : { verdict: "mergeable", summary: "用户旅游去过 A、B、C。", reason: "同一旅游系列", confidence: 0.95, coverageConfirmed: true };
    const generate = vi.fn().mockResolvedValueOnce(JSON.stringify({ relation, reason: "全部属于同一具体系列" })).mockResolvedValueOnce(JSON.stringify(summary));
    const review = await memory.reviewCompression(raw, generate, new AbortController().signal);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[0][0]).toContain("同一系列");
    expect(generate.mock.calls[0][0]).toContain("sourceAt");
    expect(review).toMatchObject({ verdict: "mergeable", relation });
    expect(memory.autoApplyCompressionReview({ id: review.id, revision: memory.view().revision }).applied).toBe(true);
    expect(memory.view().entries.find(e => e.isSummary)).toMatchObject({ sourceAt: 100, sourceEndAt: 300 });
  });

  it.each(["error", "abort"])("关系审查%s时不改动记忆", async mode => {
    const { memory, raw } = fixture(kind), before = memory.view(), controller = new AbortController();
    const generate = vi.fn(async () => {
      if (mode === "error") throw new Error("判定失败");
      controller.abort();
      return '{"relation":"same_event","reason":"同一事项"}';
    });
    await expect(memory.reviewCompression(raw, generate, controller.signal)).rejects.toThrow();
    expect(generate).toHaveBeenCalledTimes(1);
    expect(memory.view()).toEqual(before);
  });

  it("旧自动压缩提案没有关系审查时不能自动应用", async () => {
    const { memory, raw, map, storage } = fixture(kind);
    const generate = vi.fn().mockResolvedValueOnce('{"relation":"same_event","reason":"同一事件"}')
      .mockResolvedValue(JSON.stringify(kind === "regular" ? { shouldCompress: true, summary: "候选总结", reason: "可合并" }
        : { verdict: "mergeable", summary: "候选总结", reason: "可合并", confidence: 0.99, coverageConfirmed: true }));
    const review = await memory.reviewCompression(raw, generate, new AbortController().signal);
    const oldState = memory.view();
    delete oldState.compressionReviews[0].relation;
    map.set("memory-state", oldState);
    const reopened = createMemory(storage);
    expect(reopened.autoApplyCompressionReview({ id: review.id, revision: oldState.revision }))
      .toMatchObject({ applied: false, reason: "relation-not-confirmed" });
  });
});
