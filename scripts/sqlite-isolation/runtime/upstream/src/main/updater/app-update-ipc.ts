import { BrowserWindow } from "electron";
import { IPC } from "../../shared/ipc-channels";
import { createIpcScope, type IpcScope, type IpcScopeMainLike } from "../application/ipc-scope";
import type { AppUpdateState } from "../../shared/app-update";
import type { AppUpdateService } from "./app-update-service";

interface WindowLike {
  isDestroyed(): boolean;
  webContents: { send(channel: string, payload: AppUpdateState): void };
}

export interface ControlledShutdownRequest {
  reason: string;
  finalAction(): void;
}

export type RequestControlledShutdown = (input: ControlledShutdownRequest) => Promise<void>;

export interface RegisterAppUpdateIpcOptions {
  service: AppUpdateService;
  /** 传入共享 scope 以便退出时统一注销；缺省时按旧 ipcMain 参数或全局 ipcMain 包装。 */
  ipc?: IpcScope;
  ipcMain?: IpcScopeMainLike;
  /** 传入受控退出协调入口：安装更新前先完成可等待清理（组合根注入）。 */
  requestControlledShutdown?: RequestControlledShutdown;
  getWindows?: () => WindowLike[];
}

export function registerAppUpdateIpc(options: RegisterAppUpdateIpcOptions): void {
  const ipc: IpcScope = options.ipc ?? createIpcScope(options.ipcMain ?? undefined);
  const getWindows = options.getWindows ?? (() => BrowserWindow.getAllWindows());

  ipc.handle(IPC.APP_UPDATE_GET_STATE, () => options.service.getState());
  ipc.handle(IPC.APP_UPDATE_CHECK, () => options.service.check());
  ipc.handle(IPC.APP_UPDATE_DOWNLOAD, () => options.service.download());
  // 安装更新不得直接触发退出：先走受控退出完成清理，再把 quitAndInstall 作为最终动作执行。
  ipc.handle(IPC.APP_UPDATE_INSTALL, async () => {
    if (!options.service.canInstall()) return false;
    if (options.requestControlledShutdown) {
      await options.requestControlledShutdown({
        reason: "update-install",
        finalAction: () => options.service.install(),
      });
      return true;
    }
    return options.service.install();
  });

  options.service.onStateChanged((state) => {
    for (const window of getWindows()) {
      if (!window.isDestroyed()) window.webContents.send(IPC.APP_UPDATE_STATE, state);
    }
  });
}
