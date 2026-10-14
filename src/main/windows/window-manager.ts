import { BrowserWindow, screen, type NativeImage } from "electron";
import { IPC } from "../../shared/ipc-channels";
import { createPetWindow, PET_WINDOW_BASE_HEIGHT, PET_WINDOW_BASE_WIDTH, type PetWindowSettingsSlice } from "../startup/create-pet-window";
import {
  createCallWindow,
  createReactChatWindowShell,
  createReactWorkspaceWindowShell,
  createSettingsWindow,
  createSidebarWindow,
  createStickerManagerWindow,
  createTasksWindow,
  loadReactChatWindowPage,
  type ReactChatWindowHandle,
  showReactChatWindow,
  showReactWorkspaceWindow,
} from "./create-aux-windows";
import { CHAT_READY_TIMEOUT_MS, loadWindowForStartup } from "./startup-window-load";
import { createMusicPlayerWindow } from "./create-music-player-window";
import { broadcastToAllWindows } from "./broadcast";
import { PetWindowMoveController } from "../pet-window-movement";
import { getSession } from "../chats/chats-store";

const PET_WINDOW_RESOURCE_RELEASE_DELAY_MS = 30_000;

export interface WindowManagerOptions {
  getCurrentAppIconPath: () => string;
  isDev: boolean;
  loadPetWindowSettingsSlice: () => PetWindowSettingsSlice;
  persistPetWindowPosition: (position: { x: number; y: number }) => void;
}

export interface WindowManager {
  createPetWindow(showOnReady?: boolean): BrowserWindow;
  /** 创建（或复用）未加载页面的聊天窗口壳；页面加载由显式 load() 驱动。 */
  createReactChatWindowShell(): ReactChatWindowHandle;
  /** 打开聊天窗口：必要时创建壳并加载页面，然后显示并分发会话。 */
  openReactChatWindow(sessionId?: string): Promise<BrowserWindow>;
  openReactWorkspaceWindow(sessionId?: string): Promise<BrowserWindow>;
  createSidebarWindow(): void;
  createSettingsWindow(section?: string): void;
  createTasksWindow(): void;
  createStickerManagerWindow(): void;
  createCallWindow(): void;
  createMusicPlayerWindow(): void;

  showPetWindow(): void;
  hidePetWindow(): void;
  togglePetWindow(): void;
  minimizePetWindow(): void;
  setPetWindowAlwaysOnTop(alwaysOnTop: boolean): void;
  setPetWindowInteractive(interactive: boolean): void;
  setPetWindowDragging(isDragging: boolean): void;
  movePetWindowRelative(dx: number, dy: number): void;
  movePetWindowTo(x: number, y: number): void;
  applyPetWindowZoom(zoom: number): void;
  capturePetWindowFrame(): Promise<string | null>;
  capturePetWindow(): Promise<Electron.NativeImage | null>;
  /** 仅供宿主屏幕变化比较排除自身动态桌宠；不可见或未创建时返回 null。 */
  getPetWindowBounds(): Electron.Rectangle | null;
  getCursorScreenPosition(): { x: number; y: number };
  setIconForAllWindows(icon: NativeImage): void;
  sendToPetWindow(channel: string, payload?: unknown): void;
  broadcast(channel: string, payload: unknown): void;

  onPetWindowReady(handler: (win: BrowserWindow) => void): void;
  onPetWindowClosed(handler: () => void): void;
  onPetWindowMoved(handler: (position: { x: number; y: number }) => void): void;

  dispose(): void;
}

