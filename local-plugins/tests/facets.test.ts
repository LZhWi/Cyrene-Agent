import { expect, it } from "vitest";
import type { PluginStorage } from "@playa0v0/cyrene-plugin-sdk";
import { createMemory } from "../plugins/companion-memory/src/memory";
import { inferQueryKind, isFacetListQuery, normalizeStoredFacets, resolveRetrievalPlan } from "../plugins/companion-memory/src/facets";
import { emptyProfiles } from "../plugins/companion-memory/src/profiles";

const modelFacet = (kind: "commitment" | "preference") => ({ primaryKind: kind, retrievalKinds: [kind], source: "model" as const, pendingClassification: false });
const state = (entries: any[]) => ({ version: 2, revision: 0, turns: [], processed: [], entries, evidence: [], profiles: emptyProfiles(), profileChanges: [], entryReviews: [] });
const storage = (value: any): PluginStorage => ({ get: (key) => key === "memory-state" ? structuredClone(value) : undefined, set() {}, rootDir: () => "unused" });
const entry = (id: string, content: string, facets: any) => ({ id, content, quote: "", sourceAt: Number(id.slice(1)) || 1, turnId: "", sessionId: "", pinned: false, status: "active", facets });

it("严格规范化已存 facets，不接受未知分类或过多检索分类", () => {
  expect(normalizeStoredFacets(modelFacet("commitment"))).toEqual(modelFacet("commitment"));
  expect(normalizeStoredFacets(undefined)).toBeUndefined();
  expect(() => normalizeStoredFacets({ ...modelFacet("commitment"), primaryKind: "unknown" })).toThrow("facets");
  expect(() => normalizeStoredFacets({ ...modelFacet("commitment"), retrievalKinds: ["commitment", "goal", "wish", "fact"] })).toThrow("facets");
});

it("查询分类规则保守，只有清单意图才允许 facets 补充无词面命中项", () => {
  expect(inferQueryKind("我们有哪些承诺")).toBe("commitment");
  expect(isFacetListQuery("我们有哪些承诺")).toBe(true);
  expect(inferQueryKind("随便聊聊")).toBeUndefined();
  const memory = createMemory(storage(state([
    entry("e1", "以后一起看星星", modelFacet("commitment")),
    entry("e2", "下次带上礼物", modelFacet("commitment")),
    entry("e3", "平时爱喝乌龙茶", modelFacet("preference")),
  ])));
  const list = memory.search("我们有哪些承诺");
  expect(list).toContain("一起看星星"); expect(list).toContain("带上礼物"); expect(list).not.toContain("乌龙茶");
  expect(memory.search("承诺")).not.toContain("一起看星星");
});

it("检索计划复现本地 Top5、范围清单和穷举清单预算", () => {
  expect(resolveRetrievalPlan("聊聊猫咪")).toMatchObject({ scope: "normal", semanticResults: 5, maxResults: 5, characterBudget: 1800 });
  expect(resolveRetrievalPlan("我有哪些偏好", { needsExpansion: true, retrievalKinds: ["preference"], scope: "scoped_list", confidence: 0.8 })).toMatchObject({ scope: "scoped_list", semanticResults: 5, kindResults: 8, maxResults: 13, characterBudget: 3000, queryKind: "preference" });
  expect(resolveRetrievalPlan("列出我的所有偏好", { needsExpansion: true, retrievalKinds: ["preference"], scope: "exhaustive_list", confidence: 0.9 })).toMatchObject({ scope: "exhaustive_list", semanticResults: 5, kindResults: 15, maxResults: 20, characterBudget: 4000, queryKind: "preference" });
  expect(resolveRetrievalPlan("模糊指代", { needsExpansion: true, retrievalKinds: ["preference"], scope: "scoped_list", confidence: 0.49 })).toMatchObject({ scope: "normal", maxResults: 5, queryKinds: [] });
  expect(resolveRetrievalPlan("可能相关", { needsExpansion: true, retrievalKinds: ["preference"], scope: "exhaustive_list", confidence: 0.74 })).toMatchObject({ scope: "normal", maxResults: 10, queryKinds: ["preference"] });
});

