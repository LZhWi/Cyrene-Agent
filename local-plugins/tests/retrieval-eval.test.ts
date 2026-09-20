import { describe, expect, it } from "vitest";
import type { PluginStorage } from "@playa0v0/cyrene-plugin-sdk";
import { createMemory } from "../plugins/companion-memory/src/memory";
import { emptyProfiles } from "../plugins/companion-memory/src/profiles";
import { evaluateRetrieval } from "./support/retrieval-eval";

function memoryFixture() {
  const entries = [
    { id: "tea", content: "用户偏爱清香型乌龙茶", quote: "我最常喝乌龙茶", sourceAt: 4, turnId: "t1", sessionId: "s", pinned: false, status: "active" as const },
    { id: "trip", content: "计划秋天去京都旅行", quote: "秋天想去京都", sourceAt: 3, turnId: "t2", sessionId: "s", pinned: false, status: "active" as const },
    { id: "run", content: "周末通常去公园慢跑", quote: "周末会跑步", sourceAt: 2, turnId: "t3", sessionId: "s", pinned: false, status: "active" as const },
    { id: "pinned-noise", content: "偏好深色界面", quote: "界面用深色", sourceAt: 1, turnId: "t4", sessionId: "s", pinned: true, status: "active" as const },
  ];
  const map = new Map<string, unknown>([["memory-state", { version: 2, revision: 0, turns: [], processed: [], entries, evidence: [], profiles: emptyProfiles(), profileChanges: [], entryReviews: [] }]]);
  const storage: PluginStorage = { get: <T>(key: string) => structuredClone(map.get(key)) as T | undefined, set: (key, value) => { map.set(key, structuredClone(value)); }, rootDir: () => "unused" };
  return createMemory(storage);
}

describe("合成召回评测基线", () => {
   it("量化当前词面与语义候选的混合排序，并显式保留置顶干扰边界", () => {
    const memory = memoryFixture();
    const report = evaluateRetrieval([
      { name: "词面饮品", relevantIds: ["tea"], result: memory.search("乌龙茶") },
      { name: "语义饮品", relevantIds: ["tea"], result: memory.search("平时喝什么饮品", [], ["tea"]) },
      { name: "语义旅行", relevantIds: ["trip"], result: memory.search("假期去哪座城市", [], ["trip"]) },
      { name: "置顶干扰", relevantIds: ["run"], result: memory.search("周末做什么运动", [], ["run"]) },
    ]);
    expect(report).toMatchObject({ cases: 4, hitAt1: 0, recallAtK: 1, mrr: 0.5 });
    expect(report.details.every((item) => item.order[0] === "pinned-noise")).toBe(true);
    expect(report.details.find((item) => item.name === "置顶干扰")).toMatchObject({ order: ["pinned-noise", "run"], firstRelevantRank: 2 });
  });
});
