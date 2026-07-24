/**
 * 截图管理器 -- 常驻屏幕流 + 即时冻结选区。
 *
 * 流程（一次截图）：
 *   1. 热键 / 按钮触发 -> 通知 overlay "ready to show"
 *   2. Renderer 从常驻 MediaStream 抓帧，drawImage 到静态 Canvas
 *   3. Canvas 画完后通知 main "frame ready"
 *   4. Main show() 窗口 + 注册全局 ESC（绕过覆盖窗失焦问题）
 *   5. 用户拖框 + 双击/Enter/点确认 -> Renderer 裁剪 + toBlob
 *   6. Renderer 把 PNG ArrayBuffer 发给 main
 *   7. Main 写剪贴板 + 临时文件 + 插入聊天附件 -> 隐藏窗口
 */

import {
  app,
  BrowserWindow,
  screen,
  clipboard,
  nativeImage,
  globalShortcut,
  ipcMain,
} from "electron";
import * as path from "path";
import * as fs from "fs";
import { randomUUID } from "node:crypto";
import { IPC } from "../../shared/ipc-channels";

const MAX_SCREENSHOT_BYTES = 20 * 1024 * 1024;

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
    await Promise.all(
      stats.slice(50).map((s) => fs.promises.unlink(s.file).catch(() => {})),
    );
  } catch {
    /* ignore */
  }
}

// ── 会话状态 ──────────────────────────────────────────────

interface ScreenshotSession {
  id: string;
  fromButton: boolean;
  timings: Record<string, number>;
}

let activeSession: ScreenshotSession | null = null;

// ── 热键状态 ──────────────────────────────────────────────

let registeredHotkey: string | null = null;
let suspendedHotkey: string | null = null;

// ESC 全局热键（仅会话期间注册）
let escapeHotkeyActive = false;

// ── 覆盖窗 ────────────────────────────────────────────────

let overlayWindow: BrowserWindow | null = null;
let overlayReady = false;

const isDev = process.env.VITE_DEV === "1";

function ensureOverlayWindow(): void {
  if (overlayWindow && !overlayWindow.isDestroyed()) return;

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
    focusable: true,
    webPreferences: {
      preload: path.join(
        __dirname,
        "..",
        "..",
        "..",
        "preload",
        "preload",
        "screenshot.js",
      ),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false, // 关键：禁止后台节流，保证屏幕流不卡顿
    },
  });

  overlayWindow.setAlwaysOnTop(true, "screen-saver");

  overlayReady = false;

  overlayWindow.webContents.on("did-finish-load", () => {
    overlayReady = true;
  });

  overlayWindow.on("closed", () => {
    overlayWindow = null;
    overlayReady = false;
  });

  if (isDev) {
    void overlayWindow.loadURL("http://localhost:5173/screenshot/");
  } else {
    void overlayWindow.loadFile(
      path.join(
        __dirname,
        "..",
        "..",
        "..",
        "renderer",
        "screenshot",
        "index.html",
      ),
    );
  }
}

/** 更新覆盖窗到主屏完整 bounds（包含任务栏） */
function updateOverlayBounds(): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const display = screen.getPrimaryDisplay();
  overlayWindow.setBounds({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
  });
}

function findChatWindow(): BrowserWindow | null {
  return (
    BrowserWindow.getAllWindows().find(
      (w) => !w.isDestroyed() && w.webContents.getURL().includes("/chat/"),
    ) ?? null
  );
}

// ── 性能埋点（开发模式） ──────────────────────────────────

function logTimings(session: ScreenshotSession, label: string): void {
  if (!isDev) return;
  const t = session.timings;
  const order = [
    "hotkeyReceived",
    "frameRequested",
    "frameAvailable",
    "canvasPainted",
    "overlayShown",
    "selectionConfirmed",
    "pngEncoded",
    "clipboardWritten",
  ];
  const parts = order
    .filter((k) => t[k] !== undefined)
    .map((k) => `${k.replace("hotkeyReceived", "hotkey")}=${t[k]! - t.hotkeyReceived}ms`);
  const total = Date.now() - session.timings.hotkeyReceived;
  console.log(`[Screenshot] ${label} total=${total}ms ${parts.join(" ")}`);
}

// ── 核心流程 ──────────────────────────────────────────────

async function startScreenshot(fromButton: boolean): Promise<{ ok: boolean; reason?: string }> {
  if (activeSession) {
    overlayWindow?.show();
    overlayWindow?.focus();
    return { ok: false, reason: "SCREENSHOT_ALREADY_ACTIVE" };
  }

  const session: ScreenshotSession = {
    id: randomUUID(),
    fromButton,
    timings: { hotkeyReceived: Date.now() },
  };
  activeSession = session;

  // 确保覆盖窗存在
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    ensureOverlayWindow();
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

  if (!overlayWindow || overlayWindow.isDestroyed()) {
    activeSession = null;
    return { ok: false, reason: "SCREENSHOT_OVERLAY_NOT_READY" };
  }

  updateOverlayBounds();

  // 注册会话级全局 ESC（应对覆盖窗失焦）
  if (!escapeHotkeyActive) {
    const ok = globalShortcut.register("Escape", () => {
      if (activeSession) cancelScreenshot("escape-global");
    });
    escapeHotkeyActive = ok;
  }

  // 通知 Renderer 开始截帧（从常驻 MediaStream）
  overlayWindow.webContents.send(IPC.SCREENSHOT_START_SESSION, {
    sessionId: session.id,
    fromButton,
    displayWidth: screen.getPrimaryDisplay().bounds.width,
    displayHeight: screen.getPrimaryDisplay().bounds.height,
    timings: session.timings,
  });

  return { ok: true };
}