it("非穷举分面补充复现本地相关性下限，穷举清单允许完整覆盖", () => {
  const entries = [
    entry("e1", "偏好语义锚点", modelFacet("preference")),
    ...Array.from({ length: 4 }, (_, index) => entry(`e${index + 2}`, `其他语义候选 ${index}`, modelFacet("commitment"))),
    entry("e6", "同主题仍相关的偏好", modelFacet("preference")),
    entry("e7", "过弱的偏好", modelFacet("preference")),
  ];
  const memory = createMemory(storage(state(entries))), ids = entries.map((item) => item.id);
  const scores = { e1: -2.2, e2: -2.3, e3: -2.4, e4: -2.5, e5: -2.6, e6: -3.8, e7: -4.3 };
  const scoped = resolveRetrievalPlan("我的偏好", { needsExpansion: true, retrievalKinds: ["preference"], scope: "scoped_list", confidence: 0.9 });
  const scopedIds = memory.searchWithBudget("我的偏好", [], ids, [], undefined, 24_000, false, "tool", scoped, scores).includedMemoryIds;
  expect(scopedIds).toContain("e6");
  expect(scopedIds).not.toContain("e7");
  const exhaustive = resolveRetrievalPlan("所有偏好", { needsExpansion: true, retrievalKinds: ["preference"], scope: "exhaustive_list", confidence: 0.9 });
  expect(memory.searchWithBudget("所有偏好", [], ids, [], undefined, 24_000, false, "tool", exhaustive, scores).includedMemoryIds).toContain("e7");
});

it("实际候选数量按本地计划选择 5、13、20 条", () => {
  const entries = Array.from({ length: 24 }, (_, index) => entry(
    `e${index + 1}`,
    `偏好记录 ${index + 1}`,
    modelFacet("preference"),
  ));
  const memory = createMemory(storage(state(entries)));
  const semanticIds = entries.map((item) => item.id);
  const semanticScores = Object.fromEntries(entries.map((item, index) => [item.id, -1 - index * 0.05]));
  expect(memory.searchWithBudget("普通话题", [], semanticIds, [], undefined, 24_000).includedMemoryIds).toHaveLength(5);
  expect(memory.searchWithBudget("我有哪些偏好", [], semanticIds, [], undefined, 24_000, false, "tool", resolveRetrievalPlan("我有哪些偏好", { needsExpansion: true, retrievalKinds: ["preference"], scope: "scoped_list", confidence: 0.8 }), semanticScores).includedMemoryIds).toHaveLength(13);
  expect(memory.searchWithBudget("列出我的所有偏好", [], semanticIds, [], undefined, 24_000, false, "tool", resolveRetrievalPlan("列出我的所有偏好", { needsExpansion: true, retrievalKinds: ["preference"], scope: "exhaustive_list", confidence: 0.9 })).includedMemoryIds).toHaveLength(20);
});

it("自动注入基础 Top 5 严格按宿主重排顺序，置顶不提前挤占", () => {
  const entries = Array.from({ length: 6 }, (_, index) => ({
    ...entry(`e${index + 1}`, `记录 ${index + 1}`, modelFacet("preference")),
    pinned: index === 5,
  }));
  const memory = createMemory(storage(state(entries)));
  expect(memory.injectionCandidateIds("普通查询", [], entries.map((item) => item.id))).toEqual(["e1", "e2", "e3", "e4", "e5"]);
});

it("损坏 facets 会让存储加载失败而不是静默降级", () => {
  expect(() => createMemory(storage(state([entry("e1", "x", { ...modelFacet("commitment"), source: "guess" })])))).toThrow("facets");
});
