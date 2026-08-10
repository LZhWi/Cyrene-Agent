import * as path from "node:path";
import { BrowserWindow, ipcMain } from "electron";
import { IPC } from "../../shared/ipc-channels";
import type { CodeGitChangedPayload, CodeGitDiffResult } from "../../shared/code-git-types";
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
  getWindows?: () => WindowLike[];
  service: Pick<GitService, "getStatusForSession" | "getDiffForSession" | "onChanged">;
}

export function registerCodeGitIpc(deps: RegisterCodeGitIpcDeps): void {
  const main = deps.ipcMain ?? ipcMain;
  const getWindows = deps.getWindows ?? (() => BrowserWindow.getAllWindows());

  main.handle(IPC.CODE_GIT_STATUS, (_event, sessionId: unknown) => {
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

  main.handle(IPC.CODE_GIT_DIFF, (_event, payload: unknown): Promise<CodeGitDiffResult> | CodeGitDiffResult => {
    const input = payload as { sessionId?: unknown; path?: unknown } | null;
    const sessionId = typeof input?.sessionId === "string" ? input.sessionId : "";
    const relativePath = typeof input?.path === "string" ? input.path : "";
    if (!sessionId || !isSafeRendererRelativePath(relativePath)) {
      return {
        kind: "error",
        sessionId,
        path: relativePath,
        message: "只能审阅当前仓库中的变更文件",
      };
    }
    return deps.service.getDiffForSession(sessionId, relativePath);
  });

  deps.service.onChanged((payload) => {
    for (const window of getWindows()) {
      if (!window.isDestroyed()) window.webContents.send(IPC.CODE_GIT_CHANGED, payload);
    }
  });
}

function isSafeRendererRelativePath(value: string): boolean {
  if (!value || path.isAbsolute(value) || value.includes("\0")) return false;
  return !value.replace(/\\/g, "/").split("/").some((part) => part === "..");
}