export function createWindowManager(options: WindowManagerOptions): WindowManager {
  let petWindow: BrowserWindow | null = null;
  let chatShell: ReactChatWindowHandle | null = null;
  let chatLoadPromise: Promise<void> | null = null;
  let workspaceShell: ReactChatWindowHandle | null = null;
  let workspaceLoadPromise: Promise<void> | null = null;
  let petWindowReleaseTimer: ReturnType<typeof setTimeout> | null = null;
  const readyHandlers: Array<(win: BrowserWindow) => void> = [];
  const closedHandlers: Array<() => void> = [];
  const movedHandlers: Array<(position: { x: number; y: number }) => void> = [];

  const petWindowMoveController = new PetWindowMoveController(
    () => petWindow,
    (position) => {
      options.persistPetWindowPosition(position);
    },
  );

  function getUsablePetWindow(): BrowserWindow | null {
    if (!petWindow || petWindow.isDestroyed()) return null;
    return petWindow;
  }

  function cancelPetWindowResourceRelease(): void {
    if (petWindowReleaseTimer === null) return;
    clearTimeout(petWindowReleaseTimer);
    petWindowReleaseTimer = null;
  }

  function schedulePetWindowResourceRelease(window: BrowserWindow): void {
    cancelPetWindowResourceRelease();
    if (window.isDestroyed() || window.isVisible()) return;
    petWindowReleaseTimer = setTimeout(() => {
      petWindowReleaseTimer = null;
      if (petWindow !== window || window.isDestroyed() || window.isVisible()) return;
      window.destroy();
    }, PET_WINDOW_RESOURCE_RELEASE_DELAY_MS);
  }

  function setPetWindow(window: BrowserWindow, showOnReady = true): void {
    petWindow = window;
    window.once("ready-to-show", () => {
      if (petWindow !== window || window.isDestroyed()) return;
      if (showOnReady) {
        window.show();
      } else {
        schedulePetWindowResourceRelease(window);
      }
      for (const handler of readyHandlers) {
        try { handler(window); } catch (err) { console.error("[WindowManager] ready handler failed:", err); }
      }
    });
    window.on("hide", () => schedulePetWindowResourceRelease(window));
    window.on("show", cancelPetWindowResourceRelease);
    window.on("closed", () => {
      cancelPetWindowResourceRelease();
      petWindowMoveController.dispose();
      if (petWindow !== window) return;
      petWindow = null;
      for (const handler of closedHandlers) {
        try { handler(); } catch (err) { console.error("[WindowManager] closed handler failed:", err); }
      }
    });
    window.on("moved", () => {
      const win = petWindow;
      if (!win || win.isDestroyed()) return;
      try {
        const [x, y] = win.getPosition();
        for (const handler of movedHandlers) {
          try { handler({ x, y }); } catch (err) { console.error("[WindowManager] moved handler failed:", err); }
        }
      } catch {
        // ignore
      }
    });
  }

  return {
    createPetWindow(showOnReady = true): BrowserWindow {
      if (petWindow && !petWindow.isDestroyed()) return petWindow;
      const win = createPetWindow(
        {
          getCurrentAppIconPath: options.getCurrentAppIconPath,
          isDev: options.isDev,
          loadGeneralSettings: options.loadPetWindowSettingsSlice,
        },
        { showOnReady },
      );
      setPetWindow(win, showOnReady);
      const alwaysOnTop = options.loadPetWindowSettingsSlice().petAlwaysOnTop ?? true;
      win.setAlwaysOnTop(alwaysOnTop, alwaysOnTop ? "screen-saver" : "normal");
      return win;
    },

    createReactChatWindowShell(): ReactChatWindowHandle {
      if (chatShell && !chatShell.window.isDestroyed()) return chatShell;
      const window = createReactChatWindowShell();
      const handle: ReactChatWindowHandle = {
        window,
        load(sessionId?: string): Promise<void> {
          // load() 缓存同一个 Promise：重复调用不会二次加载；
          // sessionId 通过 show() 分发，而非重新加载页面。
          if (!chatLoadPromise || window.isDestroyed()) {
            chatLoadPromise = loadWindowForStartup({
              window,
              load: () => loadReactChatWindowPage(window, sessionId),
              timeoutMs: CHAT_READY_TIMEOUT_MS,
            }).catch((error) => {
              console.error("[WindowManager] chat page load failed:", error);
              throw error;
            });
          }
          return chatLoadPromise;
        },
        show(sessionId?: string): void {
          showReactChatWindow(sessionId);
        },
      };
      chatShell = handle;
      chatLoadPromise = null;
      return handle;
    },

    async openReactChatWindow(sessionId?: string): Promise<BrowserWindow> {
      const mode = sessionId ? getSession(sessionId)?.mode : undefined;
      if (mode === "work" || mode === "code" || mode === "learn") {
        return this.openReactWorkspaceWindow(sessionId);
      }
      const handle = this.createReactChatWindowShell();
      await handle.load(sessionId);
      handle.show(sessionId);
      return handle.window;
    },

    async openReactWorkspaceWindow(sessionId?: string): Promise<BrowserWindow> {
      if (!workspaceShell || workspaceShell.window.isDestroyed()) {
        const window = createReactWorkspaceWindowShell();
        workspaceLoadPromise = null;
        workspaceShell = {
          window,
          load(initialSessionId?: string): Promise<void> {
            if (!workspaceLoadPromise || window.isDestroyed()) {
              workspaceLoadPromise = loadWindowForStartup({
                window,
                load: () => loadReactChatWindowPage(window, initialSessionId, "workspace"),
                timeoutMs: CHAT_READY_TIMEOUT_MS,
              }).catch((error) => {
                workspaceLoadPromise = null;
                console.error("[WindowManager] workspace page load failed:", error);
                throw error;
              });
            }
            return workspaceLoadPromise;
          },
          show: showReactWorkspaceWindow,
        };
      }
      await workspaceShell.load(sessionId);
      workspaceShell.show(sessionId);
      return workspaceShell.window;
    },

    createSidebarWindow,
    createSettingsWindow,
    createTasksWindow,
    createStickerManagerWindow,
    createCallWindow,
    createMusicPlayerWindow,

    showPetWindow(): void {
      const win = getUsablePetWindow();
      if (win) {
        win.show();
        return;
      }
      // 窗口不存在（如被意外销毁）时兜底重建，保证托盘/设置永远能救回桌宠
      this.createPetWindow(true);
    },
    hidePetWindow(): void {
      getUsablePetWindow()?.hide();
    },
    togglePetWindow(): void {
      const win = getUsablePetWindow();
      if (!win) {
        this.createPetWindow(true);
        return;
      }
      win.isVisible() ? win.hide() : win.show();
    },
    minimizePetWindow(): void {
      getUsablePetWindow()?.minimize();
    },
    setPetWindowAlwaysOnTop(alwaysOnTop: boolean): void {
      const win = getUsablePetWindow();
      if (!win) return;
      win.setAlwaysOnTop(alwaysOnTop, alwaysOnTop ? "screen-saver" : "normal");
    },
    setPetWindowInteractive(interactive: boolean): void {
      const win = getUsablePetWindow();
      if (!win) return;
      win.setIgnoreMouseEvents(!interactive, { forward: true });
    },
    setPetWindowDragging(isDragging: boolean): void {
      const win = getUsablePetWindow();
      if (!win) return;
      if (!isDragging) petWindowMoveController.finishDragging();
      try {
        win.setOpacity(isDragging ? 0.99 : 1.0);
      } catch (error) {
        console.warn("[WindowManager] Failed to update pet window dragging opacity:", error);
      }
    },
    movePetWindowRelative(dx: number, dy: number): void {
      petWindowMoveController.moveRelative(dx, dy);
    },
    movePetWindowTo(x: number, y: number): void {
      petWindowMoveController.queueAbsolute(x, y);
    },
    applyPetWindowZoom(zoom: number): void {
      const win = getUsablePetWindow();
      if (!win) return;
      const width = Math.round(PET_WINDOW_BASE_WIDTH * zoom);
      const height = Math.round(PET_WINDOW_BASE_HEIGHT * zoom);
      win.setSize(width, height);
      if (!win.isDestroyed()) {
        win.webContents.send(IPC.PET_ZOOM, zoom);
      }
    },
    async capturePetWindowFrame(): Promise<string | null> {
      const image = await this.capturePetWindow();
      return image ? image.toDataURL() : null;
    },
    async capturePetWindow(): Promise<Electron.NativeImage | null> {
      const win = getUsablePetWindow();
      if (!win) return null;
      try {
        return await win.webContents.capturePage();
      } catch (err) {
        console.error("[WindowManager] capturePetWindow failed:", err);
        return null;
      }
    },
    getPetWindowBounds(): Electron.Rectangle | null {
      const win = getUsablePetWindow();
      return win?.isVisible() ? win.getBounds() : null;
    },
    getCursorScreenPosition(): { x: number; y: number } {
      return screen.getCursorScreenPoint();
    },
    setIconForAllWindows(icon: NativeImage): void {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.setIcon(icon);
      }
    },
    sendToPetWindow(channel: string, payload?: unknown): void {
      const win = getUsablePetWindow();
      if (!win) return;
      if (payload === undefined) win.webContents.send(channel);
      else win.webContents.send(channel, payload);
    },
    broadcast(channel: string, payload: unknown): void {
      broadcastToAllWindows(channel, payload);
    },

    onPetWindowReady(handler: (win: BrowserWindow) => void): void {
      readyHandlers.push(handler);
      if (petWindow && !petWindow.isDestroyed() && petWindow.isVisible()) {
        try { handler(petWindow); } catch (err) { console.error("[WindowManager] ready handler failed:", err); }
      }
    },
    onPetWindowClosed(handler: () => void): void {
      closedHandlers.push(handler);
    },
    onPetWindowMoved(handler: (position: { x: number; y: number }) => void): void {
      movedHandlers.push(handler);
    },

    dispose(): void {
      cancelPetWindowResourceRelease();
      petWindowMoveController.dispose();
    },
  };
}
