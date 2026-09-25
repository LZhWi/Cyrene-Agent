import { describe, expect, it } from "vitest";
import type { PluginStorage } from "@playa0v0/cyrene-plugin-sdk";
import { createLifecycle } from "../plugins/companion-memory/src/lifecycle";
import { createMemory } from "../plugins/companion-memory/src/memory";
import { emptyProfiles } from "../plugins/companion-memory/src/profiles";

const DAY_MS = 24 * 60 * 60 * 1000;
function fixture(now = 100 * DAY_MS) {
  const entries = [
    { id: "old", content: "较早的事项", quote: "旧", sourceAt: 1, turnId: "t1", sessionId: "s", pinned: false, status: "active" as const },
    { id: "recent", content: "近期事项", quote: "新", sourceAt: 90 * DAY_MS, turnId: "t2", sessionId: "s", pinned: false, status: "active" as const },
    { id: "pinned", content: "固定事项", quote: "固定", sourceAt: 1, turnId: "t3", sessionId: "s", pinned: true, status: "active" as const },
    { id: "aging", content: "已经淡出的事项", quote: "淡出", sourceAt: 1, turnId: "t4", sessionId: "s", pinned: false, status: "aging" as const },
  ];
  const map = new Map<string, unknown>([["memory-state", { version: 2, revision: 0, turns: [], processed: [], entries, evidence: [], profiles: emptyProfiles(), profileChanges: [], entryReviews: [], compressionReviews: [] }]]);
  const storage: PluginStorage = { get: <T>(key: string) => structuredClone(map.get(key)) as T | undefined, set: (key, value) => { map.set(key, structuredClone(value)); }, rootDir: () => "unused" };
  return { entries, map, storage, lifecycle: createLifecycle(storage, () => now), memory: createMemory(storage) };
}

