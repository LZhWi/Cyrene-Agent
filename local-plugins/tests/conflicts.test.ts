import { describe, expect, it, vi } from "vitest";
import type { PluginStorage } from "@playa0v0/cyrene-plugin-sdk";
import { createMemory } from "../plugins/companion-memory/src/memory";

function fixture() {
  const map = new Map<string, any>();
  const storage: PluginStorage = { get: (k) => structuredClone(map.get(k)), set: (k, v) => { map.set(k, structuredClone(v)); }, rootDir: () => "unused" };
  const memory = createMemory(storage);
  async function batch(start: number, name: string, layer = "L0") {
    for (let i = start; i < start + 10; i++) memory.ingest({ id: `t${i}`, sessionId: "s", user: `请叫我${name}`, assistant: "好的", userAt: i + 1, assistantAt: i + 2 });
    await memory.maintain(async () => JSON.stringify([{ layer, field: layer === "L0" ? "preferredName" : "currentProject", content: name, quote: `请叫我${name}`, turnId: `t${start}`, certainty: "explicit", attribution: "user_explicit" }]), new AbortController().signal);
  }
  return { memory, batch, storage, map };
}
describe("画像变更候选和证据保留", () => {
  it("不同表述保留旧值、保存两份证据和待确认提示；采用后仍保留记录", async () => {
    const { memory, batch, storage } = fixture(); await batch(0, "小林"); await batch(10, "小李");
    let state = memory.view();
    expect(state.profiles.l0.preferredName?.content).toBe("小林");
    expect(state.pending).toBe(0); expect(state.profileChanges).toHaveLength(1);
    const change = state.profileChanges[0];
    expect(change.before.quote).toBe("请叫我小林"); expect(change.after.quote).toBe("请叫我小李");
    expect(memory.search("你好")).toContain("画像变更待确认");
    memory.resolveProfileChange({ id: change.id, action: "accept", revision: state.revision });
    state = createMemory(storage).view();
    expect(state.profiles.l0.preferredName?.content).toBe("小李");
    expect(state.profileChanges[0]).toEqual({ ...change, status: "accepted" });
    expect(memory.search("你好")).not.toContain("画像变更待确认");
  });
  it("拒绝候选保留现值和记录；重复处理、过期 revision 均拒绝", async () => {
    const { memory, batch } = fixture(); await batch(0, "小林"); await batch(10, "小李");
    const state = memory.view(), raw = { id: state.profileChanges[0].id, action: "keep", revision: state.revision };
    expect(() => memory.resolveProfileChange({ ...raw, revision: 0 })).toThrow("刷新");
    memory.resolveProfileChange(raw);
    expect(memory.view().profiles.l0.preferredName?.content).toBe("小林");
    expect(memory.view().profileChanges[0].status).toBe("kept");
    expect(() => memory.resolveProfileChange({ ...raw, revision: memory.view().revision })).toThrow("无效");
  });
  it("锁定和手动编辑保护候选确认；过时记录仍可关闭", async () => {
    const { memory, batch } = fixture(); await batch(0, "小林"); await batch(10, "小李");
    const id = memory.view().profileChanges[0].id;
    memory.lockProfile({ locked: true, revision: memory.view().revision });
    expect(() => memory.resolveProfileChange({ id, action: "accept", revision: memory.view().revision })).toThrow("锁定");
    memory.lockProfile({ locked: false, revision: memory.view().revision });
    memory.editProfile({ layer: "L0", field: "preferredName", content: "手动", revision: memory.view().revision });
    expect(() => memory.resolveProfileChange({ id, action: "accept", revision: memory.view().revision })).toThrow("过时");
    memory.resolveProfileChange({ id, action: "keep", revision: memory.view().revision });
    expect(memory.view().profiles.l0.preferredName?.content).toBe("手动");
  });
  it("多个候选采用一个后另一个不能覆盖；标点规范化不制造变更", async () => {
    const { memory, batch } = fixture(); await batch(0, "小林"); await batch(10, "小林！");
    expect(memory.view().profileChanges).toEqual([]);
    await batch(20, "小李"); await batch(30, "小张");
    const [a, b] = memory.view().profileChanges;
    memory.resolveProfileChange({ id: a.id, action: "accept", revision: memory.view().revision });
    expect(() => memory.resolveProfileChange({ id: b.id, action: "accept", revision: memory.view().revision })).toThrow("过时");
  });
  it("L1 重复确认刷新来源时间；变更仍需确认", async () => {
    const { memory, batch } = fixture(); await batch(0, "项目甲", "L1"); await batch(10, "项目甲", "L1");
    expect(memory.view().profiles.l1.currentProject?.sourceAt).toBe(11);
    await batch(20, "项目乙", "L1");
    expect(memory.view().profiles.l1.currentProject?.content).toBe("项目甲");
    expect(memory.view().profileChanges[0].layer).toBe("L1");
  });
  it("旧 v2 缺少新增字段可只读加载，损坏记录拒绝；写入失败不改变决定", async () => {
    const { memory, batch, storage, map } = fixture(); await batch(0, "小林");
    const old = map.get("memory-state"); delete old.profileChanges;
    expect(createMemory(storage).view().profileChanges).toEqual([]);
    expect(map.get("memory-state")).not.toHaveProperty("profileChanges");
    await batch(10, "小李"); const before = memory.view();
    vi.spyOn(storage, "set").mockImplementationOnce(() => { throw new Error("磁盘失败"); });
    expect(() => memory.resolveProfileChange({ id: before.profileChanges[0].id, action: "accept", revision: before.revision })).toThrow("磁盘失败");
    expect(memory.view()).toEqual(before);
    map.set("memory-state", { ...map.get("memory-state"), profileChanges: [{}] });
    expect(() => createMemory(storage)).toThrow("损坏");
  });
});
