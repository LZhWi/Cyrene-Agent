import { BrowserWindow } from "electron";

export interface MinecraftCameraAnchor {
  x: number;
  y: number;
  z: number;
}

function movedFrom(previous: MinecraftCameraAnchor | null, current: MinecraftCameraAnchor | null): boolean {
  if (!previous || !current) return false;
  const dx = previous.x - current.x;
  const dy = previous.y - current.y;
  const dz = previous.z - current.z;
  return Math.hypot(dx, dy, dz) > 1.5;
}

export class MinecraftThirdPersonCapture {
  private window: BrowserWindow | null = null;
  private loadedUrl = "";
  private loadedAnchor: MinecraftCameraAnchor | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  async capture(url: string, anchor: MinecraftCameraAnchor | null = null): Promise<{ base64: string; mime: string }> {
    if (!/^http:\/\/127\.0\.0\.1:\d+\/$/.test(url)) throw new Error("第三视角地址不是受信任的本地回环地址");
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (!this.window || this.window.isDestroyed()) {
      this.window = new BrowserWindow({
        show: false,
        width: 960,
        height: 720,
        webPreferences: { offscreen: true, sandbox: true, nodeIntegration: false, contextIsolation: true },
      });
      this.window.webContents.setAudioMuted(true);
      // 离屏 WebGL 默认按高帧率持续渲染；截图只需要单帧，限流可显著降低
      // 这第二渲染上下文的 GPU 占用（GPU 命令缓冲耗尽型崩溃的压力源之一）。
      this.window.webContents.setFrameRate(20);
    }
    // prismarine-viewer's third-person orbit camera is anchored only when the
    // page receives its first position. Reload after movement/teleport so the
    // next screenshot follows the bot instead of looking at the old location.
    if (this.loadedUrl !== url || movedFrom(this.loadedAnchor, anchor)) {
      await this.window.loadURL(url);
      this.loadedUrl = url;
      this.loadedAnchor = anchor;
      await new Promise((resolve) => setTimeout(resolve, 2500));
    }
    const image = await this.window.webContents.capturePage();
    if (image.isEmpty()) throw new Error("第三视角画面为空");
    this.scheduleIdleClose();
    return { base64: image.toPNG().toString("base64"), mime: "image/png" };
  }

  /** 截图请求空闲 5 分钟后释放隐藏渲染窗口，避免第二 WebGL 上下文长期驻留 GPU；
   *  下次截图会按需重建（capture 入口自带懒创建与 2.5s 稳定等待）。 */
  private scheduleIdleClose(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.close();
    }, 5 * 60_000);
  }

  close(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
    this.loadedUrl = "";
    this.loadedAnchor = null;
  }
}
