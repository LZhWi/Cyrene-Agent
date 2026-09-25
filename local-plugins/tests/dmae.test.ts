import { describe, expect, it } from "vitest";
import type { PluginStorage } from "@playa0v0/cyrene-plugin-sdk";
import { createDmae } from "../plugins/companion-memory/src/dmae";

function storage() {
  const map = new Map<string, unknown>();
  const value: PluginStorage = { get: <T>(key: string) => structuredClone(map.get(key)) as T | undefined, set: (key, data) => { map.set(key, structuredClone(data)); }, rootDir: () => "unused" };
  return { value, map };
}
const entries = [
  { id: "topic", content: "近期话题", quote: "话题", sourceAt: 1, turnId: "t1", sessionId: "s", pinned: false, status: "active" as const },
  { id: "pinned", content: "固定信息", quote: "固定", sourceAt: 2, turnId: "t2", sessionId: "s", pinned: true, status: "active" as const },
  { id: "archived", content: "已归档", quote: "归档", sourceAt: 3, turnId: "t3", sessionId: "s", pinned: true, status: "archived" as const },
];

describe("插件私有 DMAE 工作记忆", () => {
  it("默认关闭且不写状态；启用后只在 apply 时持久化激活值", () => {
    const data = storage(), dmae = createDmae(data.value);
    expect(dmae.apply(["topic"], entries)).toEqual(["topic"]);
    expect(data.map.has("dmae-state")).toBe(false);
    dmae.set(true);
    expect(dmae.apply(["topic"], entries)).toEqual(["topic", "pinned"]);
    expect(dmae.view()).toMatchObject({ enabled: true, round: 1, tracked: 1, active: 1 });
    expect(data.map.get("dmae-state")).toMatchObject({ version: 1, round: 1, states: { topic: { activation: 36, userSilence: 0 } } });
  });

  it("短期驻留后按静默轮次衰减，归档条目即使置顶也不补位", () => {
    const dmae = createDmae(storage().value); dmae.set(true);
    dmae.apply(["topic"], entries);
    expect(dmae.apply([], entries)).toEqual(["pinned", "topic"]);
    expect(dmae.apply([], entries)).toEqual(["pinned", "topic"]);
    expect(dmae.apply([], entries)).toEqual(["pinned"]);
  });

  it("只读预览不推进轮次或写入状态", () => {
    const data = storage(), dmae = createDmae(data.value); dmae.set(true);
    const before = structuredClone(data.map.get("dmae-state"));
    expect(dmae.preview(["topic"], entries)).toMatchObject({ selectedIds: ["topic", "pinned"], round: 1, tracked: 1 });
    expect(data.map.get("dmae-state")).toEqual(before);
    expect(dmae.view()).toMatchObject({ round: 0, tracked: 0 });
  });

  it("常驻补位只记录实际注入轮次，不获得查询命中奖励", () => {
    const data = storage(), dmae = createDmae(data.value); dmae.set(true);
    dmae.apply(["topic"], entries);
    dmae.commit([], ["topic"], entries);
    expect(data.map.get("dmae-state")).toMatchObject({
      round: 2,
      states: { topic: { activation: 34.8, userSilence: 1, modelSilence: 1, lastInjectedRound: 2 } },
    });
  });

  it("待复核冲突项不作为常驻补位，但真实查询命中仍可带警告注入", () => {
    const dmae = createDmae(storage().value); dmae.set(true);
    dmae.apply(["topic"], entries);
    expect(dmae.preview([], entries, new Set(["topic"])).selectedIds).toEqual(["pinned"]);
    expect(dmae.preview(["topic"], entries, new Set(["topic"])).selectedIds).toEqual(["topic", "pinned"]);
  });
});
