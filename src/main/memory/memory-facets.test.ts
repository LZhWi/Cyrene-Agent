import { describe, expect, it } from "vitest";
import {
  inferQueryKindByRules,
  normalizeMemoryFacets,
  repairStoredMemoryFacets,
  resolveRetrievalPlan,
  selectDynamicMemoryItems,
  selectFacetAwareItems,
  type MemoryKind,
} from "./memory-facets";

const modelFacet = (primaryKind: MemoryKind, retrievalKinds: MemoryKind[] = [primaryKind]) => ({
  primaryKind,
  retrievalKinds,
  source: "model" as const,
  pendingClassification: false,
});

describe("memory kind routing", () => {
  it("distinguishes wishes from commitments and goals", () => {
    expect(inferQueryKindByRules("我们共同期待以后能一起看海")).toBe("wish");
    expect(inferQueryKindByRules("我答应明年陪你看海")).toBe("commitment");
    expect(inferQueryKindByRules("我的目标是明年学会游泳")).toBe("goal");
  });

  it("routes only explicit emotion language to emotion", () => {
    expect(inferQueryKindByRules("我当时明确说自己很难过")).toBe("emotion");
    expect(inferQueryKindByRules("那件事情对我意味着什么")).toBeUndefined();
  });

  it("normalizes a unique primary kind plus at most three fixed retrieval kinds", () => {
    expect(normalizeMemoryFacets({
      primaryKind: "goal",
      retrievalKinds: ["commitment", "goal", "wish", "fact", "invented"],
      topics: ["爱好|运动|篮球"],
      entities: ["昔涟"],
    }, "用户计划并承诺以后一起看海")).toEqual(modelFacet("goal", ["goal", "commitment", "wish"]));
    expect(normalizeMemoryFacets({ primaryKind: "other", retrievalKinds: ["other", "fact"] }, "普通信息"))
      .toEqual(modelFacet("fact"));
  });

  it("migrates the legacy single kind without changing its meaning", () => {
    expect(repairStoredMemoryFacets({
      kind: "preference",
      source: "model",
      pendingClassification: false,
    }, "用户喜欢打篮球")).toEqual(modelFacet("preference"));
  });

  it("marks unclassified stored data pending instead of locally labelling it", () => {
    expect(repairStoredMemoryFacets(undefined, "我答应给你做礼物")).toEqual({
      primaryKind: "other",
      retrievalKinds: ["other"],
      source: "pending",
      pendingClassification: true,
    });
  });

  it("expands only explicit list intents", () => {
    expect(resolveRetrievalPlan("我问其他人这个电影怎么样，他们都说好看")).toMatchObject({
      semanticResults: 5, kindResults: 0, maxResults: 5, queryKinds: [],
    });
    expect(resolveRetrievalPlan("我们说好的礼物", {
      needsExpansion: true,
      retrievalKinds: ["commitment", "wish"],
      scope: "scoped_list",
    })).toMatchObject({
      scope: "scoped_list", kindResults: 8, maxResults: 13, queryKinds: ["commitment", "wish"],
    });
  });

  it("uses router confidence to fail closed or cap uncertain expansion", () => {
    expect(resolveRetrievalPlan("模糊地提到以前", {
      needsExpansion: true,
      retrievalKinds: ["experience"],
      scope: "exhaustive_list",
      confidence: 0.49,
    })).toMatchObject({ scope: "normal", kindResults: 0, maxResults: 5, queryKinds: [] });

    expect(resolveRetrievalPlan("可能在指以前的经历", {
      needsExpansion: true,
      retrievalKinds: ["experience"],
      scope: "exhaustive_list",
      confidence: 0.6,
    })).toMatchObject({ scope: "normal", kindResults: 5, maxResults: 10, queryKinds: ["experience"] });

    expect(resolveRetrievalPlan("明确要求完整回忆", {
      needsExpansion: true,
      retrievalKinds: ["experience"],
      scope: "exhaustive_list",
      confidence: 0.9,
    })).toMatchObject({ scope: "exhaustive_list", kindResults: 15, maxResults: 20 });
  });

  it("preserves semantic Top5 and appends memories whose secondary retrieval kind matches", () => {
    const items = [
      { id: "semantic", text: "曾经说好以后一起看星星", facets: undefined },
      ...Array.from({ length: 4 }, (_, index) => ({ id: `base-${index}`, text: `语义候选${index}`, facets: undefined })),
      { id: "basketball", text: "用户喜欢篮球", facets: modelFacet("preference") },
      { id: "gift", text: "用户计划并答应亲手做礼物", facets: modelFacet("goal", ["goal", "commitment"]) },
    ];
    const selected = selectFacetAwareItems(items, resolveRetrievalPlan("我们所有约定都有哪些", {
      needsExpansion: true,
      retrievalKinds: ["commitment"],
      scope: "exhaustive_list",
    }), {
      getText: (item) => item.text,
      getFacets: (item) => item.facets,
    });
    expect(selected.slice(0, 5).map((item) => item.id)).toEqual(["semantic", "base-0", "base-1", "base-2", "base-3"]);
    expect(selected.map((item) => item.id)).toContain("gift");
    expect(selected.map((item) => item.id)).not.toContain("basketball");
  });

  it("keeps semantic Top5 but rejects weak tag supplements below the reranker threshold", () => {
    const items = [
      { id: "semantic-0", text: "高相关约定", score: -0.5, facets: modelFacet("commitment") },
      ...Array.from({ length: 4 }, (_, index) => ({
        id: `semantic-${index + 1}`, text: `语义候选${index + 1}`, score: -1 - index, facets: undefined,
      })),
      { id: "weak-tag", text: "弱相关约定", score: -3.79, facets: modelFacet("commitment") },
      { id: "relevant-tag", text: "相关约定", score: -2.4, facets: modelFacet("commitment") },
    ];
    const selected = selectFacetAwareItems(items, resolveRetrievalPlan("我们说好的礼物", {
      needsExpansion: true,
      retrievalKinds: ["commitment"],
      scope: "scoped_list",
    }), {
      getText: (item) => item.text,
      getFacets: (item) => item.facets,
      getFacetScore: (item) => item.score,
    });

    expect(selected.slice(0, 5).map((item) => item.id)).toEqual([
      "semantic-0", "semantic-1", "semantic-2", "semantic-3", "semantic-4",
    ]);
    expect(selected.map((item) => item.id)).toContain("relevant-tag");
    expect(selected.map((item) => item.id)).not.toContain("weak-tag");
  });

  it("relaxes the tag threshold when the best same-kind semantic result also scores low", () => {
    const items = [
      { id: "anchor", text: "相关经历锚点", score: -2.14, facets: modelFacet("experience") },
      ...Array.from({ length: 4 }, (_, index) => ({
        id: `semantic-${index}`, text: `其他语义候选${index}`, score: -2.2 - index * 0.1, facets: undefined,
      })),
      { id: "relative-match", text: "同话题的另一段经历", score: -3.8, facets: modelFacet("experience") },
      { id: "too-weak", text: "明显更弱的经历", score: -4.3, facets: modelFacet("experience") },
    ];
    const selected = selectFacetAwareItems(items, resolveRetrievalPlan("对了，我一直在想你前天测试画画功能时和我描述的那个画面欸，感觉真的好浪漫……", {
      needsExpansion: true,
      retrievalKinds: ["experience"],
      scope: "scoped_list",
    }), {
      getText: (item) => item.text,
      getFacets: (item) => item.facets,
      getFacetScore: (item) => item.score,
    });

    expect(selected.map((item) => item.id)).toContain("relative-match");
    expect(selected.map((item) => item.id)).not.toContain("too-weak");
  });

  it("does not apply the tag score floor to an explicit exhaustive list", () => {
    const items = [
      ...Array.from({ length: 5 }, (_, index) => ({
        id: `semantic-${index}`, text: `语义候选${index}`, score: 1 - index, facets: undefined,
      })),
      { id: "weak-tag", text: "较弱但属于完整清单的约定", score: -8, facets: modelFacet("commitment") },
    ];
    const selected = selectFacetAwareItems(items, resolveRetrievalPlan("列出所有约定", {
      needsExpansion: true,
      retrievalKinds: ["commitment"],
      scope: "exhaustive_list",
    }), {
      getText: (item) => item.text,
      getFacets: (item) => item.facets,
      getFacetScore: (item) => item.score,
    });

    expect(selected.map((item) => item.id)).toContain("weak-tag");
  });

  it("does not open the kind channel for an ambiguous query", () => {
    const items = Array.from({ length: 8 }, (_, index) => ({
      id: String(index), text: `候选 ${index}`, facets: modelFacet(index > 4 ? "fact" : "other"),
    }));
    expect(selectFacetAwareItems(items, resolveRetrievalPlan("还记得那件事吗"), {
      getText: (item) => item.text,
      getFacets: (item) => item.facets,
    })).toHaveLength(5);
  });

  it("continues after one weak result and stops after two consecutive weak results", () => {
    const items = [
      ...Array.from({ length: 5 }, (_, index) => ({ id: `base-${index}`, text: `base ${index}`, strong: true })),
      { id: "strong-1", text: "strong 1", strong: true },
      { id: "weak-1", text: "weak 1", strong: false },
      { id: "strong-2", text: "strong 2", strong: true },
      { id: "weak-2", text: "weak 2", strong: false },
      { id: "weak-3", text: "weak 3", strong: false },
      { id: "too-late", text: "strong after stop", strong: true },
    ];

    const result = selectDynamicMemoryItems(items, {
      getText: (item) => item.text,
      getKey: (item) => item.id,
      isStrong: (item) => item.strong,
    });

    expect(result.selected.map((item) => item.id)).toEqual([
      "base-0", "base-1", "base-2", "base-3", "base-4", "strong-1", "strong-2",
    ]);
    expect(result.stoppedBy).toBe("two_weak");
  });

  it("uses a relaxed 6000-character budget for dynamic L2 selection", () => {
    const items = [
      ...Array.from({ length: 5 }, (_, index) => ({ id: `base-${index}`, text: "基".repeat(1000), strong: true })),
      { id: "within-budget", text: "补".repeat(900), strong: true },
      { id: "over-budget", text: "超".repeat(200), strong: true },
    ];
    const result = selectDynamicMemoryItems(items, {
      getText: (item) => item.text,
      getKey: (item) => item.id,
      isStrong: (item) => item.strong,
    });

    expect(result.selected.map((item) => item.id)).toContain("within-budget");
    expect(result.selected.map((item) => item.id)).not.toContain("over-budget");
    expect(result.stoppedBy).toBe("character_budget");
  });
});
