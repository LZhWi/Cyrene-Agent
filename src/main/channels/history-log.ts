// channels/history-log —— 渠道侧每个 sender 的对话历史 (滑窗用).
//
// 统一 SQLite owner 保存历史；读取窗口不截断底层记录。
//
// 数据流:
//   dispatcher.handleIncoming 入站/出站 → appendHistory(senderSessionId, role, content)
//   dispatcher.handleIncoming 下一轮进 → loadRecentHistory(senderSessionId, 16) 拉最近 16 条
//
// 跟 message-log 的区别:
//   message-log 是"运营可见"的人类可读日志 (UI 显示给人看)
//   history-log 是 agent 喂的"对话上下文", LLM 需要, 机器格式
//
// 跟 RAG 索引 (indexConversationTurn) 的区别:
//   RAG 是语义检索 (cosine similarity), 长期持久
//   history-log 是精确窗口 (sliding window), 短期明确
import { app } from "electron";
import { randomUUID } from 'node:crypto';
import { getServiceState } from '../storage/service-state';
import { createHash } from 'node:crypto';
import type { BoundConversationMessageMetadata } from './channel-context';

function sqlHistory() { return getServiceState(app.getPath('userData'),'channel-history'); }

/** Import legacy channel history before committing a receipt through the journal. */
export function prepareChannelHistory():void { sqlHistory(); }


/** 一条消息: 谁说的 + 内容 + 时间戳 ISO */
export interface HistoryEntry {
  role: "user" | "assistant";
  content: string;
  at: string;
  id?: string;
}

const MAX_FILE_LINES = 200; // 最近 200 条, 远大于滑动窗口 16

/** sessionId 可能不安全做文件名, 用 sha256 hex 兜底. dispatcher 给的已是 hash+prefix 形式也 OK. */
function safeName(sessionId: string): string {
  // dispatcher 的 sessionId 形如 "channel:feishu:e72a9d...", 替换 : 为 _ 即可
  return sessionId.replace(/[:/\\<>:"|?*]/g, "_");
}

/** Bound histories reference the desktop message; both are committed by one owner transaction. */
export function appendBoundHistory(sessionId:string,conversationId:string|null,role:'user'|'assistant',content:string,metadata:BoundConversationMessageMetadata):boolean {
  if(!conversationId)return false;
  const sql=sqlHistory();if(!sql)return false;
  const id=metadata.messageId?'channel:'+createHash('sha256').update(JSON.stringify([metadata.channel,sessionId,conversationId,metadata.messageId,role])).digest('hex'):randomUUID();
  const at=Date.now();
  sql.call('services.historyBind','channel-history',safeName(sessionId),{
    conversationId,
    entry:{id:metadata.messageId?`${role}:${metadata.messageId}`:id,role,at:new Date(at).toISOString()},
    message:{id,role:role==='assistant'?'model':'user',content,at,modelContext:metadata.modelContext,sticker:metadata.sticker,
      channelSource:{channel:metadata.channel,chatType:metadata.chatType,senderName:metadata.senderName}},
  });
  return true;
}

/** 追加一条. role 只能是 user/assistant (dispatcher 内部强制). */
export function appendHistory(sessionId: string, role: "user" | "assistant", content: string, messageId?: string): void {
  if (!sessionId || !content) return;
  const entry: HistoryEntry = { role, content, at: new Date().toISOString(), ...(messageId ? {id: `${role}:${messageId}`} : {}) };
  const sql=sqlHistory();if(sql){sql.call('services.historyAppend','channel-history',safeName(sessionId),{...entry,id:entry.id??randomUUID()});return;}
}

/** 读最近 N 条历史, 按时间顺序 (旧 → 新). */
export function loadRecentHistory(sessionId: string, limit: number): HistoryEntry[] {
  if (!sessionId || limit <= 0) return [];
  const sql=sqlHistory();return sql.call('services.historyRecent','channel-history',safeName(sessionId),limit).map(({role,content,at}:HistoryEntry)=>({role,content,at}));
}

/** 旧版历史迁移：sessionId 键控从 senderId 改为 chatId（QQ 群聊需要按会话聚合）后，
 *  飞书 p2p 的 chatId(oc_xxx) 与 senderId(ou_xxx) 属于不同 ID 空间，老用户升级后
 *  按新键找不到旧滑窗文件。这里一次性把旧文件 copy 到新键（保留原文件兜底），
 *  已存在新文件时不覆盖，保证幂等。 */
export function migrateHistory(fromSessionId: string, toSessionId: string): void {
  if (!fromSessionId || !toSessionId || fromSessionId === toSessionId) return;
  const sql=sqlHistory();if(sql){sql.call('services.historyCopy','channel-history',safeName(fromSessionId),safeName(toSessionId));return;}
}

/** 启动时所有 session 文件预读 (可选, dispatcher 用不到, 预留给将来的调试 UI). */
export function reloadAllHistory(): Map<string, HistoryEntry[]> {
  const sql=sqlHistory();if(sql)return new Map(Object.entries(sql.all()).map(([key,rows])=>[key.replace(/_/g,':'),rows.slice(-MAX_FILE_LINES)]));
  throw Error("SQLITE_SERVICE_UNAVAILABLE:channel-history");
}
