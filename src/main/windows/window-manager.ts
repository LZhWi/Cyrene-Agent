import type { BrowserWindow, NativeImage } from "electron";
import { PetWindowMoveController } from "../pet-window-movement";

export interface WindowManagerOptions {
  baseWidth: number;
  baseHeight: number;
  persistMainWindowPosition: (position: { x: number; y: number }) => void;
  createImageFromBitmap: (buffer: Buffer, size: { width: number; height: number }) => NativeImage;
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

  // TODO(holocubic-closeout): Remove this obsolete desktop-capture helper and its bitmap dependency during final cleanup.
  async captureMainWindowJpeg(width: number, height: number, quality: number, zoom = 1): Promise<Buffer | null> {
    const image = await this.captureMainWindow();
    if (!image || image.isEmpty()) return null;
    const targetWidth = Math.max(1, Math.round(width));
    const targetHeight = Math.max(1, Math.round(height));
    const jpegQuality = Math.max(0, Math.min(100, Math.round(quality)));
    const sourceSize = image.getSize();
    if (sourceSize.width < 1 || sourceSize.height < 1) return null;
    const outputZoom = Math.max(0.1, Math.min(4, Number.isFinite(zoom) ? zoom : 1));
    const scale = Math.min(targetWidth / sourceSize.width, targetHeight / sourceSize.height) * outputZoom;
    const fittedWidth = Math.max(1, Math.round(sourceSize.width * scale));
    const fittedHeight = Math.max(1, Math.round(sourceSize.height * scale));
    const fitted = image.resize({
      width: fittedWidth,
      height: fittedHeight,
      quality: "good",
    });
    if (fittedWidth === targetWidth && fittedHeight === targetHeight) {
      return fitted.toJPEG(jpegQuality);
    }

    const sourceBitmap = fitted.toBitmap();
    const expectedBytes = fittedWidth * fittedHeight * 4;
    if (sourceBitmap.length < expectedBytes) return null;
    const canvas = Buffer.alloc(targetWidth * targetHeight * 4);
    for (let offset = 3; offset < canvas.length; offset += 4) canvas[offset] = 255;
    const offsetX = Math.floor((targetWidth - fittedWidth) / 2);
    const offsetY = Math.floor((targetHeight - fittedHeight) / 2);
    const sourceX = Math.max(0, -offsetX);
    const sourceY = Math.max(0, -offsetY);
    const targetX = Math.max(0, offsetX);
    const targetY = Math.max(0, offsetY);
    const copyWidth = Math.min(fittedWidth - sourceX, targetWidth - targetX);
    const copyHeight = Math.min(fittedHeight - sourceY, targetHeight - targetY);
    const sourceStride = fittedWidth * 4;
    const targetStride = targetWidth * 4;
    for (let y = 0; y < copyHeight; y += 1) {
      sourceBitmap.copy(
        canvas,
        ((y + targetY) * targetStride) + (targetX * 4),
        ((y + sourceY) * sourceStride) + (sourceX * 4),
        ((y + sourceY) * sourceStride) + ((sourceX + copyWidth) * 4),
      );
    }
    return this.options.createImageFromBitmap(canvas, {
      width: targetWidth,
      height: targetHeight,
    }).toJPEG(jpegQuality);
  }

  dispose(): void {
    this.petWindowMoveController.dispose();
  }
}
