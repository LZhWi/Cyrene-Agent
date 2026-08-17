// 聊天会话 IPC 桥接：把 chats-store 的纯数据 API 暴露给渲染进程。
//
// 写操作成功后会向渲染窗口广播 `chats:changed`，以便：
// - 设置中心 💬聊天面板刷新列表；
// - 聊天窗口在标题被改名等情况下同步显示。
//
// 来源隔离：渲染进程发起的写操作广播时会跳过发起方窗口（sender）——发起方已经
// 持有最新状态，不需要被自己的写唤醒；只让其它窗口（以及"外部主动消息提交"这种
// 主进程发起的写）触发的广播到达聊天窗口。这样聊天窗口的 onChanged 只会因真正的
// 外部变更触发，避免本窗口 saveSession() 的广播回来重载当前会话、清掉 transient
// 思考消息的竞态。
//
// 注意：`chats:open-in-chat-window` 涉及 BrowserWindow 创建逻辑，
// 由 src/main/index.ts 自行注册，不在本模块；本模块只管纯数据操作。

import { app, BrowserWindow, ipcMain, type WebContents } from "electron";
import * as path from "path";
import { IPC } from "../../shared/ipc-channels";
import type { ChatMessage } from "../../shared/chat-types";
import * as chatsStore from "./chats-store";
import { loadState as loadOpenerState, saveState as saveOpenerState } from "../opener/desire-engine";
import { rollbackLastProactive } from "../proactive/proactive-policy";
import { deleteSocialContextByTurnIds, deleteSocialContextForConversation } from "../social-context";
import { deleteCallContextEvent } from "../call/call-context-store";
import { deleteMinecraftSessionEvent } from "../game-bot/minecraft/session-store";
import { deleteHistoryEntriesBySessionId, deleteHistoryEntriesByTurnIds } from "../rag";

function minecraftSessionStoreFile(): string {
  return path.join(app.getPath("userData"), "game-bot", "minecraft-sessions.json");
}

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

  ipcMain.handle(IPC.CHATS_LIST, () => chatsStore.listSessions());

  ipcMain.handle(IPC.CHATS_GET, (_event, id: string) => chatsStore.getSession(id));
  ipcMain.handle(IPC.CHATS_GET_PAGE, (_event, payload: { id: string; before?: number | null; limit?: number }) => {
    if (!payload?.id) return null;
    return chatsStore.getSessionPage(payload.id, payload.before ?? null, payload.limit ?? 80);
  });

  ipcMain.handle(
    IPC.CHATS_CREATE,
    (
      event,
      payload?: { title?: string; identityId?: string | null },
    ) => {
      const session = chatsStore.createSession({
        title: payload?.title,
        identityId: payload?.identityId ?? null,
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
    const beforeSession = chatsStore.getSession(id);
    const ok = chatsStore.deleteSession(id);
    if (ok) {
      deleteSocialContextForConversation(id);
      try {
        deleteHistoryEntriesBySessionId(id);
      } catch (err) {
        console.warn("[Chats] 删除会话历史索引失败:", err);
      }
      for (const message of beforeSession?.messages ?? []) {
        if (message.callEvent) deleteCallContextEvent(message.callEvent.callId);
        if (message.minecraftEvent) deleteMinecraftSessionEvent(minecraftSessionStoreFile(), message.minecraftEvent.sessionId);
      }
      broadcastChanged(event.sender);
    }
    return ok;
  });

  ipcMain.handle(
    IPC.CHATS_DELETE_MESSAGE,
    (event, payload: { id: string; messageId: string }) => {
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
        const remainingIds = new Set(session.messages.map((message) => message.id));
        const deletedMessages = beforeSession?.messages.filter((message) => !remainingIds.has(message.id)) ?? [];
        const deletedTurnIds = deletedMessages.map((message) => message.id);
        deleteSocialContextByTurnIds(payload.id, deletedTurnIds);
        // 历史召回索引联动：删除该轮索引条目，避免已删除对话仍被 recall_history 召回
        try {
          deleteHistoryEntriesByTurnIds(deletedTurnIds);
        } catch (err) {
          console.warn("[Chats] 删除历史索引失败:", err);
        }
        // 通话/联机消息删除联动：从对应档案移除事件，
        // 这样 LLM 上下文（callContextBlock / minecraftContextBlock）也不会再注入这条记录。
        for (const deleted of deletedMessages) {
          if (deleted.callEvent) deleteCallContextEvent(deleted.callEvent.callId);
          if (deleted.minecraftEvent) deleteMinecraftSessionEvent(minecraftSessionStoreFile(), deleted.minecraftEvent.sessionId);
        }
        broadcastChanged(event.sender);

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
    (event, messages: ChatMessage[]) => {
      const session = chatsStore.migrateLegacyMessages(messages);
      if (session) broadcastChanged(event.sender);
      return session;
    },
  );
}

// 给 main/index.ts 用的便捷 broadcast（删除当前活跃会话后由 index.ts 调一次；
// 主动消息提交等主进程发起的写也用它）。
// 这些都是主进程发起的写，没有 sender，广播给所有窗口（含聊天窗口）——对聊天窗口
// 而言属于"真正的外部变更"，应当触发重载。
export { broadcastChanged as broadcastChatsChanged };
