/**
 * 截图覆盖窗专用 preload -- 最小权限，只暴露选区交互所需的 5 个方法。
 *
 * 覆盖窗不需要聊天 API、设置 API 或任何其他能力。
 */
import { contextBridge, ipcRenderer } from "electron";
import { IPC } from "../shared/ipc-channels";

const screenshotOverlayApi = {
  /** 通知主进程：覆盖窗已加载，可以发送截图数据了 */
  ready: () => ipcRenderer.send(IPC.SCREENSHOT_OVERLAY_READY),

  /** 接收主进程发来的截图数据（base64 + 尺寸 + sessionId） */
  onData: (
    cb: (data: {
      base64: string;
      imageWidth: number;
      imageHeight: number;
      displayWidth: number;
      displayHeight: number;
      sessionId: string;
    }) => void,
  ) => {
    const listener = (
      _e: unknown,
      data: {
        base64: string;
        imageWidth: number;
        imageHeight: number;
        displayWidth: number;
        displayHeight: number;
        sessionId: string;
      },
    ) => cb(data);
    ipcRenderer.on(IPC.SCREENSHOT_DATA, listener as never);
    return () => ipcRenderer.off(IPC.SCREENSHOT_DATA, listener as never);
  },

  /** 通知主进程：canvas 已画完，可以 show() 了 */
  rendered: () => ipcRenderer.send(IPC.SCREENSHOT_RENDERED),

  /** 发送选区坐标（CSS 像素）给主进程裁剪 */
  select: (sessionId: string, x: number, y: number, w: number, h: number) =>
    ipcRenderer.send(IPC.SCREENSHOT_REGION, sessionId, x, y, w, h),

  /** 取消截图 */
  cancel: () => ipcRenderer.send(IPC.SCREENSHOT_CANCEL),
};

contextBridge.exposeInMainWorld("screenshotOverlay", screenshotOverlayApi);
