import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { PluginContext, PluginStorage } from "@playa0v0/cyrene-plugin-sdk";
import { assertPluginStorageFile, resolvePluginStorageRoot } from "./boundary";

/** SDK 的 get 会把 JSON 损坏当成不存在；先检查，防止创建空库覆盖可恢复数据。 */
export function strictStorage(ctx: PluginContext): PluginStorage {
  const root = ctx.storage.rootDir();
  const realRoot = resolvePluginStorageRoot(root);
  return {
    rootDir: () => root,
    get<T>(key: string): T | undefined {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(key)) throw new Error("存储键无效");
      const file = path.join(root, `${key}.json`);
      assertPluginStorageFile(realRoot, file);
      if (existsSync(file)) {
        try { return JSON.parse(readFileSync(file, "utf8")) as T; }
        catch { throw new Error("插件存储损坏；已停止加载，不会覆盖原文件"); }
      }
      return ctx.storage.get<T>(key);
    },
    set<T>(key: string, value: T): void {
      if (ctx.signal.aborted) throw new Error("插件已停止，拒绝迟到写入");
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(key)) throw new Error("存储键无效");
      for (const suffix of [".json", ".json.tmp"]) {
        const file = path.join(root, key + suffix);
        assertPluginStorageFile(realRoot, file);
        if (suffix === ".json" && existsSync(file)) {
          try { JSON.parse(readFileSync(file, "utf8")); }
          catch { throw new Error("插件存储损坏；已停止保存，不会覆盖原文件"); }
        }
      }
      ctx.storage.set(key, value);
    },
  };
}

export function createWindow(ctx: PluginContext, directory: string, title: string) {
  let win: any;
  const close = () => { if (win && !win.isDestroyed()) win.destroy(); win = undefined; };
  ctx.onDispose(close);
  return {
    close,
    async open() {
      if (ctx.signal.aborted) return;
      if (win && !win.isDestroyed()) { win.show(); win.focus(); return; }
      const { BrowserWindow } = require("electron");
      win = new BrowserWindow({
        title, width: 1080, height: 780, minWidth: 760, minHeight: 560, autoHideMenuBar: true,
        webPreferences: { preload: path.join(directory, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true, partition: `companion-${ctx.id}` },
      });
      win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      win.webContents.on("will-navigate", (event: { preventDefault(): void }) => event.preventDefault());
      win.on("closed", () => { win = undefined; });
      await win.loadFile(path.join(directory, "ui.html"));
    },
  };
}

export function registerUi(ctx: PluginContext, handle: (action: string, data: any) => Promise<unknown>) {
  ctx.registerIpc("ui", async (action, data) => {
    if (ctx.signal.aborted) return { ok: false, error: "插件已停止" };
    if (typeof action !== "string") return { ok: false, error: "操作无效" };
    try { return { ok: true, data: await handle(action, data) }; }
    catch (e) { return { ok: false, error: e instanceof Error ? e.message : "操作失败" }; }
  });
}