/** Renderer 报告帧已抓到且 Canvas 已画好 -> 显示窗口 */
function onFrameReady(
  event: import("electron").IpcMainEvent,
  payload: { sessionId: string; timings: Record<string, number> },
): void {
  if (!isFromOverlay(event) || !activeSession) return;
  if (payload.sessionId !== activeSession.id) return;

  Object.assign(activeSession.timings, payload.timings);

  if (!overlayWindow || overlayWindow.isDestroyed()) return;

  // 显示窗口（严格按 GPT 规范顺序）
  overlayWindow.show();
  overlayWindow.moveTop();
  overlayWindow.focus();

  activeSession.timings.overlayShown = Date.now();
  overlayWindow.webContents.send(IPC.SCREENSHOT_SHOWN, {
    timings: activeSession.timings,
  });
  logTimings(activeSession, "shown");
}

/** 用户确认 -> 收 PNG ArrayBuffer */
async function onConfirm(
  event: import("electron").IpcMainEvent,
  payload: {
    sessionId: string;
    png: ArrayBuffer;
    width: number;
    height: number;
    timings: Record<string, number>;
  },
): Promise<void> {
  if (!isFromOverlay(event) || !activeSession) return;
  if (payload.sessionId !== activeSession.id) return;

  const session = activeSession;
  Object.assign(session.timings, payload.timings);
  session.timings.selectionConfirmed = Date.now();

  const pngBuffer = Buffer.from(payload.png);
  if (pngBuffer.byteLength > MAX_SCREENSHOT_BYTES) {
    cancelScreenshot("too-large");
    return;
  }

  // 写入剪贴板
  const image = nativeImage.createFromBuffer(pngBuffer);
  if (image.isEmpty()) {
    cancelScreenshot("invalid-image");
    return;
  }
  clipboard.writeImage(image);
  session.timings.clipboardWritten = Date.now();
  logTimings(session, "done");

  // 按钮模式插入聊天附件
  if (session.fromButton) {
    try {
      const filePath = await savePngBuffer(pngBuffer);
      const chatWindow = findChatWindow();
      chatWindow?.webContents.send(IPC.SCREENSHOT_INSERT, {
        base64: pngBuffer.toString("base64"),
        mime: "image/png",
        width: payload.width,
        height: payload.height,
        filePath,
      });
    } catch (err) {
      console.error("[Screenshot] 写临时文件失败:", err);
    }
  }

  finishSession(session.id);
}

/** 用户取消 */
function onCancel(event: import("electron").IpcMainEvent, reason: string): void {
  if (!isFromOverlay(event)) return;
  cancelScreenshot(reason);
}

/** 全局 ESC 触发的取消 */
function cancelScreenshot(reason: string): void {
  if (!activeSession) return;
  if (isDev) console.log(`[Screenshot] cancel: ${reason}`);
  finishSession(activeSession.id);
}

/** 统一清理入口 */
function finishSession(sessionId: string): void {
  if (!activeSession || activeSession.id !== sessionId) return;
  activeSession = null;

  // 注销会话级 ESC
  if (escapeHotkeyActive) {
    globalShortcut.unregister("Escape");
    escapeHotkeyActive = false;
  }

  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.hide();
  }
  void cleanupOldScreenshots();
}

function isFromOverlay(event: import("electron").IpcMainEvent): boolean {
  return (
    !!overlayWindow &&
    !overlayWindow.isDestroyed() &&
    !event.sender.isDestroyed() &&
    event.sender.id === overlayWindow.webContents.id
  );
}

// ── 临时文件保存（粘贴模式） ──────────────────────────────

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

  if (ok) registeredHotkey = accelerator;
  return ok;
}

export function replaceScreenshotHotkey(next: string): {
  ok: boolean;
  activeHotkey: string | null;
} {
  const previous = registeredHotkey;
  if (previous === next) return { ok: true, activeHotkey: previous };

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
    /* fall through */
  }

  if (previous) {
    const restored = globalShortcut.register(previous, () => {
      void startScreenshot(false);
    });
    if (restored) registeredHotkey = previous;
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
  if (ok) registeredHotkey = suspendedHotkey;
  suspendedHotkey = null;
}

export function cleanupOnQuit(): void {
  globalShortcut.unregisterAll();
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.destroy();
    overlayWindow = null;
  }
  activeSession = null;
  escapeHotkeyActive = false;
}

// ── IPC 注册 ──────────────────────────────────────────────

export function initScreenshotIpc(): void {
  ensureOverlayWindow();

  ipcMain.handle(IPC.SCREENSHOT_START, async () => startScreenshot(true));
  ipcMain.on(IPC.SCREENSHOT_FRAME_READY, (event, payload) => onFrameReady(event, payload));
  ipcMain.on(IPC.SCREENSHOT_CONFIRM, (event, payload) => void onConfirm(event, payload));
  ipcMain.on(IPC.SCREENSHOT_CANCEL, (event, reason: string) => onCancel(event, reason));

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