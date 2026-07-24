/**
 * 截图管理器 -- 截全屏 -> 覆盖窗选区 -> nativeImage.crop -> 剪贴板。
 *
 * 整合 GPT review 修正：
 * - 按真实截图尺寸/覆盖窗 CSS 尺寸比例裁剪（不依赖 scaleFactor）
 * - display_id 匹配主屏
 * - 单例会话防并发
 * - 覆盖窗不透明 + rendered 握手防闪屏
 * - 按钮模式主进程直接写临时文件
 * - sender 校验
 * - 热键事务式切换+回滚
 */

import {
  app,
  BrowserWindow,
  desktopCapturer,
  screen,
  clipboard,
  nativeImage,
  globalShortcut,
  ipcMain,
  type IpcMainEvent,
} from "electron";
import * as path from "path";
import * as fs from "fs";
import { randomUUID } from "node:crypto";
import { IPC } from "../../shared/ipc-channels";

const MAX_SCREENSHOT_BYTES = 20 * 1024 * 1024; // 20 MB

// ── 会话状态 ──────────────────────────────────────────────

interface ScreenshotSession {
  id: string;
  image: Electron.NativeImage;
  imageWidth: number;
  imageHeight: number;
  displayWidth: number;
  displayHeight: number;
  overlayWindow: BrowserWindow;
  fromButton: boolean;
}

let activeSession: ScreenshotSession | null = null;

// ── 热键状态 ──────────────────────────────────────────────

let registeredHotkey: string | null = null;
let suspendedHotkey: string | null = null; // 设置页捕获时临时挂起

// ── 临时文件 ──────────────────────────────────────────────

function getScreenshotDir(): string {
  return path.join(app.getPath("userData"), "screenshots");
}

