import * as path from "node:path";
import * as fs from "fs";
import { spawn } from "node:child_process";
import { app, BrowserWindow, globalShortcut, ipcMain, nativeImage } from "electron";
import { randomUUID } from "crypto";
import { IPC } from "../../shared/ipc-channels";
import { ElectronScreenshotHelperClient } from "./helper-client";
import { resolveScreenshotHelperPath } from "./helper-path";
import {
  createScreenshotService,
  validateScreenshotInsert,
  type ScreenshotInsertData,
  type ScreenshotService,
} from "./screenshot-service";

export type { ScreenshotService };

export interface ScreenshotLifecycleOptions {
  initialHotkey: string;
  getReactChatWindow: () => BrowserWindow | null;
  getMainWindow: () => BrowserWindow | null;
}

const MAX_SCREENSHOT_BYTES = 20 * 1024 * 1024;

function getScreenshotDirectory(): string {
  return path.join(app.getPath("userData"), "screenshots");
}

async function saveScreenshotPasteTemp(
  base64: string,
  _mime: string,
): Promise<{ filePath: string }> {
  const raw = Buffer.from(base64, "base64");
  if (raw.byteLength > MAX_SCREENSHOT_BYTES) {
    throw new Error("SCREENSHOT_TOO_LARGE");
  }
  const image = nativeImage.createFromBuffer(raw);
  if (image.isEmpty()) {
    throw new Error("INVALID_SCREENSHOT_IMAGE");
  }
  const screenshotDirectory = getScreenshotDirectory();
  await fs.promises.mkdir(screenshotDirectory, { recursive: true });
  const filePath = path.join(screenshotDirectory, `${randomUUID()}.png`);
  await fs.promises.writeFile(filePath, image.toPNG());
  return { filePath };
}

export function initializeScreenshotService(
  options: ScreenshotLifecycleOptions,
): ScreenshotService {
  const { getReactChatWindow, getMainWindow } = options;
  const screenshotDirectory = getScreenshotDirectory();

  const validateInsert = (data: ScreenshotInsertData): ScreenshotInsertData => {
    let previewImage: Electron.NativeImage | null = null;
    const validated = validateScreenshotInsert(
      data,
      screenshotDirectory,
      (filePath) => {
        previewImage = nativeImage.createFromPath(filePath);
        return previewImage;
      },
    );
    if (!validated) {
      throw new Error(`INVALID_SCREENSHOT_RESULT:${data.filePath}`);
    }
    // React 开发预览运行在 http://，Chromium 会拦截 file:// 图片。
    // 截图体积有限，直接回传 data URL，旧 Chat 与 React 都能稳定显示。
    return {
      ...validated,
      previewUrl: previewImage ? (previewImage as Electron.NativeImage).toDataURL() : validated.previewUrl,
    };
  };

  const client = new ElectronScreenshotHelperClient({
    spawnImpl: (command, args) =>
      spawn(command, args, {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      }),
    resolveHelperPath: () =>
      resolveScreenshotHelperPath({
        isPackaged: app.isPackaged,
        appPath: app.getAppPath(),
        resourcesPath: process.resourcesPath,
        envOverride: process.env.CYRENE_SCREENSHOT_HELPER_PATH,
      }),
    screenshotDirectory,
    logger: console,
  });

  const service = createScreenshotService({
    client,
    registerShortcut: (accelerator, callback) =>
      globalShortcut.register(accelerator, callback),
    unregisterShortcut: (accelerator) => globalShortcut.unregister(accelerator),
    sendInsert: (data) => {
      const validated = validateInsert(data);
      const reactChatWindow = getReactChatWindow();
      if (reactChatWindow && !reactChatWindow.isDestroyed()) {
        reactChatWindow.webContents.send(IPC.SCREENSHOT_INSERT, validated);
      }
    },
  });

  ipcMain.handle(IPC.SCREENSHOT_START, (event) =>
    service.startFromChatButton((data) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send(IPC.SCREENSHOT_INSERT, validateInsert(data));
      }
    }),
  );
  ipcMain.handle(IPC.SCREENSHOT_SAVE_TEMP, (_event, base64: string, mime: string) =>
    saveScreenshotPasteTemp(base64, mime),
  );
  ipcMain.handle(IPC.SCREENSHOT_HOTKEY_CAPTURE_START, () => {
    service.suspendHotkey();
    return true;
  });
  ipcMain.handle(IPC.SCREENSHOT_HOTKEY_CAPTURE_END, () => {
    service.resumeHotkey();
    return true;
  });

  ipcMain.handle("debug:screenshot", async () => {
    const mainWindow = getMainWindow();
    if (!mainWindow) return null;
    const image = await mainWindow.webContents.capturePage();
    const png = image.toPNG();
    const outPath = path.join(app.getPath("temp"), "cyrene-screenshot.png");
    fs.writeFileSync(outPath, png);
    return outPath;
  });

  service.init(options.initialHotkey);
  return service;
}
