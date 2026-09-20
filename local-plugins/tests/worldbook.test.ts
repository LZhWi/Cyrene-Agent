import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PluginStorage } from "@playa0v0/cyrene-plugin-sdk";
import { createWorldbook, parseWorldbook } from "../plugins/companion-chat/src/worldbook";

function storage() {
  const values = new Map<string, unknown>();
  const api: PluginStorage = { get: key => structuredClone(values.get(key)) as never,
    set: (key, value) => { values.set(key, structuredClone(value)); }, rootDir: () => "unused" };
  return { api, values };
}

describe("插件私有 WorldBook", () => {
  const root = path.resolve("plugins/companion-chat/worldbook");
  const files = ["_glossary.md", "characters.md", "Cyrene.md", "story.md", "world.md"];

  it("解析本地条目元数据和正文", () => {
    const entries = parseWorldbook(readFileSync(path.join(root, "characters.md"), "utf8"), "characters.md");
    const phainon = entries.find(entry => entry.keywords.includes("白厄"));
    expect(entries).toHaveLength(17);
    expect(phainon).toMatchObject({ priority: 100, permanent: false, intrinsicValue: 80 });
    expect(phainon?.content).toContain("33550335次轮回");
  });

  it("预览不写状态，只有确认成功后提交；重复命中奖励受 V5.1 抑制", () => {
    const data = storage(), worldbook = createWorldbook(data.api, root);
    const first = worldbook.preview("run-1", "白厄是谁？", "");
    expect(first).toContain("【白厄 / Phainon】");
    expect(data.values.has("worldbook-state")).toBe(false);
    expect(worldbook.commit("run-1")).toBe(false);
    worldbook.preview("run-1", "白厄是谁？", "");
    expect(worldbook.accept("run-1")).toBe(true);
    expect(worldbook.commit("run-1")).toBe(true);
    const state1 = data.values.get("worldbook-state") as any;
    expect(state1.version).toBe(2); expect(state1.revision).toBe(1); expect(state1.turn).toBe(1);
    const id = Object.keys(state1.entries).find(key => key.includes("白厄"))!;
    const firstActivation = state1.entries[id].activation;
    worldbook.preview("run-2", "再说说白厄", ""); worldbook.accept("run-2"); worldbook.commit("run-2");
    const state2 = data.values.get("worldbook-state") as any;
    expect(state2.entries[id].activation - firstActivation).toBeLessThan(firstActivation);
    expect(state2.entries[id].recentUserHits).toEqual([1, 2]);
  });

  it("取消或过期预览不推进私有状态", () => {
    const data = storage(), worldbook = createWorldbook(data.api, root);
    worldbook.preview("cancelled", "白厄", ""); worldbook.discard("cancelled");
    expect(worldbook.commit("cancelled")).toBe(false);
    expect(data.values.has("worldbook-state")).toBe(false);
  });

  it("全部触发词同时命中时仍保留插件总预算余量", () => {
    const entries = files.flatMap((file) => parseWorldbook(readFileSync(path.join(root, file), "utf8"), file));
    const query = entries.flatMap((entry) => entry.keywords).join(" ");
    const block = createWorldbook(storage().api, root).preview(undefined, query, "");
    expect(block.length).toBeLessThan(8_000);
  });
});
