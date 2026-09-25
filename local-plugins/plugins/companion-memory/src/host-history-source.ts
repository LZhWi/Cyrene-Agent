import type { PluginConversationsService } from "@playa0v0/cyrene-plugin-sdk";

export interface HostHistoryMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  text: string;
  at: number;
  images?: Array<{ name: string; caption: string; summary?: string; indexedAt?: number }>;
}

const MAX_CONVERSATIONS = 500;
const MAX_MESSAGES = 20_000;

export function createHostHistorySource(conversations?: PluginConversationsService) {
  async function listChatSessions(signal: AbortSignal) {
    if (!conversations) return [];
    const sessions: Array<{ id: string; updatedAt: string }> = [];
    const cursors = new Set<string>();
    let listed = 0;
    let cursor: string | undefined;
    do {
      if (signal.aborted) throw new Error("历史会话读取已取消");
      const page = await conversations.list({ cursor, limit: 100 });
      listed += page.items.length;
      if (listed > MAX_CONVERSATIONS) throw new Error("历史会话超过单次只读上限");
      sessions.push(...page.items.filter((item) => item.mode === "chat").map((item) => ({ id: item.id, updatedAt: item.updatedAt })));
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error("宿主返回了重复会话游标");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return sessions;
  }

  async function snapshot(signal: AbortSignal): Promise<HostHistoryMessage[]> {
    if (!conversations) return [];
    const sessions = await listChatSessions(signal);
    const result: HostHistoryMessage[] = [];
    for (const session of sessions) {
      const messages: HostHistoryMessage[] = [];
      const ids = new Set<string>(), cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        if (signal.aborted) throw new Error("历史会话读取已取消");
        const page = await conversations.getMessages({ conversationId: session.id, cursor, limit: 100, historyProjection: true });
        for (const item of page.items) {
          const images = (item as typeof item & { images?: Array<{ name: string; caption: string; summary?: string; indexedAt?: number }> }).images;
          const at = Date.parse(item.at);
          if (!item.id || ids.has(item.id) || !Number.isFinite(at) || at < 0 || typeof item.text !== "string") {
            throw new Error("宿主历史消息结构无效");
          }
          ids.add(item.id);
          messages.push({ id: item.id, sessionId: session.id, role: item.role, text: item.text, at,
            ...(images?.length ? { images } : {}) });
          if (result.length + messages.length > MAX_MESSAGES) throw new Error("历史消息超过单次只读上限");
        }
        cursor = page.nextCursor;
        if (cursor && cursors.has(cursor)) throw new Error("宿主返回了重复消息游标");
        if (cursor) cursors.add(cursor);
      } while (cursor);
      // 当前仍在生成回复的末尾用户消息不是过往对话，不进入历史检索。
      while (messages.at(-1)?.role === "user") messages.pop();
      result.push(...messages);
    }
    const latest = await listChatSessions(signal);
    if (JSON.stringify(latest) !== JSON.stringify(sessions)) throw new Error("历史会话在读取期间发生变化，请重试");
    return result;
  }

  return { snapshot };
}
