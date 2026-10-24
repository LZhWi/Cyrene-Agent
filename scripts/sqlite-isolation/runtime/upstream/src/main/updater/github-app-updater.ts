import * as path from "node:path";
import { app } from "electron";
import { autoUpdater } from "electron-updater";
import { createAppUpdateService, type AppUpdateService, type AppUpdaterLike } from "./app-update-service";

export function createGitHubAppUpdateService(options: {
  currentVersion: string;
  isPackaged: boolean;
}): AppUpdateService {
  if (options.isPackaged) {
    // 钉死升级安装目录：即使注册表 InstallLocation 缺失/漂移，
    // 静默升级也强制装回当前运行目录（NsisUpdater 会把它作为 /D= 参数传给安装器）。
    (autoUpdater as unknown as { installDirectory?: string }).installDirectory = path.dirname(app.getPath("exe"));
  }
  return createAppUpdateService({
    updater: autoUpdater as unknown as AppUpdaterLike,
    currentVersion: options.currentVersion,
    isPackaged: options.isPackaged,
  });
}

/** 启动 10 秒后查一次，之后每 6 小时再查一次（对齐公告的轮询节奏） */
export function scheduleStartupUpdateCheck(
  service: AppUpdateService,
  delayMs = 10_000,
  intervalMs = 6 * 60 * 60 * 1000,
): () => void {
  const timer = setTimeout(() => {
    void service.check();
  }, delayMs);
  timer.unref?.();
  const interval = setInterval(() => {
    void service.check();
  }, intervalMs);
  interval.unref?.();
  return () => {
    clearTimeout(timer);
    clearInterval(interval);
  };
}
