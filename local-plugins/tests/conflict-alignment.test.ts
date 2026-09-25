import { describe, expect, it } from "vitest";
import type { PluginStorage } from "@playa0v0/cyrene-plugin-sdk";
import { createMemory } from "../plugins/companion-memory/src/memory";
import { findPossibleConflictCandidate, hasCorrectionIntent, isExplicitGoalCompletion, scoreMemoryConflict } from "../plugins/companion-memory/src/conflict";
import { createRecentInjections } from "../plugins/companion-memory/src/recent-injections";
import { memoryCandidate } from "./support/memory-candidate";

function storage() {
  const map = new Map<string, unknown>();
  return { get: <T>(key: string) => structuredClone(map.get(key)) as T | undefined, set: (key: string, value: unknown) => { map.set(key, structuredClone(value)); }, rootDir: () => "unused" } satisfies PluginStorage;
}

async function fixture() {
  const memory = createMemory(storage());
  for (let i = 0; i < 10; i++) memory.ingest({ id: `t${i}`, sessionId: "s", user: i === 0 ? "我喜欢咖啡" : i === 1 ? "我现在不喜欢咖啡" : `闲聊${i}`, assistant: "好", userAt: i * 2 + 1, assistantAt: i * 2 + 2 });
  await memory.maintain(async () => JSON.stringify([
    memoryCandidate({ layer: "L2", field: undefined, summary: "用户喜欢咖啡", sourceQuote: "我喜欢咖啡", evidenceQuotes: ["我喜欢咖啡"], evidenceTurnRefs: ["T1"], facets: { primaryKind: "preference", retrievalKinds: ["preference"] } }),
    memoryCandidate({ layer: "L2", field: undefined, summary: "用户不喜欢咖啡", sourceQuote: "我现在不喜欢咖啡", evidenceQuotes: ["我现在不喜欢咖啡"], evidenceTurnRefs: ["T2"], facets: { primaryKind: "preference", retrievalKinds: ["preference"] } }),
  ]), new AbortController().signal);
  const [target, source] = memory.view().entries;
  return { memory, target, source };
}

describe("本地冲突链路对齐", () => {
  it("明确完成语句把 goal 识别为经历/事实状态迁移", () => {
    expect(isExplicitGoalCompletion("用户终于完成毕业论文", "终于完成了", "experience")).toBe(true);
    expect(isExplicitGoalCompletion("用户计划完成毕业论文", "准备完成", "goal")).toBe(false);
    expect(isExplicitGoalCompletion("用户完成情况不明", "可能完成", "fact")).toBe(false);
  });
  it("复刻共享主题、纠正意图和冲突评分阈值", () => {
    expect(findPossibleConflictCandidate("用户不喜欢咖啡", "用户喜欢咖啡")).toMatchObject({ isCandidate: true, confidence: 0.35 });
    expect(findPossibleConflictCandidate("用户不喜欢咖啡", "用户喜欢散步").isCandidate).toBe(false);
    expect(hasCorrectionIntent("你记错了，我现在不这样")).toBe(true);
    expect(scoreMemoryConflict({ ragScore: 0.8, correctionIntent: true, recentInjection: false, localContradiction: true, evidence: "both", activeTarget: true, impactScope: "medium" })).toMatchObject({ conflictScore: 76, resolverPriority: "high" });
    expect(scoreMemoryConflict({ ragScore: 0.8, localContradiction: true, evidence: "none", activeTarget: true, impactScope: "medium" }).resolverPriority).toBe("none");
  });

  it("普通候选把旧条目降为 aging 并退出 DMAE，且可严格撤销", async () => {
    const { memory, target, source } = await fixture();
    const applied = memory.applyDetectedConflict({ sourceId: source.id, targetId: target.id, action: "mark-candidate", revision: memory.view().revision });
    expect(applied.entries.find((entry) => entry.id === target.id)).toMatchObject({ status: "aging", conflictWith: [source.id] });
    expect(memory.dmaeExcludedEntryIds()).toContain(target.id);
    expect(memory.searchWithBudget("咖啡", [], [], [], [target.id], 24_000, false, "automatic").text).toContain("⚠️");
    const restored = memory.undoDetectedConflict({ id: applied.conflictChangeId, revision: memory.view().revision });
    expect(restored.entries.find((entry) => entry.id === target.id)).toEqual(target);
  });

  it("纠正快路径直接关闭旧事实有效期，同时保留可追溯撤销", async () => {
    const { memory, target, source } = await fixture();
    const applied = memory.applyDetectedConflict({ sourceId: source.id, targetId: target.id, action: "fast-supersede", revision: memory.view().revision });
    expect(applied.entries.find((entry) => entry.id === target.id)).toMatchObject({ status: "superseded", supersededBy: source.id, validTo: expect.any(Number) });
    expect(applied.conflictChanges.at(-1)).toMatchObject({ action: "fast-supersede", status: "applied", entries: [source, target] });
    const restored = memory.undoDetectedConflict({ id: applied.conflictChangeId, revision: memory.view().revision });
    expect(restored.entries.find((entry) => entry.id === target.id)).toEqual(target);
  });

  it("十分钟最近注入窗口与本地一致，并限制为最近 20 条", () => {
    let now = 1_000;
    const recent = createRecentInjections(() => now);
    recent.record(["a"]); expect(recent.has("a")).toBe(true);
    now += 10 * 60 * 1_000; expect(recent.has("a")).toBe(true);
    now += 1; expect(recent.has("a")).toBe(false);
    recent.record(Array.from({ length: 21 }, (_, i) => `m${i}`));
    expect(recent.has("m0")).toBe(true); expect(recent.has("m20")).toBe(false);
  });
});
