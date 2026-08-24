import type { BrowserWindow, NativeImage } from "electron";
import { PetWindowMoveController } from "../pet-window-movement";

export interface WindowManagerOptions {
  baseWidth: number;
  baseHeight: number;
  persistMainWindowPosition: (position: { x: number; y: number }) => void;
}

/**
 * Owns the desktop pet window reference and its mechanical window operations.
 *
 * Window construction and feature initialization intentionally remain in the
 * main bootstrap. Keeping that boundary prevents window lifecycle extraction
 * from pulling weather, call, memory, and tool configuration into this module.
 */
export class WindowManager {
  private mainWindow: BrowserWindow | null = null;
  private readonly petWindowMoveController: PetWindowMoveController;

  constructor(private readonly options: WindowManagerOptions) {
    this.petWindowMoveController = new PetWindowMoveController(
      () => this.getMainWindow(),
      options.persistMainWindowPosition,
    );
  }

  attachMainWindow(window: BrowserWindow): BrowserWindow {
    this.mainWindow = window;
    window.on("closed", () => {
      if (this.mainWindow !== window) return;
      this.petWindowMoveController.dispose();
      this.mainWindow = null;
    });
    return window;
  }

  getMainWindow(): BrowserWindow | null {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return null;
    return this.mainWindow;
  }

  showMainWindow(inactive = false): void {
    const window = this.getMainWindow();
    if (!window) return;
    if (inactive) window.showInactive();
    else window.show();
  }

  hideMainWindow(): void {
    this.getMainWindow()?.hide();
  }

  toggleMainWindow(): void {
    const window = this.getMainWindow();
    if (!window) return;
    if (window.isVisible()) window.hide();
    else window.show();
  }

  minimizeMainWindow(): void {
    this.getMainWindow()?.minimize();
  }

  setMainWindowAlwaysOnTop(alwaysOnTop: boolean): void {
    this.getMainWindow()?.setAlwaysOnTop(
      alwaysOnTop,
      alwaysOnTop ? "screen-saver" : "normal",
    );
  }

  setMainWindowInteractive(interactive: boolean): void {
    this.getMainWindow()?.setIgnoreMouseEvents(!interactive, { forward: true });
  }

  setMainWindowDragging(isDragging: boolean): void {
    const window = this.getMainWindow();
    if (!window) return;
    if (!isDragging) this.petWindowMoveController.finishDragging();
    try {
      window.setOpacity(isDragging ? 0.99 : 1);
    } catch (error) {
      console.warn("[WindowManager] Failed to update pet window dragging opacity:", error);
    }
  }

  moveMainWindowRelative(dx: unknown, dy: unknown): void {
    this.petWindowMoveController.moveRelative(dx, dy);
  }

  moveMainWindowTo(x: unknown, y: unknown): void {
    this.petWindowMoveController.queueAbsolute(x, y);
  }

  applyMainWindowZoom(zoom: number): void {
    const window = this.getMainWindow();
    if (!window) return;
    window.setBounds({
      width: Math.round(this.options.baseWidth * zoom),
      height: Math.round(this.options.baseHeight * zoom),
    });
  }

  sendToMainWindow(channel: string, payload?: unknown): void {
    const window = this.getMainWindow();
    if (!window || window.webContents.isDestroyed()) return;
    if (payload === undefined) window.webContents.send(channel);
    else window.webContents.send(channel, payload);
  }

  async captureMainWindow(): Promise<NativeImage | null> {
    const window = this.getMainWindow();
    if (!window) return null;
    try {
      return await window.webContents.capturePage();
    } catch (error) {
      console.error("[WindowManager] Failed to capture pet window:", error);
      return null;
    }
  }

  async captureMainWindowFrame(): Promise<string | null> {
    const image = await this.captureMainWindow();
    return image?.toDataURL() ?? null;
  }

  dispose(): void {
    this.petWindowMoveController.dispose();
  }
}
