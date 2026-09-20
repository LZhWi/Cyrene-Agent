import { describe, expect, it, vi } from "vitest";
import type { PluginStorage } from "@playa0v0/cyrene-plugin-sdk";
import { createMemory } from "../plugins/companion-memory/src/memory";
import { type Entry, isRecallable, validateEntry } from "../plugins/companion-memory/src/entries";
import { emptyProfiles } from "../plugins/companion-memory/src/profiles";
const base: Entry = { id: "e", content: "咖啡偏好", quote: "", sourceAt: 1, turnId: "t", sessionId: "s", pinned: true, status: "active" };
function fixture(entry: Entry, second?: Entry) {
  const state = { version: 2, revision: 0, turns: [], processed: [], entries: second ? [entry, second] : [entry], profiles: emptyProfiles() };
  const storage: PluginStorage = { get: () => structuredClone(state) as any, set: vi.fn(), rootDir: () => "unused" };
  return createMemory(storage);
}
describe("L2 状态与有效期", () => {
  it("有效期为起点包含、终点不包含，缺失为无界", () => {
    expect(isRecallable(base, 100)).toBe(true);
    expect(isRecallable({ ...base, validFrom: 100, validTo: 200 }, 99)).toBe(false);
    expect(isRecallable({ ...base, validFrom: 100, validTo: 200 }, 100)).toBe(true);
    expect(isRecallable({ ...base, validFrom: 100, validTo: 200 }, 199)).toBe(true);
    expect(isRecallable({ ...base, validFrom: 100, validTo: 200 }, 200)).toBe(false);
  });
  it.each(["archived", "superseded", "merged"] as const)("置顶不能使 %s 注入", (status) => {
    expect(fixture({ ...base, status }).search("咖啡")).toBe("");
  });
  it("aging 仍可检索；原文缺失明确提示，不伪造原话", () => {
    const result = fixture({ ...base, status: "aging" }).search("咖啡");
    expect(result).toContain("咖啡偏好"); expect(result).toContain("未保存逐字原话");
    expect(result).not.toContain("用户原话：");
  });
  it("恢复归档不清除有效期，编辑不能清除关系或复活终态", () => {
    const memory = fixture({ ...base, status: "archived", validTo: 2 });
    memory.editEntry({ ...base, validTo: undefined, revision: 0 });
    expect(memory.view().entries[0].validTo).toBe(2);
    expect(memory.search("咖啡")).toBe("");
    const terminal = fixture({ ...base, status: "superseded", supersededBy: "new" });
    expect(() => terminal.editEntry({ ...base, revision: 0 })).toThrow("关系");
    expect(fixture({ ...base, supersededBy: "new" }).search("咖啡")).toBe("");
    expect(fixture({ ...base, mergedInto: "new" }).search("咖啡")).toBe("");
  });
  it("无效时间、倒置区间、自引用与未知状态拒绝", () => {
    for (const patch of [{ validFrom: NaN }, { validTo: -1 }, { validFrom: 2, validTo: 1 }, { supersededBy: "e" }, { status: "unknown" }]) {
      expect(() => validateEntry({ ...base, ...patch })).toThrow();
    }
  });
  it("尚未生效或已过期的摘要不能发送复核模型", async () => {
    for (const bounds of [{ validTo: 1 }, { validFrom: Date.now() + 60000 }]) {
      const memory = fixture({ ...base, ...bounds }, { ...base, id: "second" });
      const generate = vi.fn(async () => "{}");
      await expect(memory.reviewEntries({ leftId: "e", rightId: "second", revision: 0 }, generate, new AbortController().signal)).rejects.toThrow("有效");
      expect(generate).not.toHaveBeenCalled();
    }
  });
});