describe("人工确认的 L2 生命周期", () => {
  it("默认关闭且预检纯只读；按来源时间列出非置顶 active 候选", () => {
    const { lifecycle, entries, map } = fixture(), before = structuredClone([...map.entries()]);
    lifecycle.record(["old"], entries);
    const preview = lifecycle.preview(entries, { days: 30 });
    expect(preview.candidates).toEqual([expect.objectContaining({ id: "old", basis: "source-time", hitCount: 0 })]);
    expect([...map.entries()]).toEqual(before);
  });

  it("显式记忆工具即使未开启自动生命周期跟踪也记录 L2 访问", () => {
    const { lifecycle, entries, map } = fixture();
    lifecycle.record(["old"], entries, true);
    expect((map.get("lifecycle-state") as any).recalls.old).toMatchObject({ hitCount: 1, weight: 1 });
    expect(lifecycle.view().enabled).toBe(false);
  });

  it("启用后只记录调用方确认的实际注入，并以最后注入时间覆盖来源时间", () => {
    const { lifecycle, entries, map } = fixture(); lifecycle.set(true);
    lifecycle.record(["old", "missing", "old"], entries);
    expect(lifecycle.view()).toMatchObject({ enabled: true, revision: 1, tracked: 1 });
    expect((map.get("lifecycle-state") as any).recalls.old).toMatchObject({ lastHitAt: 100 * DAY_MS, hitCount: 1, weight: 1 });
    expect(lifecycle.preview(entries, { days: 30 }).candidates).toEqual([]);
  });

  it("aging 记忆真实召回达到本地权重阈值后恢复 active，并保留可撤销快照", () => {
    const data = fixture();
    data.map.set("lifecycle-state", { version: 1, revision: 0, recalls: { aging: { lastHitAt: 1, hitCount: 4, weight: 29 } } });
    const lifecycle = createLifecycle(data.storage, () => 100 * DAY_MS); lifecycle.set(true);
    const recall = lifecycle.record(["aging"], data.memory.view().entries);
    expect(recall).toEqual({ recordedIds: ["aging"], reactivateIds: ["aging"] });
    const changed = data.memory.reactivateLifecycleEntries({ entryIds: recall.reactivateIds, revision: data.memory.view().revision });
    expect(data.memory.view().entries.find((entry) => entry.id === "aging")?.status).toBe("active");
    expect(changed.reactivated).toBe(1);
    data.memory.undoLifecycleTransition({ id: changed.lifecycleChangeId, revision: data.memory.view().revision });
    expect(data.memory.view().entries.find((entry) => entry.id === "aging")?.status).toBe("aging");
  });

  it("只有匹配当前预检的选择才能由记忆事务标为 aging", () => {
    const { lifecycle, memory } = fixture();
    const preview = lifecycle.preview(memory.view().entries, { days: 30 });
    const transition = lifecycle.validateApply(memory.view().entries, { ...preview, entryIds: ["old"] });
    const result = memory.transitionLifecycleEntries({ ...transition, revision: 0 });
    expect(result.entries.find((entry) => entry.id === "old")?.status).toBe("aging");
    expect(result.entries.find((entry) => entry.id === "recent")?.status).toBe("active");
    expect(() => lifecycle.validateApply(result.entries, { ...preview, entryIds: ["old"] })).toThrow("预检已过期");
  });

  it("aging 需另一次 90 天预检和确认才能归档，正文与证据不删除", () => {
    const { lifecycle, memory } = fixture();
    const agingPreview = lifecycle.preview(memory.view().entries, { days: 30, target: "aging" });
    memory.transitionLifecycleEntries({ ...lifecycle.validateApply(memory.view().entries, { ...agingPreview, entryIds: ["old"] }), revision: 0 });
    expect(() => lifecycle.preview(memory.view().entries, { days: 89, target: "archived" })).toThrow("90 至 3650");
    const archivePreview = lifecycle.preview(memory.view().entries, { days: 90, target: "archived" });
    const before = memory.view().entries.find((entry) => entry.id === "old");
    const result = memory.transitionLifecycleEntries({ ...lifecycle.validateApply(memory.view().entries, { ...archivePreview, entryIds: ["old"] }), revision: 1 });
    expect(result.entries.find((entry) => entry.id === "old")).toEqual({ ...before, status: "archived" });
    const undone = memory.undoLifecycleTransition({ id: result.lifecycleChangeId, revision: 2 });
    expect(undone.entries.find((entry) => entry.id === "old")).toEqual(before);
    expect(undone.lifecycleChanges.at(-1)?.status).toBe("undone");
  });

  it("后续编辑会使生命周期撤销整体失效", () => {
    const { lifecycle, memory } = fixture(), preview = lifecycle.preview(memory.view().entries, { days: 30, target: "aging" });
    const changed = memory.transitionLifecycleEntries({ ...lifecycle.validateApply(memory.view().entries, { ...preview, entryIds: ["old"] }), revision: 0 });
    memory.editEntry({ id: "old", content: "用户后续修订", pinned: false, status: "aging", revision: 1 });
    expect(() => memory.undoLifecycleTransition({ id: changed.lifecycleChangeId, revision: 2 })).toThrow("记忆已变化");
  });

  it("注入记录变化使旧预检失效，置顶项不能绕过候选门禁", () => {
    const { lifecycle, entries } = fixture(); lifecycle.set(true);
    const preview = lifecycle.preview(entries, { days: 30 });
    lifecycle.record(["old"], entries);
    expect(() => lifecycle.validateApply(entries, { ...preview, entryIds: ["old"] })).toThrow("预检已过期");
    const fresh = lifecycle.preview(entries, { days: 30 });
    expect(() => lifecycle.validateApply(entries, { ...fresh, entryIds: ["pinned"] })).toThrow("不满足老化条件");
  });

  it("自动计划在一次写入中只降一级，并为两组分别保留可撤销快照", () => {
    const { memory } = fixture();
    const result = memory.transitionLifecyclePlan({ agingEntryIds: ["old"], archivedEntryIds: ["aging"], revision: memory.view().revision });
    expect(result).toMatchObject({ agingApplied: 1, archivedApplied: 1 });
    expect(memory.view().entries.find((entry) => entry.id === "old")?.status).toBe("aging");
    expect(memory.view().entries.find((entry) => entry.id === "aging")?.status).toBe("archived");
    expect(memory.view().lifecycleChanges.slice(-2).map((change) => change.target)).toEqual(["aging", "archived"]);
  });

  it("自动计划任一候选过期时整体拒绝，不留下部分变更", () => {
    const { memory, map } = fixture(), before = structuredClone([...map.entries()]);
    expect(() => memory.transitionLifecyclePlan({ agingEntryIds: ["old"], archivedEntryIds: ["pinned"], revision: memory.view().revision })).toThrow("候选已变化");
    expect([...map.entries()]).toEqual(before);
  });

  it("实际注入增加私有权重且每日最多衰减一次，不修改条目", () => {
    const { lifecycle, entries, map } = fixture(); lifecycle.set(true);
    lifecycle.record(["old"], entries); lifecycle.record(["old"], entries);
    const memoryBefore = structuredClone(map.get("memory-state"));
    expect((map.get("lifecycle-state") as any).recalls.old.weight).toBe(2);
    expect(lifecycle.decayWeights(entries)).toMatchObject({ changed: 1, lastDecayAt: 100 * DAY_MS });
    expect((map.get("lifecycle-state") as any).recalls.old.weight).toBe(1);
    expect(lifecycle.decayWeights(entries).changed).toBe(0);
    expect(map.get("memory-state")).toEqual(memoryBefore);
  });

  it("容量预检复现 300/800 与 weight×时近度排序，且完全只读", () => {
    const { lifecycle, map } = fixture(), before = structuredClone([...map.entries()]);
    const entries = [
      ...Array.from({ length: 302 }, (_, index) => ({ id: `a${index}`, content: `active ${index}`, quote: "", sourceAt: index + 1, turnId: `ta${index}`, sessionId: "s", pinned: false, status: "active" as const })),
      ...Array.from({ length: 500 }, (_, index) => ({ id: `g${index}`, content: `aging ${index}`, quote: "", sourceAt: index + 10_000, turnId: `tg${index}`, sessionId: "s", pinned: false, status: "aging" as const })),
    ];
    const preview = lifecycle.previewCapacity(entries);
    expect(preview).toMatchObject({ activeCap: 300, totalCap: 800, activeCount: 302, workingSetCount: 802 });
    expect(preview.toAging.map((entry) => entry.id)).toEqual(["a0", "a1"]);
    expect(preview.toArchive.map((entry) => entry.id)).toEqual(["a0", "a1"]);
    expect([...map.entries()]).toEqual(before);
  });

  it("容量计划绑定生命周期版本，并在注入权重变化后整体失效", () => {
    const data = fixture(); data.lifecycle.set(true);
    const entries = [
      ...Array.from({ length: 301 }, (_, index) => ({ id: `a${index}`, content: `active ${index}`, quote: "", sourceAt: index + 1, turnId: `ta${index}`, sessionId: "s", pinned: false, status: "active" as const })),
      ...Array.from({ length: 500 }, (_, index) => ({ id: `g${index}`, content: `aging ${index}`, quote: "", sourceAt: index + 10_000, turnId: `tg${index}`, sessionId: "s", pinned: false, status: "aging" as const })),
    ];
    const preview = data.lifecycle.previewCapacity(entries);
    data.lifecycle.record(["a0"], entries);
    expect(() => data.lifecycle.validateCapacity(entries, preview)).toThrow("容量预检已过期");
  });

  it("确认后的容量计划一次写入，重叠候选可按归档再老化的顺序完整撤销", () => {
    const data = fixture(), entries = [
      ...Array.from({ length: 302 }, (_, index) => ({ id: `a${index}`, content: `active ${index}`, quote: "", sourceAt: index + 1, turnId: `ta${index}`, sessionId: "s", pinned: false, status: "active" as const })),
      ...Array.from({ length: 500 }, (_, index) => ({ id: `g${index}`, content: `aging ${index}`, quote: "", sourceAt: index + 10_000, turnId: `tg${index}`, sessionId: "s", pinned: false, status: "aging" as const })),
    ];
    data.map.set("memory-state", { version: 2, revision: 0, turns: [], processed: [], entries, evidence: [], profiles: emptyProfiles(), profileChanges: [], entryReviews: [], compressionReviews: [], lifecycleChanges: [] });
    const memory = createMemory(data.storage), lifecycle = createLifecycle(data.storage, () => 100 * DAY_MS);
    const preview = lifecycle.previewCapacity(memory.view().entries), transition = lifecycle.validateCapacity(memory.view().entries, preview);
    expect(transition).toEqual({ agingEntryIds: ["a0", "a1"], archivedEntryIds: ["a0", "a1"] });
    const applied = memory.transitionCapacityPlan({ ...transition, revision: memory.view().revision });
    expect(applied).toMatchObject({ agingApplied: 2, archivedApplied: 2 });
    expect(memory.view().entries.filter((entry) => ["a0", "a1"].includes(entry.id)).map((entry) => entry.status)).toEqual(["archived", "archived"]);
    const [agingChangeId, archivedChangeId] = applied.lifecycleChangeIds;
    memory.undoLifecycleTransition({ id: archivedChangeId, revision: memory.view().revision });
    expect(memory.view().entries.filter((entry) => ["a0", "a1"].includes(entry.id)).map((entry) => entry.status)).toEqual(["aging", "aging"]);
    memory.undoLifecycleTransition({ id: agingChangeId, revision: memory.view().revision });
    expect(memory.view().entries.filter((entry) => ["a0", "a1"].includes(entry.id)).map((entry) => entry.status)).toEqual(["active", "active"]);
  });

  it("兼容没有 weight 的旧生命周期状态并按零权重预检", () => {
    const data = fixture();
    data.map.set("lifecycle-state", { version: 1, revision: 2, recalls: { old: { lastHitAt: 10, hitCount: 3 } } });
    const restored = createLifecycle(data.storage, () => 100 * DAY_MS);
    const overflow = [...data.entries, ...Array.from({ length: 298 }, (_, index) => ({ id: `extra-${index}`, content: "新记忆", quote: "", sourceAt: 99 * DAY_MS, turnId: `extra-turn-${index}`, sessionId: "s", pinned: false, status: "active" as const }))];
    expect(restored.previewCapacity(overflow).toAging.find((entry) => entry.id === "old")?.weight).toBe(0);
  });

  it("拒绝越界权重且不回写旧状态", () => {
    const data = fixture();
    data.map.set("lifecycle-state", { version: 1, revision: 2, recalls: { old: { lastHitAt: 10, hitCount: 3, weight: 101 } } });
    const before = structuredClone([...data.map.entries()]);
    expect(() => createLifecycle(data.storage, () => 100 * DAY_MS)).toThrow("生命周期状态损坏");
    expect([...data.map.entries()]).toEqual(before);
  });
});
