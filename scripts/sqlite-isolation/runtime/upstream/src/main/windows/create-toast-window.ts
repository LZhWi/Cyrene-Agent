import { app, BrowserWindow, screen } from "electron";
import * as path from "path";
import { isDev } from "../env";
import { setToastWindow, toastWindow } from "./window-state";
import { TOAST_WINDOW_WIDTH } from "../toast/types";

/**
 * 创建（或复用）toast 提醒窗口。
 * 与其他辅助窗口不同：常驻不销毁、初始隐藏、永不抢焦点（showInactive）、
 * 不进任务栏；队列空时整窗 hide，有 toast 时由 toast-window 控制器定位后显示。
 */
export function createToastWindowShell(): BrowserWindow {
  if (toastWindow && !toastWindow.isDestroyed()) {
    return toastWindow;
  }

  const display = screen.getPrimaryDisplay();
  const { x, y, width, height } = display.workArea;
  const window = new BrowserWindow({
    // 初始位置放在主屏工作区右下角；后续每次显示前由控制器按四级回退链重算
    x: x + width - TOAST_WINDOW_WIDTH,
    y: y + height,
    width: TOAST_WINDOW_WIDTH,
    height: 1,
    // toast 是覆盖层：无边框、透明、置顶、不进任务栏、不可聚焦（绝不偷焦点）
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    resizable: false,
    show: false,
    title: "Cyrene · 提醒",
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(app.getAppPath(), "dist", "preload", "preload", "index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // 覆盖层置顶级别与桌宠一致（screen-saver 为最高用户态层级）
  window.setAlwaysOnTop(true, "screen-saver");

  if (isDev) {
    void window.loadURL("http://localhost:5173/toast/");
  } else {
    void window.loadFile(path.join(app.getAppPath(), "dist", "renderer", "toast", "index.html"));
  }

  setToastWindow(window);
  window.on("closed", () => {
    setToastWindow(null);
  });

  return window;
}