async function savePngBuffer(pngBuffer: Buffer): Promise<string> {
  const dir = getScreenshotDir();
  await fs.promises.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${randomUUID()}.png`);
  await fs.promises.writeFile(filePath, pngBuffer);
  return filePath;
}

/** 定期清理过期临时截图（保留最近 50 个） */
export async function cleanupOldScreenshots(): Promise<void> {
  try {
    const dir = getScreenshotDir();
    const files = await fs.promises.readdir(dir);
    if (files.length <= 50) return;
    const stats = await Promise.all(
      files.map(async (f) => {
        const fp = path.join(dir, f);
        const st = await fs.promises.stat(fp);
        return { file: fp, mtime: st.mtimeMs };
      }),
    );
    stats.sort((a, b) => b.mtime - a.mtime);
    const toDelete = stats.slice(50);
    await Promise.all(toDelete.map((s) => fs.promises.unlink(s.file).catch(() => {})));
  } catch {
    // 清理失败不影响主流程
  }
}

// ── 查找聊天窗口 ──────────────────────────────────────────

function findChatWindow(): BrowserWindow | null {
  return (
    BrowserWindow.getAllWindows().find(
      (w) => !w.isDestroyed() && w.webContents.getURL().includes("/chat/"),
    ) ?? null
  );
}

// ── 核心截图流程 ──────────────────────────────────────────

async function startScreenshot(fromButton: boolean): Promise<{ ok: boolean; reason?: string }> {
  // 单例守卫
  if (activeSession) {
    activeSession.overlayWindow.focus();
    return { ok: false, reason: "SCREENSHOT_ALREADY_ACTIVE" };
  }

  const display = screen.getPrimaryDisplay();
  const { width, height } = display.size;
  const scaleFactor = display.scaleFactor;

  // 截全屏
  let sources: Electron.DesktopCapturerSource[];
  try {
    sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: {
        width: Math.ceil(width * scaleFactor),
        height: Math.ceil(height * scaleFactor),
      },
    });
  } catch {
    return { ok: false, reason: "SCREENSHOT_CAPTURE_FAILED" };
  }

  // display_id 匹配主屏（GPT fix #2）
  const source =
    sources.find((s) => s.display_id === String(display.id)) ?? sources[0];

  if (!source || source.thumbnail.isEmpty()) {
    return { ok: false, reason: "SCREENSHOT_SOURCE_UNAVAILABLE" };
  }

  const thumb = source.thumbnail;
  const imageSize = thumb.getSize(); // 真实截图尺寸（GPT fix #1）
  const pngBuffer = thumb.toPNG();
  const image = nativeImage.createFromBuffer(pngBuffer);

  const sessionId = randomUUID();

  // 创建覆盖窗（不透明，GPT fix #5）
  const overlayWindow = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    frame: false,
    transparent: false,
    backgroundColor: "#000000",
    show: false, // 等 rendered 再 show（GPT fix #6）
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, "..", "..", "..", "preload", "preload", "screenshot.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // 窗口被外部关闭时清理
  overlayWindow.on("closed", () => {
    if (activeSession?.id === sessionId) {
      activeSession = null;
    }
  });

  activeSession = {
    id: sessionId,
    image,
    imageWidth: imageSize.width,
    imageHeight: imageSize.height,
    displayWidth: display.bounds.width,
    displayHeight: display.bounds.height,
    overlayWindow,
    fromButton,
  };

  // 加载覆盖窗页面
  const isDev = process.env.VITE_DEV === "1";
  try {
    if (isDev) {
      await overlayWindow.loadURL("http://localhost:5173/screenshot/");
    } else {
      await overlayWindow.loadFile(
        path.join(__dirname, "..", "..", "..", "renderer", "screenshot", "index.html"),
      );
    }
  } catch {
    cleanupSession(sessionId);
    return { ok: false, reason: "SCREENSHOT_OVERLAY_LOAD_FAILED" };
  }

  return { ok: true };
}

// ── IPC 事件处理 ──────────────────────────────────────────

function isFromOverlay(event: IpcMainEvent): boolean {
  return (
    !!activeSession &&
    !event.sender.isDestroyed() &&
    event.sender.id === activeSession.overlayWindow.webContents.id
  );
}

/** 覆盖窗 ready -> 发送截图数据 */
function onOverlayReady(event: IpcMainEvent): void {
  if (!isFromOverlay(event) || !activeSession) return;

  event.sender.send(IPC.SCREENSHOT_DATA, {
    base64: activeSession.image.toPNG().toString("base64"),
    imageWidth: activeSession.imageWidth,
    imageHeight: activeSession.imageHeight,
    displayWidth: activeSession.displayWidth,
    displayHeight: activeSession.displayHeight,
    sessionId: activeSession.id,
  });
}

/** 覆盖窗 rendered -> show + focus */
function onRendered(event: IpcMainEvent): void {
  if (!isFromOverlay(event) || !activeSession) return;

  activeSession.overlayWindow.show();
  activeSession.overlayWindow.focus();
}

/** 用户选区 -> 裁剪 -> 剪贴板 -> 可选插入聊天 */
async function onRegion(
  event: IpcMainEvent,
  sessionId: string,
  x: number,
  y: number,
  w: number,
  h: number,
): Promise<void> {
  if (!activeSession || sessionId !== activeSession.id) return;
  if (!isFromOverlay(event)) return;

  const session = activeSession;

  // 按真实截图尺寸比例换算（GPT fix #1）
  const ratioX = session.imageWidth / session.displayWidth;
  const ratioY = session.imageHeight / session.displayHeight;

  const cropRect = {
    x: Math.round(x * ratioX),
    y: Math.round(y * ratioY),
    width: Math.max(1, Math.round(w * ratioX)),
    height: Math.max(1, Math.round(h * ratioY)),
  };

  const cropped = session.image.crop(cropRect);
  clipboard.writeImage(cropped);

  // 按钮模式：主进程直接写临时文件（GPT fix #3）
  if (session.fromButton) {
    try {
      const pngBuffer = cropped.toPNG();
      const filePath = await savePngBuffer(pngBuffer);
      const size = cropped.getSize();

      const chatWindow = findChatWindow();
      chatWindow?.webContents.send(IPC.SCREENSHOT_INSERT, {
        base64: pngBuffer.toString("base64"),
        mime: "image/png",
        width: size.width,
        height: size.height,
        filePath,
      });
    } catch (err) {
      console.error("[Screenshot] 写临时文件失败:", err);
    }
  }

  cleanupSession(sessionId);
}

/** 取消 */
function onCancel(event: IpcMainEvent): void {
  if (!isFromOverlay(event)) return;
  const sessionId = activeSession?.id;
  if (sessionId) cleanupSession(sessionId);
}

function cleanupSession(sessionId: string): void {
  if (!activeSession || activeSession.id !== sessionId) return;
  const { overlayWindow } = activeSession;
  activeSession = null;
  if (!overlayWindow.isDestroyed()) {
    overlayWindow.close();
  }
  void cleanupOldScreenshots();
}

// ── 临时文件保存（粘贴模式，带校验，GPT fix #4） ──────────

async function saveScreenshotTemp(
  base64: string,
  _mime: string,
): Promise<{ filePath: string }> {
  const raw = Buffer.from(base64, "base64");

  if (raw.byteLength > MAX_SCREENSHOT_BYTES) {
    throw new Error("SCREENSHOT_TOO_LARGE");
  }

  // nativeImage 验证
  const image = nativeImage.createFromBuffer(raw);
  if (image.isEmpty()) {
    throw new Error("INVALID_SCREENSHOT_IMAGE");
  }

  // 统一重新编码为 PNG
  const pngBuffer = image.toPNG();
  const filePath = await savePngBuffer(pngBuffer);
  return { filePath };
}

// ── 热键管理 ──────────────────────────────────────────────

/** 注册截图热键 */
export function registerScreenshotHotkey(accelerator: string): boolean {
  if (registeredHotkey === accelerator) return true;

  if (registeredHotkey) {
    globalShortcut.unregister(registeredHotkey);
    registeredHotkey = null;
  }

  const ok = globalShortcut.register(accelerator, () => {
    void startScreenshot(false);
  });

  if (ok) {
    registeredHotkey = accelerator;
  }

  return ok;
}

/** 事务式切换热键，失败回滚（GPT fix #4） */
export function replaceScreenshotHotkey(next: string): {
  ok: boolean;
  activeHotkey: string | null;
} {
  const previous = registeredHotkey;

  if (previous === next) {
    return { ok: true, activeHotkey: previous };
  }

  if (previous) {
    globalShortcut.unregister(previous);
    registeredHotkey = null;
  }

  try {
    const registered = globalShortcut.register(next, () => {
      void startScreenshot(false);
    });

    if (registered) {
      registeredHotkey = next;
      return { ok: true, activeHotkey: next };
    }
  } catch {
    // fall through to rollback
  }

  // 回滚旧热键
  if (previous) {
    const restored = globalShortcut.register(previous, () => {
      void startScreenshot(false);
    });
    if (restored) {
      registeredHotkey = previous;
    }
  }

  return { ok: false, activeHotkey: registeredHotkey };
}

/** 注销截图热键（仅注销截图的，不影响其他热键） */
export function unregisterScreenshotHotkey(): void {
  if (!registeredHotkey) return;
  globalShortcut.unregister(registeredHotkey);
  registeredHotkey = null;
}

/** 设置页捕获热键时临时挂起（GPT fix #5） */
export function suspendScreenshotHotkey(): void {
  if (!registeredHotkey || suspendedHotkey) return;
  suspendedHotkey = registeredHotkey;
  globalShortcut.unregister(registeredHotkey);
  registeredHotkey = null;
}

/** 捕获结束后恢复 */
export function resumeScreenshotHotkey(): void {
  if (!suspendedHotkey) return;
  const ok = globalShortcut.register(suspendedHotkey, () => {
    void startScreenshot(false);
  });
  if (ok) {
    registeredHotkey = suspendedHotkey;
  }
  suspendedHotkey = null;
}

/** 应用退出时清理 */
export function cleanupOnQuit(): void {
  globalShortcut.unregisterAll();
  if (activeSession) {
    const { overlayWindow } = activeSession;
    activeSession = null;
    if (!overlayWindow.isDestroyed()) {
      overlayWindow.close();
    }
  }
}

// ── IPC 注册 ──────────────────────────────────────────────

export function initScreenshotIpc(): void {
  // chat -> main（按钮触发）
  ipcMain.handle(IPC.SCREENSHOT_START, async () => {
    return startScreenshot(true);
  });

  // overlay -> main
  ipcMain.on(IPC.SCREENSHOT_OVERLAY_READY, (event) => onOverlayReady(event));
  ipcMain.on(IPC.SCREENSHOT_RENDERED, (event) => onRendered(event));
  ipcMain.on(IPC.SCREENSHOT_REGION, (event, sessionId, x, y, w, h) => {
    void onRegion(event, sessionId, x, y, w, h);
  });
  ipcMain.on(IPC.SCREENSHOT_CANCEL, (event) => onCancel(event));

  // chat -> main（粘贴图片存临时文件）
  ipcMain.handle(IPC.SCREENSHOT_SAVE_TEMP, async (_event, base64: string, mime: string) => {
    return saveScreenshotTemp(base64, mime);
  });

  // settings -> main（热键捕获）
  ipcMain.handle(IPC.SCREENSHOT_HOTKEY_CAPTURE_START, () => {
    suspendScreenshotHotkey();
    return true;
  });
  ipcMain.handle(IPC.SCREENSHOT_HOTKEY_CAPTURE_END, () => {
    resumeScreenshotHotkey();
    return true;
  });
}
