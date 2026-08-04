// 聊天会话 IPC 桥接：把 chats-store 的纯数据 API 暴露给渲染进程。
//
// 写操作成功后会向渲染窗口广播 `chats:changed`，以便：
// - 设置中心 💬聊天面板刷新列表；
// - 聊天窗口在标题被改名等情况下同步显示。
//
// 来源隔离：渲染进程发起的写操作广播时会跳过发起方窗口（sender）--发起方已经
// 持有最新状态，不需要被自己的写唤醒；只让其它窗口（以及"外部主动消息提交"这种
// 主进程发起的写）触发的广播到达聊天窗口。这样聊天窗口的 onChanged 只会因真正的
// 外部变更触发，避免本窗口 saveSession() 的广播回来重载当前会话、清掉 transient
// 思考消息的竞态。
//
// 注意：`chats:open-in-chat-window` 涉及 BrowserWindow 创建逻辑，
// 由 src/main/index.ts 自行注册，不在本模块；本模块只管纯数据操作。

import { BrowserWindow, ipcMain, type WebContents, dialog, shell } from "electron";
import { IPC } from "../../shared/ipc-channels";
import type { ChatMessage, ConversationMode, ConversationWorkspaceBinding } from "../../shared/chat-types";
import * as chatsStore from "./chats-store";
import * as fs from "fs";
import * as path from "path";
import { ensureVaultStructure, isEmptyDirectory } from "../learn/obsidian/vault-init";

function broadcastChanged(senderWebContents?: WebContents | null): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    // 跳过发起方：渲染进程自己的写不需要广播回自己（来源隔离）。
    if (senderWebContents && win.webContents === senderWebContents) continue;
    try {
      win.webContents.send(IPC.CHATS_CHANGED);
    } catch {
      // 某些刚创建/未 ready 的窗口 send 可能抛错，忽略即可
    }
  }
}

