import type { PluginConversationsService, PluginStorage } from "@playa0v0/cyrene-plugin-sdk";
import type { Turn } from "../../companion-chat/src/chat";
import type { Evidence } from "./evidence";
import { messageVersion } from "./legacy-source";

export interface SourceInvalidation { conversationId: string; allMessages: boolean; invalidatedMessageIds: string[] }
const KEY = "pending-source-invalidations";

/** Write intent first; only acknowledge after every derived store has been updated. */
export function createSourceInvalidationQueue(storage: PluginStorage) {
  const queue = storage.get<SourceInvalidation[]>(KEY) ?? [];
  if (!Array.isArray(queue) || queue.some(item => !item || typeof item.conversationId !== "string"
    || typeof item.allMessages !== "boolean" || !Array.isArray(item.invalidatedMessageIds)
    || item.invalidatedMessageIds.some(id => typeof id !== "string"))) throw new Error("来源失效队列损坏");
  return {
    pending: () => structuredClone(queue),
    enqueue(change: SourceInvalidation) {
      queue.push(structuredClone(change));
      storage.set(KEY, queue);
    },
    drain(apply: (change: SourceInvalidation) => void) {
      while (queue.length) {
        apply(queue[0]);
        storage.set(KEY, queue.slice(1));
        queue.shift();
      }
    },
  };
}

/** Audit the authoritative messages, including changes made while the plugin was disabled. */
export async function findInvalidHostSources(conversations: PluginConversationsService | undefined,
  turns: Turn[], evidence: Array<Pick<Evidence, "conversationId" | "messageIds" | "quoteSnippet" | "sourceStatus" | "provenance" | "messageVersions">>,
  signal: AbortSignal): Promise<SourceInvalidation[]> {
  const hostTurns = turns.filter(turn => turn.origin === "host");
  // Imported evidence belongs to the original installation, not this host's conversations.
  const sources = evidence.filter(item => item.provenance === "verified" && item.sourceStatus === "active" && item.conversationId && item.messageIds?.length);
  const ids = new Set([...hostTurns.map(turn => turn.sessionId), ...sources.map(item => item.conversationId!)]);
  if (!ids.size) return [];
  if (!conversations) throw new Error("缺少宿主来源复核能力，暂停加载记忆");
  async function readSessions() {
    const sessions = new Map<string, string>(), cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      if (signal.aborted) throw new Error("来源复核已取消");
      const page = await conversations!.list({ cursor, limit: 100 });
      for (const session of page.items) sessions.set(session.id, JSON.stringify(session));
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error("来源复核游标重复");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return sessions;
  }
  const sessions = await readSessions();
  const changes: SourceInvalidation[] = [];
  for (const conversationId of ids) {
    if (!sessions.has(conversationId)) { changes.push({ conversationId, allMessages: true, invalidatedMessageIds: [] }); continue; }
    const messages = new Map<string, { text: string; role: string; at: string }>();
    const pages = new Set<string>(); let cursor: string | undefined;
    do {
      if (signal.aborted) throw new Error("来源复核已取消");
      const page = await conversations.getMessages({ conversationId, cursor, limit: 100 });
      for (const message of page.items) messages.set(message.id, message);
      cursor = page.nextCursor;
      if (cursor && pages.has(cursor)) throw new Error("来源消息游标重复");
      if (cursor) pages.add(cursor);
    } while (cursor);
    const invalid = new Set<string>();
    for (const turn of hostTurns.filter(item => item.sessionId === conversationId)) {
      for (const [id, text, role, at] of [[turn.inputMessageId, turn.user, "user", turn.userAt],
        [turn.finalMessageId, turn.assistant, "assistant", turn.assistantAt]] as const) {
        if (!id) continue;
        const message = messages.get(id);
        if (!message || message.text !== text || message.role !== role || Date.parse(message.at) !== at) invalid.add(id);
      }
    }
    for (const source of sources.filter(item => item.conversationId === conversationId)) {
      for (const version of source.messageVersions ?? []) {
        const message = messages.get(version.id);
        if (!message || messageVersion({ id: version.id, role: message.role as "user" | "assistant", content: message.text, at: Date.parse(message.at) }) !== version.hash) invalid.add(version.id);
      }
      const sourceMessages = source.messageIds!.map(id => messages.get(id));
      for (const id of source.messageIds!) if (!messages.has(id)) invalid.add(id);
      if (source.quoteSnippet && !sourceMessages.some(message => message?.text.includes(source.quoteSnippet))) {
        source.messageIds!.forEach(id => invalid.add(id));
      }
    }
    if (invalid.size) changes.push({ conversationId, allMessages: false, invalidatedMessageIds: [...invalid] });
  }
  const after = await readSessions();
  if (sessions.size !== after.size || [...sessions].some(([id, version]) => after.get(id) !== version)) {
    throw new Error("来源在复核期间变化，暂停加载记忆");
  }
  return changes;
}
