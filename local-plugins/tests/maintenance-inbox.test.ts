import { describe, expect, it } from "vitest";
import type { PluginStorage } from "@playa0v0/cyrene-plugin-sdk";
import { createMaintenanceInbox } from "../plugins/companion-memory/src/maintenance-inbox";

function fixture() {
  const map = new Map<string, unknown>(), storage: PluginStorage = { get: <T>(key: string) => structuredClone(map.get(key)) as T | undefined, set: (key, value) => { map.set(key, structuredClone(value)); }, rootDir: () => "unused" };
  const entries = [
    { id: "a", content: "用户喜欢猫。", quote: "猫", sourceAt: 1, turnId: "a", sessionId: "s", pinned: false, status: "active" as const },
    { id: "b", content: "用户 喜欢 猫", quote: "猫", sourceAt: 2, turnId: "b", sessionId: "s", pinned: false, status: "aging" as const },
    { id: "c", content: "用户喜欢狗", quote: "狗", sourceAt: 3, turnId: "c", sessionId: "s", pinned: false, status: "active" as const },
    { id: "archived", content: "用户喜欢猫", quote: "猫", sourceAt: 4, turnId: "d", sessionId: "s", pinned: false, status: "archived" as const },
  ];
  return { inbox: createMaintenanceInbox(storage), entries, map };
}

describe("维护候选收件箱", () => {
  it("预检纯只读，合并规范化重复和向量相似但不下结论", () => {
    const { inbox, entries, map } = fixture(), before = structuredClone([...map.entries()]);
    const preview = inbox.preview(entries, [{ leftId: "a", rightId: "c", score: 0.9 }, { leftId: "a", rightId: "archived", score: 0.99 }]);
    expect(preview.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ leftId: "a", rightId: "b", kind: "normalized-duplicate" }),
      expect.objectContaining({ leftId: "a", rightId: "c", kind: "vector-similar", score: 0.9 }),
    ]));
    expect(preview.candidates.some((item) => item.rightId === "archived")).toBe(false);
    expect([...map.entries()]).toEqual(before);
  });

  it("确认后只保存候选；摘要变化标记失效，关闭不改 L2", () => {
    const { inbox, entries, map } = fixture(), preview = inbox.preview(entries, []), beforeEntries = structuredClone(entries);
    const saved = inbox.add({ ...preview, keys: [preview.candidates[0].key] }, entries, []);
    expect(saved.items[0]).toMatchObject({ status: "open", stale: false });
    expect(entries).toEqual(beforeEntries); expect(map.has("maintenance-inbox")).toBe(true);
    expect(inbox.view([{ ...entries[0], content: "已改变" }, ...entries.slice(1)]).items[0].stale).toBe(true);
    inbox.dismiss({ id: saved.items[0].id }, entries);
    expect(inbox.view(entries).items[0].status).toBe("dismissed"); expect(entries).toEqual(beforeEntries);
    const afterDismiss = structuredClone([...map.entries()]);
    expect(inbox.preview(entries, []).candidates).toEqual([]);
    expect([...map.entries()]).toEqual(afterDismiss);
  });

  it("候选集合变化或伪造选择会关闭旧预检", () => {
    const { inbox, entries } = fixture(), preview = inbox.preview(entries, []);
    expect(() => inbox.add({ ...preview, keys: ["fake"] }, entries, [])).toThrow("已失效");
    expect(() => inbox.add({ ...preview, keys: [preview.candidates[0].key] }, [{ ...entries[0], content: "已变化" }, ...entries.slice(1)], [])).toThrow("预检已过期");
  });

  it("自动收集仅写新增关系，重复运行保持零写入", () => {
    const { inbox, entries, map } = fixture();
    expect(inbox.addAutomatically(entries, [])).toBe(1);
    const before = structuredClone([...map.entries()]);
    expect(inbox.addAutomatically(entries, [])).toBe(0);
    expect([...map.entries()]).toEqual(before);
  });
});
