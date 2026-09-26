import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createMockPluginContext } from "@playa0v0/cyrene-plugin-sdk/testing";
import { createPluginStorage } from "../../src/plugins/storage";
import chatPlugin from "../plugins/companion-chat/src/index";
import { CHAT_ID } from "../plugins/shared/protocol";

it("真实插件注册拒绝损坏的 life-state 文件，并保持它和旧版迁移来源逐字不变", async () => {
  const parent = path.resolve(".test-runtime");
  mkdirSync(parent, { recursive: true });
  const parentReal = realpathSync(parent);
  const root = mkdtempSync(path.join(parent, "life-storage-"));
  const ctx = createMockPluginContext({ pluginId: CHAT_ID });
  try {
    const files = new Map([
      ["life-state.json", Buffer.from('{"version":2,"revision":3,"events":[', "utf8")],
      ["life-context-settings.json", Buffer.from(JSON.stringify({ version: 1, enabled: true, importantDates: [] }))],
      ["life-continuity.json", Buffer.from(JSON.stringify({ version: 1, cursorAt: new Date(2026, 8, 26, 7).getTime(), events: [] }))],
    ]);
    for (const [name, bytes] of files) writeFileSync(path.join(root, name), bytes);
    Object.assign(ctx.storage, createPluginStorage(root));
    const write = vi.spyOn(ctx.storage, "set");

    // 宿主会把坏 JSON 视为缺失；验证插件真实入口的 strictStorage 能拦住迁移回退。
    expect(ctx.storage.get("life-state")).toBeUndefined();
    await expect(Promise.resolve().then(() => chatPlugin.register(ctx))).rejects.toThrow("不会覆盖原文件");
    expect(write).not.toHaveBeenCalled();
    expect(ctx.ipcChannels.has("life-status")).toBe(false);
    expect(readdirSync(root).sort()).toEqual([...files.keys()].sort());
    for (const [name, bytes] of files) expect(readFileSync(path.join(root, name)).equals(bytes)).toBe(true);
  } finally {
    await ctx.dispose();
    if (path.dirname(realpathSync(root)) !== parentReal || !path.basename(root).startsWith("life-storage-")) {
      throw new Error("生活状态测试清理目录越界");
    }
    rmSync(root, { recursive: true, force: true });
  }
});
