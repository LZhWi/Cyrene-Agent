/**
 * 截图覆盖窗专用 preload -- 最小权限。
 */
import { contextBridge, ipcRenderer } from "electron";
import { IPC } from "../shared/ipc-channels";

const screenshotOverlayApi = {
  // 会话开始：主进程通知渲染层启动新截图会话
  onStartSession: (
    cb: (data: {
      sessionId: string;
      fromButton: boolean;
      displayWidth: number;
      displayHeight: number;
      timings: Record<string, number>;
    }) => void,
  ) => {
    const listener = (
      _e: unknown,
      data: {
        sessionId: string;
        fromButton: boolean;
        displayWidth: number;
        displayHeight: number;
        timings: Record<string, number>;
      },
    ) => cb(data);
    ipcRenderer.on(IPC.SCREENSHOT_START_SESSION, listener as never);
    return () => ipcRenderer.off(IPC.SCREENSHOT_START_SESSION, listener as never);
  },

  // 帧就绪：Renderer 抓到帧并画完 canvas 后调用
  frameReady: (sessionId: string, timings: Record<string, number>) =>
    ipcRenderer.send(IPC.SCREENSHOT_FRAME_READY, { sessionId, timings }),

  // 主进程通知窗口已显示（用于埋点）
  onShown: (cb: (data: { timings: Record<string, number> }) => void) => {
    const listener = (_e: unknown, data: { timings: Record<string, number> }) => cb(data);
    ipcRenderer.on(IPC.SCREENSHOT_SHOWN, listener as never);
    return () => ipcRenderer.off(IPC.SCREENSHOT_SHOWN, listener as never);
  },

  // 用户确认：发送 PNG ArrayBuffer
  confirm: (payload: {
    sessionId: string;
    png: ArrayBuffer;
    width: number;
    height: number;
    timings: Record<string, number>;
  }) => ipcRenderer.send(IPC.SCREENSHOT_CONFIRM, payload),

  // 用户取消
  cancel: (sessionId: string, reason: string) =>
    ipcRenderer.send(IPC.SCREENSHOT_CANCEL, sessionId, reason),

  // 调试用：原 dev:screenshot 通道保留
  ready: () => ipcRenderer.send(IPC.SCREENSHOT_OVERLAY_READY),
};

contextBridge.exposeInMainWorld("screenshotOverlay", screenshotOverlayApi);