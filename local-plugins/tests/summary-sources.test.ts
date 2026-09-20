import { expect, it } from "vitest";
import { deriveSummarySources } from "../plugins/companion-memory/src/summary-sources";
import type { PluginStorage } from "@playa0v0/cyrene-plugin-sdk";
import { createMemory } from "../plugins/companion-memory/src/memory";
import { emptyProfiles } from "../plugins/companion-memory/src/profiles";
it("全部叶子定位后推导嵌套时间包络，不改输入", () => {
  const nodes = [{ id: "a" }, { id: "b" }, { id: "s", isSummary: true, subEntryIds: ["a", "b"] }, { id: "root", isSummary: true, subEntryIds: ["s", "a"] }];
  const before = JSON.stringify(nodes), ranges = new Map([["a", { start: 2, end: 3 }], ["b", { start: 8, end: 10 }]]);
  expect(deriveSummarySources(nodes, ranges).get("root")).toEqual({ status: "derived", range: { start: 2, end: 10 } });
  expect(JSON.stringify(nodes)).toBe(before); expect(ranges.size).toBe(2);
});
it("缺少子记忆与存在但未定位分别保留，已有总结时间不兜底", () => {
  const nodes = [{ id: "a" }, { id: "s", isSummary: true, subEntryIds: ["a"] }, { id: "missing", isSummary: true, subEntryIds: ["unknown"] }];
  const results = deriveSummarySources(nodes, new Map([["s", { start: 0, end: 1 }]]));
  expect(results.get("s")?.status).toBe("unresolved-child");
  expect(results.get("missing")?.status).toBe("missing-child");
});
it("循环、自引用、空子列表不产出时间", () => {
  const results = deriveSummarySources([{ id: "a", isSummary: true, subEntryIds: ["b"] }, { id: "b", isSummary: true, subEntryIds: ["a"] }, { id: "self", isSummary: true, subEntryIds: ["self"] }, { id: "empty", isSummary: true, subEntryIds: [] }], new Map());
  expect(results.get("a")?.status).toBe("cycle"); expect(results.get("b")?.status).toBe("cycle");
  expect(results.get("self")?.status).toBe("cycle"); expect(results.get("empty")?.status).toBe("empty-children");
});
it("重复子引用不扩大范围，重复记忆标识及非法范围拒绝", () => {
  expect(deriveSummarySources([{ id: "a" }, { id: "s", isSummary: true, subEntryIds: ["a", "a"] }], new Map([["a", { start: 5, end: 5 }]])).get("s")).toEqual({ status: "derived", range: { start: 5, end: 5 } });
  expect(() => deriveSummarySources([{ id: "a" }, { id: "a" }], new Map())).toThrow("重复");
  expect(() => deriveSummarySources([], new Map([["a", { start: 9, end: 1 }]]))).toThrow("范围");
});

it("叶子历史来源全部核验后，正式记忆库更新总结包络但不宣称语义已验证", () => {
  const entries = [
    { id: "a", content: "开始", quote: "开始", triggerText: "开始", sourceAt: 1, turnId: "", sessionId: "", pinned: false, status: "active" as const, provenance: "legacy-unverified" as const },
    { id: "b", content: "结果", quote: "结果", triggerText: "结果", sourceAt: 2, turnId: "", sessionId: "", pinned: false, status: "active" as const, provenance: "legacy-unverified" as const },
    { id: "s", content: "总结", quote: "", sourceAt: 1, sourceEndAt: 2, turnId: "", sessionId: "", pinned: false, status: "active" as const, provenance: "legacy-unverified" as const, isSummary: true, subEntryIds: ["a", "b"] },
  ];
  const map = new Map<string, unknown>([["memory-state", { version: 2, revision: 0, turns: [], processed: [], entries, evidence: [], profiles: emptyProfiles(), profileChanges: [], entryReviews: [] }]]);
  const storage: PluginStorage = { get: <T>(key: string) => structuredClone(map.get(key)) as T | undefined, set: (key, value) => { map.set(key, structuredClone(value)); }, rootDir: () => "unused" };
  const memory = createMemory(storage);
  memory.bindHistoricalSources({ revision: 0, bindings: [
    { entryId: "a", conversationId: "c", messageId: "ma", text: "开始", at: 100 },
    { entryId: "b", conversationId: "c", messageId: "mb", text: "结果", at: 300 },
  ] });
  expect(memory.view().entries.find((entry) => entry.id === "s")).toMatchObject({ sourceAt: 100, sourceEndAt: 300, provenance: "derived-source-verified" });
  expect(memory.search("总结")).toContain("子记忆来源时间已核对，但总结语义仍需");
  expect(() => memory.bindHistoricalSources({ revision: 1, bindings: [{ entryId: "s", conversationId: "c", messageId: "ms", text: "总结", at: 400 }] })).toThrow("压缩摘要");
});