export function registerChatsIpc(): void {
  chatsStore.initialize();

  ipcMain.handle(
    IPC.CHATS_LIST,
    (_event, options?: { mode?: ConversationMode }) => chatsStore.listSessions(options),
  );

  ipcMain.handle(IPC.CHATS_GET, (_event, id: string) => chatsStore.getSession(id));
  ipcMain.handle(IPC.CHATS_GET_PAGE, (_event, payload: { id: string; before?: number | null; limit?: number }) => {
    if (!payload?.id) return null;
    return chatsStore.getSessionPage(payload.id, payload.before ?? null, payload.limit ?? 80);
  });

  ipcMain.handle(
    IPC.CHATS_CREATE,
    (
      event,
      payload?: { title?: string; identityId?: string | null; mode?: ConversationMode },
    ) => {
      const session = chatsStore.createSession({
        title: payload?.title,
        identityId: payload?.identityId ?? null,
        mode: payload?.mode,
      });
      broadcastChanged(event.sender);
      return session;
    },
  );

  ipcMain.handle(
    IPC.CHATS_APPEND,
    (event, payload: { id: string; message: ChatMessage }) => {
      if (!payload || !payload.id || !payload.message) return null;
      const session = chatsStore.appendMessage(payload.id, payload.message);
      if (session) broadcastChanged(event.sender);
      return session;
    },
  );

  ipcMain.handle(
    IPC.CHATS_SET_MESSAGE_TTS_CACHE,
    (event, payload: { id: string; messageId: string; cacheKey: string; converterVersion: string }) => {
      if (!payload?.id || !payload.messageId || !payload.cacheKey || !payload.converterVersion) return null;
      const session = chatsStore.setMessageTtsCacheKey(
        payload.id,
        payload.messageId,
        payload.cacheKey,
        payload.converterVersion,
      );
      if (session) broadcastChanged(event.sender);
      return session;
    },
  );

  ipcMain.handle(
    IPC.CHATS_REPLACE_MESSAGES,
    (event, payload: { id: string; messages: ChatMessage[] }) => {
      if (!payload || !payload.id || !Array.isArray(payload.messages)) return null;
      const session = chatsStore.replaceMessages(payload.id, payload.messages);
      if (session) broadcastChanged(event.sender);
      return session;
    },
  );
  ipcMain.handle(
    IPC.CHATS_REPLACE_TAIL,
    (event, payload: { id: string; startIndex: number; messages: ChatMessage[] }) => {
      if (!payload?.id || !Array.isArray(payload.messages)) return null;
      const session = chatsStore.replaceMessagesTail(payload.id, payload.startIndex, payload.messages);
      if (session) broadcastChanged(event.sender);
      return session;
    },
  );

  ipcMain.handle(
    IPC.CHATS_RENAME,
    (event, payload: { id: string; title: string }) => {
      if (!payload || !payload.id) return null;
      const session = chatsStore.renameSession(payload.id, payload.title ?? "");
      if (session) broadcastChanged(event.sender);
      return session;
    },
  );

  ipcMain.handle(IPC.CHATS_DELETE, (event, id: string) => {
    if (!id) return false;
    const ok = chatsStore.deleteSession(id);
    if (ok) broadcastChanged(event.sender);
    return ok;
  });

  ipcMain.handle(IPC.CHATS_OPEN_FOLDER, async () => {
    await chatsStore.openStorageFolder();
    return true;
  });

  ipcMain.handle(IPC.CHATS_OPEN_WORKSPACE, async (_event, workspaceRoot: unknown) => {
    if (typeof workspaceRoot !== "string" || !workspaceRoot.trim()) {
      return { ok: false, error: "missing workspaceRoot" };
    }
    try {
      const resolved = validateAndNormalizeWorkspace(workspaceRoot);
      const isBoundWorkspace = chatsStore.listSessions().some((session) =>
        session.workspaceRoot === resolved,
      );
      if (!isBoundWorkspace) {
        return { ok: false, error: "workspace is not bound to a conversation" };
      }
      const error = await shell.openPath(resolved);
      return error ? { ok: false, error } : { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle(
    IPC.CHATS_MIGRATE_LEGACY,
    (event, messages: ChatMessage[]) => {
      const session = chatsStore.migrateLegacyMessages(messages);
      if (session) broadcastChanged(event.sender);
      return session;
    },
  );

  ipcMain.handle(
    IPC.CHATS_SET_CODE_MODE,
    (event, payload: { sessionId?: string; clineMode?: "plan" | "act" } = {}) => {
      if (!payload.sessionId || (payload.clineMode !== "plan" && payload.clineMode !== "act")) {
        return { ok: false, error: "invalid Code mode request" };
      }
      const session = chatsStore.updateCodeSession(payload.sessionId, { clineMode: payload.clineMode });
      if (!session) return { ok: false, error: "Code session not found" };
      broadcastChanged(event.sender);
      return { ok: true, session };
    },
  );

  // ── 对话工作区绑定 ──────────────────────────────────────

  ipcMain.handle(
    IPC.CHATS_SET_WORKSPACE,
    async (event, payload: { sessionId: string; workspaceRoot: string }) => {
      if (!payload?.sessionId || !payload?.workspaceRoot) {
        return { ok: false, error: "missing sessionId or workspaceRoot" };
      }
      const existing = chatsStore.getSession(payload.sessionId);
      if (!existing) return { ok: false, error: "session not found" };
      if (existing.mode !== "work" && existing.mode !== "code" && existing.mode !== "daily" && existing.mode !== "learn") {
        return { ok: false, error: `${existing.mode ?? "unknown"} mode does not support workspace binding` };
      }
      // 路径验证：目录存在 + realpath 解析
      try {
        const resolved = validateAndNormalizeWorkspace(payload.workspaceRoot);
        const binding: ConversationWorkspaceBinding = {
          workspaceRoot: resolved,
          displayName: path.basename(resolved),
          boundAt: Date.now(),
        };
        const session = chatsStore.setWorkspaceBinding(payload.sessionId, binding);
        if (!session) return { ok: false, error: "session not found" };
        console.log("[Workspace] 绑定成功:",
          "sessionId=" + payload.sessionId.slice(0, 8) + "...",
          "workspaceRoot=" + resolved,
        );
        // 广播工作区变更
        for (const win of BrowserWindow.getAllWindows()) {
          if (win.isDestroyed()) continue;
          try {
            win.webContents.send(IPC.CHATS_WORKSPACE_CHANGED, {
              sessionId: payload.sessionId,
              binding,
            });
          } catch { /* ignore */ }
        }
        // Learn 模式：检测目录是否为空，让 renderer 决定是否初始化结构
        const empty = existing.mode === "learn" ? await isEmptyDirectory(resolved) : false;
        return { ok: true, binding, isEmpty: empty };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: msg };
      }
    },
  );

  ipcMain.handle(
    IPC.CHATS_INIT_LEARN_WORKSPACE,
    async (_event, sessionId: string) => {
      if (!sessionId) return { ok: false, error: "missing sessionId" };
      const binding = chatsStore.getWorkspaceBinding(sessionId);
      if (!binding) return { ok: false, error: "no workspace binding" };
      const session = chatsStore.getSession(sessionId);
      if (!session || session.mode !== "learn") {
        return { ok: false, error: "session is not in learn mode" };
      }
      const result = await ensureVaultStructure(binding.workspaceRoot);
      if (result.error) return { ok: false, error: result.error };
      return { ok: true, created: result.created, skipped: result.skipped };
    },
  );

  ipcMain.handle(
    IPC.CHATS_GET_WORKSPACE,
    (_event, sessionId: string) => {
      if (!sessionId) return null;
      return chatsStore.getWorkspaceBinding(sessionId) ?? null;
    },
  );

  ipcMain.handle(
    IPC.CHATS_CLEAR_WORKSPACE,
    (event, sessionId: string) => {
      if (!sessionId) return { ok: false, error: "missing sessionId" };
      const session = chatsStore.clearWorkspaceBinding(sessionId);
      if (!session) return { ok: false, error: "session not found" };
      // 广播工作区变更
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.isDestroyed()) continue;
        try {
          win.webContents.send(IPC.CHATS_WORKSPACE_CHANGED, {
            sessionId,
            binding: null,
          });
        } catch { /* ignore */ }
      }
      return { ok: true };
    },
  );

  ipcMain.handle(
    IPC.CHATS_PICK_WORKSPACE_FOLDER,
    async (event) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) return { ok: false, error: "no window" };
      const result = await dialog.showOpenDialog(win, {
        properties: ["openDirectory"],
        title: "选择工作区目录",
      });
      if (result.canceled || result.filePaths.length === 0) {
        return { ok: false, canceled: true };
      }
      const selected = result.filePaths[0];
      try {
        const resolved = validateAndNormalizeWorkspace(selected);
        return { ok: true, path: resolved, displayName: path.basename(resolved) };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: msg };
      }
    },
  );
}

// ── 路径验证 ──────────────────────────────────────────────

/**
 * 验证并规范化工作区路径：
 * - 目录存在
 * - realpath 解析（消除 symlink/junction）
 * - Windows 路径标准化
 */
function validateAndNormalizeWorkspace(inputPath: string): string {
  // 1. 检查目录存在
  if (!fs.existsSync(inputPath)) {
    throw new Error(`目录不存在: ${inputPath}`);
  }
  const stat = fs.statSync(inputPath);
  if (!stat.isDirectory()) {
    throw new Error(`不是目录: ${inputPath}`);
  }
  // 2. realpath 解析（消除 symlink/junction）
  const resolved = fs.realpathSync(inputPath);
  // 3. Windows 路径标准化（正斜杠 → 反斜杠，统一大小写盘符）
  const normalized = path.resolve(resolved);
  return normalized;
}

// 给 main/index.ts 用的便捷 broadcast（删除当前活跃会话后由 index.ts 调一次；
// 主动消息提交 commitLocalProactiveMessage 也用它）。
// 这些都是主进程发起的写，没有 sender，广播给所有窗口（含聊天窗口）--对聊天窗口
// 而言属于"真正的外部变更"，应当触发重载。
export { broadcastChanged as broadcastChatsChanged };

