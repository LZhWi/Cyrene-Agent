import type { ChatSession } from "../../../../src/shared/chat-types";
import { historyIndexText } from "../../../../src/main/chats/history-index-text";
import { stripAssistantHiddenText } from "./derived-text";

interface HistoryIndex { version: 1; entries: Record<string, { text: string; embedding: number[] }> }
interface HistoryRow { source: string; text: string; embedding: number[] }

/** Reuse vectors only for the exact text consumed by the host history reader. */
export function migrateLegacyHistoryIndex(sessions: ChatSession[], rows: HistoryRow[], original: HistoryIndex) {
  const index = structuredClone(original);
  const byText = new Map(rows.filter(row => row.source === "chat_history").map(row => [row.text, row]));
  let added = 0, replaced = 0, retained = 0;
  const missing: string[] = [];
  for (const session of sessions) {
    const messages = session.messages.filter(message => ["user", "assistant", "model"].includes(message.role));
    while (messages.at(-1)?.role === "user") messages.pop();
    for (const message of messages) {
      const projected = historyIndexText(message);
      const text = message.role === "user" ? projected.trim() : stripAssistantHiddenText(projected).trim();
      if (!text) continue;
      const id = `host-message:${session.id}:${message.id}`;
      if (index.entries[id]?.text === text) { retained++; continue; }
      const row = byText.get(text);
      if (!row) { missing.push(id); continue; }
      if (!Array.isArray(row.embedding) || row.embedding.length < 64 || row.embedding.some(value => !Number.isFinite(value))) {
        throw new Error("旧历史向量字段无效");
      }
      if (index.entries[id]) replaced++; else added++;
      index.entries[id] = { text, embedding: [...row.embedding] };
    }
  }
  if (Object.keys(index.entries).length > 20_000) throw new Error("历史向量索引超过容量");
  if (new Set(Object.values(index.entries).map(item => item.embedding.length)).size > 1) throw new Error("历史向量维度不一致");
  return { index, added, replaced, retained, missing };
}
