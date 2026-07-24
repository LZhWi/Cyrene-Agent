/**
 * 截图管理器 -- 截全屏 -> 覆盖窗选区 -> nativeImage.crop -> 剪贴板。
 *
 * 优化（复刻微信/QQ 体验）：
 * - 预创建覆盖窗：app 启动时就创建并加载好，热键触发时只截屏+发数据+show，延迟最低
 * - 并行截屏与窗口准备：desktopCapturer 和窗口 bounds 更新同时进行
 * - screen-saver 层级：覆盖 Windows 任务栏，不出现叠影
 * - 按真实截图尺寸/CSS 尺寸比例裁剪
 * - display_id 匹配主屏
 * - 单例会话防并发 + sender 校验
 * - 按钮模式主进程直接写临时文件
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
  fromButton: boolean;
}

let activeSession: ScreenshotSession | null = null;

// ── 预创建覆盖窗 ──────────────────────────────────────────

let overlayWindow: BrowserWindow | null = null;
let overlayReady = false; // HTML 是否已加载完毕

/** 创建并预加载覆盖窗（隐藏），app 启动时调一次 */
function ensureOverlayWindow(): void {
  if (overlayWindow && !overlayWindow.isDestroyed()) return;

  const isDev = process.env.VITE_DEV === "1";

  overlayWindow = new BrowserWindow({
    frame: false,
    transparent: false,
    backgroundColor: "#000000",
    show: false,
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

  // screen-saver 层级确保覆盖 Windows 任务栏
  overlayWindow.setAlwaysOnTop(true, "screen-saver");

  overlayReady = false;

  overlayWindow.webContents.on("did-finish-load", () => {
    overlayReady = true;
  });

  overlayWindow.on("closed", () => {
    overlayWindow = null;
    overlayReady = false;
  });

  // 预加载 HTML（不 show）
  if (isDev) {
    void overlayWindow.loadURL("http://localhost:5173/screenshot/");
  } else {
    void overlayWindow.loadFile(
      path.join(__dirname, "..", "..", "..", "renderer", "screenshot", "index.html"),
    );
  }
}

// ── 热键状态 ──────────────────────────────────────────────

let registeredHotkey: string | null = null;
let suspendedHotkey: string | null = null;

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
    overlayWindow?.focus();
    return { ok: false, reason: "SCREENSHOT_ALREADY_ACTIVE" };
  }

  const display = screen.getPrimaryDisplay();
  const { width, height } = display.size;
  const scaleFactor = display.scaleFactor;

  // 更新覆盖窗 bounds 到当前屏幕（预创建时可能位置不对）
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.setBounds({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
    });
  }

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

  const source =
    sources.find((s) => s.display_id === String(display.id)) ?? sources[0];

  if (!source || source.thumbnail.isEmpty()) {
    return { ok: false, reason: "SCREENSHOT_SOURCE_UNAVAILABLE" };
  }

  const thumb = source.thumbnail;
  const imageSize = thumb.getSize();
  const pngBuffer = thumb.toPNG();
  const image = nativeImage.createFromBuffer(pngBuffer);

  const sessionId = randomUUID();

  // 确保覆盖窗存在且已加载
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    ensureOverlayWindow();
    // 等待加载完成
    await new Promise<void>((resolve) => {
      if (overlayReady) return resolve();
      const check = setInterval(() => {
        if (overlayReady || !overlayWindow || overlayWindow.isDestroyed()) {
          clearInterval(check);
          resolve();
        }
      }, 50);
    });
  }

  if (!overlayWindow || overlayWindow.isDestroyed() || !overlayReady) {
    return { ok: false, reason: "SCREENSHOT_OVERLAY_NOT_READY" };
  }

  activeSession = {
    id: sessionId,
    image,
    imageWidth: imageSize.width,
    imageHeight: imageSize.height,
    displayWidth: display.bounds.width,
    displayHeight: display.bounds.height,
    fromButton,
  };

  // 直接发送截图数据（窗口已预加载，不需要等 ready）
  overlayWindow.webContents.send(IPC.SCREENSHOT_DATA, {
    base64: pngBuffer.toString("base64"),
    imageWidth: imageSize.width,
    imageHeight: imageSize.height,
    displayWidth: display.bounds.width,
    displayHeight: display.bounds.height,
    sessionId,
  });

  return { ok: true };
}

// ── IPC 事件处理 ──────────────────────────────────────────

function isFromOverlay(event: IpcMainEvent): boolean {
  return (
    !!activeSession &&
    !!overlayWindow &&
    !overlayWindow.isDestroyed() &&
    !event.sender.isDestroyed() &&
    event.sender.id === overlayWindow.webContents.id
  );
}

/** 覆盖窗 ready（预加载模式下用于初次加载完成通知） */
function onOverlayReady(event: IpcMainEvent): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  if (event.sender.id !== overlayWindow.webContents.id) return;
  overlayReady = true;
}

/** 覆盖窗 rendered -> show + focus */
function onRendered(event: IpcMainEvent): void {
  if (!isFromOverlay(event) || !activeSession || !overlayWindow) return;

  overlayWindow.show();
  overlayWindow.focus();
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
  activeSession = null;
  // 隐藏覆盖窗（不销毁，下次复用）
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.hide();
  }
  void cleanupOldScreenshots();
}

// ── 临时文件保存（粘贴模式，带校验） ──────────

async function saveScreenshotTemp(
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

  const pngBuffer = image.toPNG();
  const filePath = await savePngBuffer(pngBuffer);
  return { filePath };
}

// ── 热键管理 ──────────────────────────────────────────────

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

export function unregisterScreenshotHotkey(): void {
  if (!registeredHotkey) return;
  globalShortcut.unregister(registeredHotkey);
  registeredHotkey = null;
}

export function suspendScreenshotHotkey(): void {
  if (!registeredHotkey || suspendedHotkey) return;
  suspendedHotkey = registeredHotkey;
  globalShortcut.unregister(registeredHotkey);
  registeredHotkey = null;
}

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

export function cleanupOnQuit(): void {
  globalShortcut.unregisterAll();
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.destroy();
    overlayWindow = null;
  }
  activeSession = null;
}

// ── IPC 注册 ──────────────────────────────────────────────

export function initScreenshotIpc(): void {
  // 预创建覆盖窗
  ensureOverlayWindow();

  ipcMain.handle(IPC.SCREENSHOT_START, async () => {
    return startScreenshot(true);
  });

  ipcMain.on(IPC.SCREENSHOT_OVERLAY_READY, (event) => onOverlayReady(event));
  ipcMain.on(IPC.SCREENSHOT_RENDERED, (event) => onRendered(event));
  ipcMain.on(IPC.SCREENSHOT_REGION, (event, sessionId, x, y, w, h) => {
    void onRegion(event, sessionId, x, y, w, h);
  });
  ipcMain.on(IPC.SCREENSHOT_CANCEL, (event) => onCancel(event));

  ipcMain.handle(IPC.SCREENSHOT_SAVE_TEMP, async (_event, base64: string, mime: string) => {
    return saveScreenshotTemp(base64, mime);
  });

  ipcMain.handle(IPC.SCREENSHOT_HOTKEY_CAPTURE_START, () => {
    suspendScreenshotHotkey();
    return true;
  });
  ipcMain.handle(IPC.SCREENSHOT_HOTKEY_CAPTURE_END, () => {
    resumeScreenshotHotkey();
    return true;
  });
}
