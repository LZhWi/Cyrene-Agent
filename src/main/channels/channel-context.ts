import { createHash } from "crypto";
import type { PreparedOutgoing } from "./outgoing-composer";
import type { ChannelId, IncomingMessage } from "./types";

const LOG = "[ChannelContext]";

/** 用于拼接历史对话的轻量消息结构。 */
export interface ChatMessage {
  role: "user" | "assistant" | "system" | "tool";
  content?: string;
}

/** 单条入站消息已经确定的上下文快照。 */
export interface DispatchContext {
  sessionId: string;
  boundConversationId: string | null;
}

/** 写入绑定桌面会话时携带的渠道元数据。 */
export interface BoundConversationMessageMetadata {
  messageId?: string;
  sourceSessionId?: string;
  channel: ChannelId;
  chatType: "private" | "group";
  senderName?: string;
  modelContext?: string;
  /** 本轮已确认发送的内置或用户表情包编号。 */
  sticker?: string;
}

export interface ChannelContext {
  onJournalCommitted?: (conversationId:string|null)=>void;
  /** 解析一次绑定并生成本条消息使用的上下文快照。 */
  resolveDispatchContext(sessionId: string): DispatchContext;
  /** 迁移旧历史键并记录会话与原始发送者的关系。 */
  recordIncomingSession(msg: IncomingMessage, context: DispatchContext): void;
  /** 读取快照指向的历史；绑定历史不可用时回退到渠道历史。 */
  resolvePriorMessages(
    context: DispatchContext,
    limit: number,
  ): Promise<ChatMessage[] | undefined>;
  /** 写入渠道用户历史，并按快照选择是否镜像到桌面会话。 */
  appendIncomingContext(
    msg: IncomingMessage,
    context: DispatchContext,
  ): Promise<void>;
  /** 在发送确认后写入渠道助手历史和绑定桌面会话。 */
  appendAssistantContext(
    msg: IncomingMessage,
    context: DispatchContext,
    prepared: PreparedOutgoing,
  ): Promise<void>;
}

export interface CreateChannelContextOptions {
  onJournalCommitted?: (conversationId:string|null)=>void;
  appendJournal?: (sessionId: string, conversationId: string | null, role: 'user' | 'assistant', content: string, metadata: BoundConversationMessageMetadata) => boolean | Promise<boolean>;
  durableHistory?: () => boolean;
  resolveBoundConversationId?: (sessionId: string) => string | null;
  loadRecentChannelHistory?: (
    sessionId: string,
    limit: number,
  ) => Promise<ChatMessage[]>;
  loadBoundConversationHistory?: (
    conversationId: string,
    limit: number,
  ) => Promise<ChatMessage[]>;
  appendChannelHistory: (
    sessionId: string,
    role: "user" | "assistant",
    content: string,
    messageId?: string,
  ) => void | Promise<void>;
  appendBoundConversationMessage?: (
    conversationId: string,
    role: "user" | "assistant",
    content: string,
    metadata: BoundConversationMessageMetadata,
  ) => void | Promise<void>;
  migrateHistory: (fromSessionId: string, toSessionId: string) => void;
}

/** 会话标识到原始发送者的调试索引。 */
const sessionIndex = new Map<
  string,
  { channel: ChannelId; senderId: string; lastAt: number }
>();

/** 计算稳定且匿名的渠道会话标识。 */
export function makeSessionId(channel: ChannelId, chatId: string): string {
  const hash = createHash("sha256")
    .update(`${channel}:${chatId}`)
    .digest("hex")
    .slice(0, 16);
  return `channel:${channel}:${hash}`;
}

/** 生成供模型和渠道历史使用的用户文本。 */
export function formatChannelUserText(msg: IncomingMessage): string {
  if (msg.chatType !== "group") return msg.text;
  const sender = msg.senderName
    ? `${msg.senderName} (${msg.senderId})`
    : msg.senderId;
  const reply = msg.reply?.text
    ? `\n引用 ${msg.reply.senderName || msg.reply.senderId || "未知用户"}：${msg.reply.text}`
    : "";
  return `[群聊发送者：${sender}]${reply}\n${msg.text}`;
}

/** 按会话标识反查原始发送者，仅用于调试。 */
export function lookupOriginalSender(
  sessionId: string,
): { channel: ChannelId; senderId: string } | null {
  const entry = sessionIndex.get(sessionId);
  return entry ? { channel: entry.channel, senderId: entry.senderId } : null;
}

