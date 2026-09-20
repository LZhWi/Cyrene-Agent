import { describe, expect, it } from "vitest";
import type { PluginStorage } from "@playa0v0/cyrene-plugin-sdk";
import { createDream } from "../plugins/companion-memory/src/dream";
import { createMaintenanceInbox } from "../plugins/companion-memory/src/maintenance-inbox";
import { createMemory } from "../plugins/companion-memory/src/memory";
import { emptyProfiles } from "../plugins/companion-memory/src/profiles";
import { createAutoCompression } from "../plugins/companion-memory/src/auto-compression";
import { createAutoDream } from "../plugins/companion-memory/src/auto-dream";
import { createAutoLifecycle } from "../plugins/companion-memory/src/auto-lifecycle";
import { createAutoReview } from "../plugins/companion-memory/src/auto-review";
import { createAutoReflection } from "../plugins/companion-memory/src/auto-reflection";
import type { PluginEvents } from "@playa0v0/cyrene-plugin-sdk";

function storage(initial: Array<[string, unknown]>) {
  const map = new Map<string, unknown>(initial), value: PluginStorage = { get: <T>(key: string) => structuredClone(map.get(key)) as T | undefined, set: (key, data) => { map.set(key, structuredClone(data)); }, rootDir: () => "unused" };
  return { map, value, before: structuredClone([...map.entries()]) };
}
const entry = { id: "a", content: "内容", quote: "原话", sourceAt: 1, turnId: "t", sessionId: "s", pinned: false, status: "aging" as const };

describe("插件私有状态损坏拒写", () => {
  it("拒绝没有已应用复核来源的梦境叙事", () => {
    const data = storage([["dream-state", { version: 1, revision: 0, narratives: [{ id: "n", text: "这是一段长度足够但没有有效复核来源关联的梦境叙事文本。", createdAt: 1, reviewId: "missing" }], reviews: [] }]]);
    expect(() => createDream(data.value)).toThrow("叙事关联损坏");
    expect([...data.map.entries()]).toEqual(data.before);
  });

  it("拒绝重复关系键或与两侧 ID 不一致的维护候选", () => {
    const item = { id: "i", key: `a\u0000b`, leftId: "a", rightId: "b", kind: "vector-similar", score: 0.9, leftHash: "0".repeat(64), rightHash: "1".repeat(64), createdAt: 1, status: "open" };
    const data = storage([["maintenance-inbox", { version: 1, revision: 0, items: [item, { ...item, id: "i2" }] }]]);
    expect(() => createMaintenanceInbox(data.value)).toThrow("收件箱损坏");
    expect([...data.map.entries()]).toEqual(data.before);
  });

  it("拒绝目标与原状态不一致的生命周期撤销快照", () => {
    const state = { version: 2, revision: 1, turns: [], processed: [], entries: [entry], evidence: [], profiles: emptyProfiles(), profileChanges: [], entryReviews: [], compressionReviews: [], lifecycleChanges: [{ id: "change", entries: [entry], target: "aging", status: "applied", createdAt: 1 }] };
    const data = storage([["memory-state", state]]);
    expect(() => createMemory(data.value)).toThrow("生命周期变更快照损坏");
    expect([...data.map.entries()]).toEqual(data.before);
  });

  it.each([
    ["后台复核", "auto-review-state", { version: 1, pendingTurns: 6, handledItemIds: [] }, (value: PluginStorage, events: PluginEvents) => createAutoReview(value, events, () => [], async () => undefined)],
    ["后台压缩", "auto-compression-state", { version: 1, pendingTurns: 0, handledCandidateIds: ["x", "x"] }, (value: PluginStorage, events: PluginEvents) => createAutoCompression(value, events, () => [], async () => undefined)],
    ["后台画像反思", "auto-reflection-state", { version: 1, pendingTurns: 21 }, (value: PluginStorage, events: PluginEvents) => createAutoReflection(value, events, async () => ({ suggested: 0 }))],
    ["后台生命周期", "auto-lifecycle-state", { version: 1, agingCandidates: -1, archivedCandidates: 0 }, (value: PluginStorage, events: PluginEvents) => createAutoLifecycle(value, events, () => ({ agingCandidates: 0, archivedCandidates: 0 }))],
    ["后台梦境", "auto-dream-state", { version: 1, lastActivityAt: -1 }, (value: PluginStorage, events: PluginEvents) => createAutoDream(value, events, () => [], async () => undefined)],
  ])("拒绝损坏的%s状态且不回写", (_name, key, invalid, create) => {
    const data = storage([[key, invalid]]);
    const events: PluginEvents = { on: () => () => undefined, emit: async () => undefined };
    expect(() => create(data.value, events)).toThrow("损坏");
    expect([...data.map.entries()]).toEqual(data.before);
  });

  it("拒绝损坏的自动生命周期执行开关且不回写", () => {
    const data = storage([["auto-lifecycle-apply-enabled", "yes"]]);
    const events: PluginEvents = { on: () => () => undefined, emit: async () => undefined };
    expect(() => createAutoLifecycle(data.value, events, () => ({ agingCandidates: 0, archivedCandidates: 0 }))).toThrow("执行设置损坏");
    expect([...data.map.entries()]).toEqual(data.before);
  });

  it("拒绝损坏的后台压缩自动应用开关且不回写", () => {
    const data = storage([["auto-compression-apply-enabled", "yes"]]);
    const events: PluginEvents = { on: () => () => undefined, emit: async () => undefined };
    expect(() => createAutoCompression(data.value, events, () => [], async () => undefined)).toThrow("自动应用设置损坏");
    expect([...data.map.entries()]).toEqual(data.before);
  });
});
