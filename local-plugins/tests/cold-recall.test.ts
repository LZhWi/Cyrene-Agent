import { describe, expect, it } from "vitest";
import type { PluginStorage } from "@playa0v0/cyrene-plugin-sdk";
import { createMemory } from "../plugins/companion-memory/src/memory";
import { emptyProfiles } from "../plugins/companion-memory/src/profiles";

function fixture() {
  const now = Date.now();
  const entries = [
    { id: "hot", content: "用户最近在学习法语", quote: "我在学法语", sourceAt: now - 1_000, turnId: "t1", sessionId: "s", pinned: false, status: "active" as const },
    { id: "cold", content: "用户曾计划去京都看红叶", quote: "想去京都看红叶", sourceAt: now - 3_000, turnId: "t2", sessionId: "s", pinned: false, status: "archived" as const },
    { id: "expired", content: "用户曾计划去京都旅行", quote: "京都旅行", sourceAt: now - 4_000, validTo: now - 1, turnId: "t3", sessionId: "s", pinned: false, status: "archived" as const },
    { id: "superseded", content: "用户曾预订京都酒店", quote: "京都酒店", sourceAt: now - 5_000, supersededBy: "hot", turnId: "t4", sessionId: "s", pinned: false, status: "archived" as const },
  ];
  const initial = { version: 2, revision: 0, turns: [], processed: [], entries, evidence: [{ id: "ev", memoryId: "cold", quoteSnippet: "去年提到京都红叶", createdAt: now - 2_000, sourceStatus: "active" as const, provenance: "verified" as const }], profiles: emptyProfiles(), profileChanges: [], entryReviews: [], compressionReviews: [], lifecycleChanges: [] };
  const values = new Map<string, unknown>([["memory-state", structuredClone(initial)]]);
  const storage: PluginStorage = { get: <T>(key: string) => structuredClone(values.get(key)) as T | undefined, set: (key, value) => { values.set(key, structuredClone(value)); }, rootDir: () => "unused" };
  return { memory: createMemory(storage), values };
}

describe("人工确认的 archived 冷召回", () => {
  it("普通检索不足时只读展示有效归档候选及证据", () => {
    const { memory, values } = fixture(), before = structuredClone([...values.entries()]);
    const preview = memory.previewArchivedRecall({ query: "京都红叶" });
    expect(preview).toMatchObject({ memoryRevision: 0, reason: "archived-candidates", hotRelevantCount: 0 });
    expect(preview.candidates).toEqual([expect.objectContaining({ id: "cold", content: "用户曾计划去京都看红叶", lexicalScore: expect.any(Number) })]);
    expect(preview.candidates[0].evidence).toContain("去年提到京都红叶");
    expect(preview.candidates.map((candidate) => candidate.id)).not.toContain("expired");
    expect(preview.candidates.map((candidate) => candidate.id)).not.toContain("superseded");
    expect([...values.entries()]).toEqual(before);
  });

  it("普通 active/aging 已有明确命中时不开放归档候选", () => {
    const { memory } = fixture(), preview = memory.previewArchivedRecall({ query: "学习法语" });
    expect(preview.reason).toBe("ordinary-match-present");
    expect(preview.hotRelevantCount).toBeGreaterThan(0);
    expect(preview.candidates).toEqual([]);
  });

  it("只有绑定当前版本和候选哈希的用户选择才能恢复，且可严格撤销", () => {
    const { memory } = fixture(), preview = memory.previewArchivedRecall({ query: "京都红叶" });
    expect(() => memory.restoreArchivedRecall({ ...preview, token: "0".repeat(64), entryIds: ["cold"] })).toThrow("预检已过期");
    const applied = memory.restoreArchivedRecall({ memoryRevision: preview.memoryRevision, query: preview.query, token: preview.token, entryIds: ["cold"] });
    expect(applied.restored).toBe(1);
    expect(applied.entries.find((entry) => entry.id === "cold")?.status).toBe("active");
    expect(applied.lifecycleChanges.at(-1)).toMatchObject({ target: "active", status: "applied" });
    const undone = memory.undoLifecycleTransition({ id: applied.lifecycleChangeId, revision: applied.revision });
    expect(undone.entries.find((entry) => entry.id === "cold")?.status).toBe("archived");
    expect(undone.lifecycleChanges.at(-1)?.status).toBe("undone");
  });

  it("拒绝预检外条目、重复选择和记忆变化后的旧预检", () => {
    const { memory } = fixture(), preview = memory.previewArchivedRecall({ query: "京都红叶" });
    expect(() => memory.restoreArchivedRecall({ ...preview, entryIds: ["hot"] })).toThrow("不在当前冷召回候选");
    expect(() => memory.restoreArchivedRecall({ ...preview, entryIds: ["cold", "cold"] })).toThrow("参数无效");
    memory.editEntry({ id: "hot", content: "用户最近在系统学习法语", pinned: false, status: "active", revision: 0 });
    expect(() => memory.restoreArchivedRecall({ ...preview, entryIds: ["cold"] })).toThrow("记忆已发生变化");
  });
});
