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

  async capture(url: string, anchor: MinecraftCameraAnchor | null = null): Promise<{ base64: string; mime: string }> {
    if (!/^http:\/\/127\.0\.0\.1:\d+\/$/.test(url)) throw new Error("第三视角地址不是受信任的本地回环地址");
    if (!this.window || this.window.isDestroyed()) {
      this.window = new BrowserWindow({
        show: false,
        width: 960,
        height: 720,
        webPreferences: { offscreen: true, sandbox: true, nodeIntegration: false, contextIsolation: true },
      });
      this.window.webContents.setAudioMuted(true);
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
    return { base64: image.toPNG().toString("base64"), mime: "image/png" };
  }

  close(): void {
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
    this.loadedUrl = "";
    this.loadedAnchor = null;
  }
}
