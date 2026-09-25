import { describe, expect, it, vi } from "vitest";
import type { PluginStorage } from "@playa0v0/cyrene-plugin-sdk";
import { createMemory } from "../plugins/companion-memory/src/memory";
import { memoryCandidate } from "./support/memory-candidate";

function fixture() {
  const map = new Map<string, any>();
  const storage: PluginStorage = {
    get: (key) => structuredClone(map.get(key)),
    set: (key, value) => { map.set(key, structuredClone(value)); },
    rootDir: () => "unused",
  };
  const memory = createMemory(storage);
  async function batch(start: number, name: string, layer: "L0" | "L1" = "L0") {
    for (let index = start; index < start + 10; index += 1) {
      memory.ingest({ id: `t${index}`, sessionId: "s", user: `请叫我${name}`, assistant: "好的", userAt: index + 1, assistantAt: index + 2 });
    }
    await memory.maintain(async () => JSON.stringify([memoryCandidate({
      layer,
      field: layer === "L0" ? "preferredName" : "currentProject",
      summary: name,
      stability: layer === "L0" ? "stable" : "situational",
      evidenceQuotes: [`请叫我${name}`],
      evidenceTurnRefs: [start === 0 ? "T1" : "T3"],
    })]), new AbortController().signal);
  }
  return { memory, batch, storage, map };
}

describe("画像自动更新、审计与撤销", () => {
  it("明确的新值默认自动采用，同时保留前后证据并允许撤销", async () => {
    const { memory, batch, storage } = fixture();
    await batch(0, "小林");
    await batch(10, "小李");
    let state = memory.view();
    expect(state.profiles.l0.preferredName?.content).toBe("小李");
    expect(state.profileChanges).toHaveLength(1);
    expect(state.profileChanges[0]).toMatchObject({ status: "accepted", before: { quote: "请叫我小林" }, after: { quote: "请叫我小李" } });
    memory.resolveProfileChange({ id: state.profileChanges[0].id, action: "undo-accept", revision: state.revision });
    state = createMemory(storage).view();
    expect(state.profiles.l0.preferredName?.content).toBe("小林");
    expect(state.profileChanges[0].status).toBe("undone");
  });

  it("过期 revision 和重复撤销均拒绝", async () => {
    const { memory, batch } = fixture();
    await batch(0, "小林");
    await batch(10, "小李");
    const change = memory.view().profileChanges[0];
    expect(() => memory.resolveProfileChange({ id: change.id, action: "undo-accept", revision: 0 })).toThrow("刷新");
    memory.resolveProfileChange({ id: change.id, action: "undo-accept", revision: memory.view().revision });
    expect(() => memory.resolveProfileChange({ id: change.id, action: "undo-accept", revision: memory.view().revision })).toThrow("无效");
  });

  it("锁定 L0 阻止自动更新；标点规范化不制造变更", async () => {
    const locked = fixture();
    locked.memory.lockProfile({ locked: true, revision: 0 });
    await locked.batch(0, "小林");
    expect(locked.memory.view().profiles.l0).toEqual({});
    const normal = fixture();
    await normal.batch(0, "小林");
    await normal.batch(10, "小林！");
    expect(normal.memory.view().profileChanges).toEqual([]);
  });

  it("L1 重复确认刷新来源时间，变化自动采用并可撤销", async () => {
    const { memory, batch } = fixture();
    await batch(0, "项目甲", "L1");
    await batch(10, "项目甲", "L1");
    expect(memory.view().profiles.l1.currentProject?.sourceAt).toBe(11);
    await batch(20, "项目乙", "L1");
    const state = memory.view();
    expect(state.profiles.l1.currentProject?.content).toBe("项目乙");
    expect(state.profileChanges[0]).toMatchObject({ layer: "L1", status: "accepted" });
  });

  it("旧 v2 缺少新增字段可只读加载，损坏记录拒绝；写入失败不改变决定", async () => {
    const { memory, batch, storage, map } = fixture();
    await batch(0, "小林");
    const old = map.get("memory-state");
    delete old.profileChanges;
    expect(createMemory(storage).view().profileChanges).toEqual([]);
    expect(map.get("memory-state")).not.toHaveProperty("profileChanges");
    await batch(10, "小李");
    const before = memory.view();
    vi.spyOn(storage, "set").mockImplementationOnce(() => { throw new Error("磁盘失败"); });
    expect(() => memory.resolveProfileChange({ id: before.profileChanges[0].id, action: "undo-accept", revision: before.revision })).toThrow("磁盘失败");
    expect(memory.view()).toEqual(before);
    map.set("memory-state", { ...map.get("memory-state"), profileChanges: [{}] });
    expect(() => createMemory(storage)).toThrow("损坏");
  });
});
