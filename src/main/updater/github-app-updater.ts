import { autoUpdater } from "electron-updater";
import { createAppUpdateService, type AppUpdateService, type AppUpdaterLike } from "./app-update-service";

export function createGitHubAppUpdateService(options: {
  currentVersion: string;
  isPackaged: boolean;
}): AppUpdateService {
  return createAppUpdateService({
    updater: autoUpdater as unknown as AppUpdaterLike,
    currentVersion: options.currentVersion,
    isPackaged: options.isPackaged,
  });
}

export function scheduleStartupUpdateCheck(service: AppUpdateService, delayMs = 10_000): () => void {
  const timer = setTimeout(() => {
    void service.check();
  }, delayMs);
  timer.unref?.();
  return () => clearTimeout(timer);
}
