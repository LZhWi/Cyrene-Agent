import path from "node:path";
import type { PluginContext } from "@playa0v0/cyrene-plugin-sdk";

export function createPanel(ctx: PluginContext, directory: string) {
  let window: import("electron").BrowserWindow | undefined;
  ctx.onDispose(() => { window?.destroy(); window = undefined; });
  return {
    async open() {
      ctx.signal.throwIfAborted();
      if (window && !window.isDestroyed()) { window.show(); window.focus(); return; }
      const { BrowserWindow } = require("electron") as typeof import("electron");
      window = new BrowserWindow({
        title: "Furina 文件工具", width: 880, height: 820, minWidth: 640, minHeight: 580, autoHideMenuBar: true,
        webPreferences: { preload: path.join(directory, "preload.cjs"), nodeIntegration: false, contextIsolation: true, sandbox: true, partition: `furina-${ctx.id}` },
      });
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", (event) => event.preventDefault());
      window.on("closed", () => { window = undefined; });
      await window.loadFile(path.join(directory, "ui.html"));
    },
    async pickWorkspace() {
      const { dialog } = require("electron") as typeof import("electron");
      const options: import("electron").OpenDialogOptions = { title: "选择文件处理工作区", properties: ["openDirectory"] };
      const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
      return result.canceled ? undefined : result.filePaths[0];
    },
    async pickFiles(root: string, kind: "pdf" | "html" | "image", multiple: boolean) {
      const { dialog } = require("electron") as typeof import("electron");
      const options: import("electron").OpenDialogOptions = {
        title: "选择工作区内的文件", defaultPath: root, properties: multiple ? ["openFile", "multiSelections"] : ["openFile"],
        filters: [{ name: kind === "pdf" ? "PDF" : kind === "html" ? "HTML" : "图片", extensions: kind === "pdf" ? ["pdf"] : kind === "html" ? ["html", "htm"] : ["png", "jpg", "jpeg", "webp", "bmp", "tif", "tiff", "gif", "ico"] }],
      };
      const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
      return result.canceled ? undefined : result.filePaths;
    },
    showFile(file: string) {
      const { shell } = require("electron") as typeof import("electron");
      shell.showItemInFolder(file);
    },
  };
}
