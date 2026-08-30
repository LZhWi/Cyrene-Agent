import * as path from "node:path";
import { BrowserWindow, ipcMain } from "electron";
import { IPC } from "../../shared/ipc-channels";
import { createIpcScope, type IpcScope, type IpcScopeMainLike } from "../application/ipc-scope";
import type { CodeGitChangedPayload } from "../../shared/code-git-types";
import type { GitService } from "./git-service";

interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: any[]) => unknown): void;
}

interface WindowLike {
  isDestroyed(): boolean;
  webContents: { send(channel: string, payload: CodeGitChangedPayload): void };
}

export interface RegisterCodeGitIpcDeps {
  ipcMain?: IpcMainLike;
  /** 传入共享 scope 以便退出时统一注销；缺省时按旧 ipcMain 参数或全局 ipcMain 包装。 */
  ipc?: IpcScope;
  getWindows?: () => WindowLike[];
  service: Pick<GitService, "getStatusForSession" | "watchSession" | "unwatchSession" | "switchBranchForSession" | "commitForSession" | "pushForSession" | "onChanged">;
}

export function registerCodeGitIpc(deps: RegisterCodeGitIpcDeps): void {
  const ipc: IpcScope = deps.ipc
    ?? createIpcScope((deps.ipcMain ?? ipcMain) as IpcScopeMainLike);
  const getWindows = deps.getWindows ?? (() => BrowserWindow.getAllWindows());

  ipc.handle(IPC.CODE_GIT_STATUS, (_event, sessionId: unknown) => {
    if (typeof sessionId !== "string" || !sessionId.trim()) {
      return {
        sessionId: "",
        state: "error",
        message: "缺少会话标识",
        executable: null,
        branch: null,
        files: [],
        summary: { added: 0, modified: 0, deleted: 0, renamed: 0, conflicted: 0 },
        ahead: 0,
        behind: 0,
      };
    }
    return deps.service.getStatusForSession(sessionId);
  });

  ipc.handle(IPC.CODE_GIT_WATCH, (_event, sessionId: unknown) => deps.service.watchSession(requireSessionId(sessionId)));
  ipc.handle(IPC.CODE_GIT_UNWATCH, (_event, sessionId: unknown) => deps.service.unwatchSession(requireSessionId(sessionId)));
  ipc.handle(IPC.CODE_GIT_SWITCH_BRANCH, (_event, payload: unknown) => {
    const input = payload as { sessionId?: unknown; branch?: unknown; create?: unknown } | null;
    if (typeof input?.branch !== "string") throw new Error("缺少分支名称");
    return deps.service.switchBranchForSession(requireSessionId(input.sessionId), input.branch, input.create === true);
  });
  ipc.handle(IPC.CODE_GIT_COMMIT, (_event, payload: unknown) => {
    const input = payload as { sessionId?: unknown; message?: unknown; paths?: unknown } | null;
    if (typeof input?.message !== "string" || !Array.isArray(input.paths) || input.paths.some((value) => typeof value !== "string" || !isSafeRendererRelativePath(value))) throw new Error("提交参数无效");
    return deps.service.commitForSession(requireSessionId(input.sessionId), input.message, input.paths);
  });
  ipc.handle(IPC.CODE_GIT_PUSH, (_event, sessionId: unknown) => deps.service.pushForSession(requireSessionId(sessionId)));

  deps.service.onChanged((payload) => {
    for (const window of getWindows()) {
      if (!window.isDestroyed()) window.webContents.send(IPC.CODE_GIT_CHANGED, payload);
    }
  });
}

function requireSessionId(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("缺少会话标识");
  return value;
}

function isSafeRendererRelativePath(value: string): boolean {
  if (!value || path.isAbsolute(value) || value.includes("\0")) return false;
  return !value.replace(/\\/g, "/").split("/").some((part) => part === "..");
}