export function createChannelContext(
  options: CreateChannelContextOptions,
): ChannelContext {
  return {
    onJournalCommitted:options.onJournalCommitted,
    resolveDispatchContext(sessionId): DispatchContext {
      let requestedBoundConversationId: string | null = null;
      try {
        requestedBoundConversationId = options.resolveBoundConversationId?.(sessionId) ?? null;
      } catch (err) {
        // 绑定存储故障不能阻断渠道消息，当前消息退回独立渠道上下文。
        console.warn(LOG, "绑定查询失败，继续使用渠道上下文:", err);
      }

      const hasBoundContext = Boolean(
        requestedBoundConversationId && options.loadBoundConversationHistory,
      );
      return {
        sessionId,
        boundConversationId: hasBoundContext
          ? requestedBoundConversationId
          : null,
      };
    },

    recordIncomingSession(msg, context): void {
      options.migrateHistory(
        makeSessionId(msg.channel, msg.senderId),
        context.sessionId,
      );
      recordSession(msg.channel, msg.senderId, context.sessionId);
    },

    async resolvePriorMessages(context, limit): Promise<ChatMessage[] | undefined> {
      if (context.boundConversationId && options.loadBoundConversationHistory) {
        try {
          return await options.loadBoundConversationHistory(
            context.boundConversationId,
            limit,
          );
        } catch (err) {
          console.warn(LOG, "绑定历史读取失败，回退到渠道历史:", err);
        }
      }

      if (!options.loadRecentChannelHistory) return undefined;
      try {
        return await options.loadRecentChannelHistory(context.sessionId, limit);
      } catch (err) {
        console.warn(LOG, "渠道历史读取失败，继续不带历史:", err);
        return undefined;
      }
    },

    async appendIncomingContext(msg, context): Promise<void> {
      const modelText = formatChannelUserText(msg);
      if(await options.appendJournal?.(context.sessionId,context.boundConversationId,'user',msg.text,{
        channel:msg.channel,chatType:msg.chatType??'private',senderName:msg.senderName,
        messageId:msg.messageId,sourceSessionId:context.sessionId,modelContext:modelText===msg.text?undefined:modelText,
      }))return;
      try {
        await options.appendChannelHistory(context.sessionId, "user", modelText, ...(msg.messageId ? [msg.messageId] : []));
      } catch (err) {
        console.warn(LOG, "渠道用户历史写入失败:", err);
        if(options.durableHistory?.())throw err;
      }

      if (!context.boundConversationId || !options.appendBoundConversationMessage) {
        return;
      }
      try {
        await options.appendBoundConversationMessage(
          context.boundConversationId,
          "user",
          msg.text,
          {
            channel: msg.channel,
            ...(msg.messageId ? { messageId: msg.messageId, sourceSessionId: context.sessionId } : {}),
            chatType: msg.chatType ?? "private",
            senderName: msg.senderName,
            modelContext: modelText === msg.text ? undefined : modelText,
          },
        );
      } catch (err) {
        console.warn(LOG, "绑定会话用户消息写入失败:", err);
        if(options.durableHistory?.())throw err;
      }
    },

    async appendAssistantContext(msg, context, prepared): Promise<void> {
      if(await options.appendJournal?.(context.sessionId,context.boundConversationId,'assistant',prepared.assistantText,{
        channel:msg.channel,chatType:msg.chatType??'private',senderName:msg.senderName,
        messageId:msg.messageId,sourceSessionId:context.sessionId,sticker:prepared.stickerId??undefined,
      }))return;
      try {
        await options.appendChannelHistory(
          context.sessionId,
          "assistant",
          prepared.assistantText,
          ...(msg.messageId ? [msg.messageId] : []),
        );
      } catch (err) {
        console.warn(LOG, "渠道助手历史写入失败:", err);
        if(options.durableHistory?.())throw err;
      }

      if (!context.boundConversationId || !options.appendBoundConversationMessage) {
        return;
      }
      try {
        await options.appendBoundConversationMessage(
          context.boundConversationId,
          "assistant",
          prepared.assistantText,
          {
            channel: msg.channel,
            ...(msg.messageId ? { messageId: msg.messageId, sourceSessionId: context.sessionId } : {}),
            chatType: msg.chatType ?? "private",
            senderName: msg.senderName,
            modelContext: undefined,
            ...(prepared.stickerId ? { sticker: prepared.stickerId } : {}),
          },
        );
      } catch (err) {
        console.warn(LOG, "绑定会话助手消息写入失败:", err);
        if(options.durableHistory?.())throw err;
      }
    },
  };
}

/** 更新调试索引，并限制进程内缓存规模。 */
function recordSession(
  channel: ChannelId,
  senderId: string,
  sessionId: string,
): void {
  sessionIndex.set(sessionId, { channel, senderId, lastAt: Date.now() });
  if (sessionIndex.size <= 5000) return;

  const oldest = [...sessionIndex.entries()]
    .sort((a, b) => a[1].lastAt - b[1].lastAt)[0];
  if (oldest) sessionIndex.delete(oldest[0]);
}
