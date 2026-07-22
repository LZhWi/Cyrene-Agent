// 聊天会话 IPC 桥接：把 chats-store 的纯数据 API 暴露给渲染进程。
//
// 写操作成功后会向**所有**渲染窗口广播 `chats:changed`，以便：
// - 设置中心 💬聊天面板刷新列表；
// - 聊天窗口在标题被改名等情况下同步显示。
//
// 注意：`chats:open-in-chat-window` 涉及 BrowserWindow 创建逻辑，
// 由 src/main/index.ts 自行注册，不在本模块；本模块只管纯数据操作。

import { BrowserWindow, ipcMain } from "electron";
import { IPC } from "../../shared/ipc-channels";
import type { ChatMessage } from "../../shared/chat-types";
import * as chatsStore from "./chats-store";
import { loadState as loadOpenerState, saveState as saveOpenerState } from "../opener/desire-engine";
import { rollbackLastProactive } from "../proactive/proactive-policy";

function broadcastChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(IPC.CHATS_CHANGED);
    } catch {
      // 某些刚创建/未 ready 的窗口 send 可能抛错，忽略即可
    }
  }
}

export function registerChatsIpc(): void {
  chatsStore.initialize();

  ipcMain.handle(IPC.CHATS_LIST, () => chatsStore.listSessions());

  ipcMain.handle(IPC.CHATS_GET, (_event, id: string) => chatsStore.getSession(id));
  ipcMain.handle(IPC.CHATS_GET_PAGE, (_event, payload: { id: string; before?: number | null; limit?: number }) => {
    if (!payload?.id) return null;
    return chatsStore.getSessionPage(payload.id, payload.before ?? null, payload.limit ?? 80);
  });

  ipcMain.handle(
    IPC.CHATS_CREATE,
    (
      _event,
      payload?: { title?: string; identityId?: string | null },
    ) => {
      const session = chatsStore.createSession({
        title: payload?.title,
        identityId: payload?.identityId ?? null,
      });
      broadcastChanged();
      return session;
    },
  );

  ipcMain.handle(
    IPC.CHATS_APPEND,
    (_event, payload: { id: string; message: ChatMessage }) => {
      if (!payload || !payload.id || !payload.message) return null;
      const session = chatsStore.appendMessage(payload.id, payload.message);
      if (session) broadcastChanged();
      return session;
    },
  );

  ipcMain.handle(
    IPC.CHATS_REPLACE_MESSAGES,
    (_event, payload: { id: string; messages: ChatMessage[] }) => {
      if (!payload || !payload.id || !Array.isArray(payload.messages)) return null;
      const session = chatsStore.replaceMessages(payload.id, payload.messages);
      if (session) broadcastChanged();
      return session;
    },
  );
  ipcMain.handle(
    IPC.CHATS_REPLACE_TAIL,
    (_event, payload: { id: string; startIndex: number; messages: ChatMessage[] }) => {
      if (!payload?.id || !Array.isArray(payload.messages)) return null;
      const session = chatsStore.replaceMessagesTail(payload.id, payload.startIndex, payload.messages);
      if (session) broadcastChanged();
      return session;
    },
  );

  ipcMain.handle(
    IPC.CHATS_RENAME,
    (_event, payload: { id: string; title: string }) => {
      if (!payload || !payload.id) return null;
      const session = chatsStore.renameSession(payload.id, payload.title ?? "");
      if (session) broadcastChanged();
      return session;
    },
  );

  ipcMain.handle(IPC.CHATS_DELETE, (_event, id: string) => {
    if (!id) return false;
    const ok = chatsStore.deleteSession(id);
    if (ok) broadcastChanged();
    return ok;
  });

  ipcMain.handle(
    IPC.CHATS_DELETE_MESSAGE,
    (_event, payload: { id: string; messageId: string }) => {
      if (!payload?.id || !payload?.messageId) return null;

      // 删除前检查：是否是 proactive-chat 会话中最后一条未回复的 AI 主动消息
      // 条件：1) purpose === "proactive-chat" 2) 最后一条是 AI 消息 3) 被删除的正是最后一条
      const beforeSession = chatsStore.getSession(payload.id);
      const lastMsg = beforeSession?.messages?.[beforeSession.messages.length - 1];
      const isLastUnrepliedProactive =
        beforeSession?.purpose === "proactive-chat" &&
        lastMsg !== undefined &&
        lastMsg.id === payload.messageId &&
        lastMsg.role === "model";

      const session = chatsStore.deleteMessageRound(payload.id, payload.messageId);
      if (session) {
        broadcastChanged();

        // 删除的是 proactive-chat 会话中最后一条未回复的 AI 主动消息时，
        // 回退 2 小时全局冷却和 unansweredCount，保留场景冷却。
        if (isLastUnrepliedProactive) {
          const openerState = loadOpenerState();
          rollbackLastProactive(openerState);
          saveOpenerState(openerState);
        }
      }
      return session;
    },
  );

  ipcMain.handle(IPC.CHATS_OPEN_FOLDER, async () => {
    await chatsStore.openStorageFolder();
    return true;
  });

  ipcMain.handle(
    IPC.CHATS_MIGRATE_LEGACY,
    (_event, messages: ChatMessage[]) => {
      const session = chatsStore.migrateLegacyMessages(messages);
      if (session) broadcastChanged();
      return session;
    },
  );
}

// 给 main/index.ts 用的便捷 broadcast（删除当前活跃会话后由 index.ts 调一次）。
export { broadcastChanged as broadcastChatsChanged };
