import type { ChatMessage } from "../../shared/chat-types";
import type { MemoryEntry } from "../rag/vectorstore";
import { historyIndexText } from "./history-index-text";

/** Check durable coverage by message identity, independently of a positional backfill cursor. */
export function missingHistoryTurns(sessionId: string, messages: ChatMessage[], entries: Pick<MemoryEntry, "text" | "metadata">[]): string[] {
  const covered = new Map<string, Array<{ text: string; ts: unknown; role: unknown }>>();
  for (const entry of entries) {
    const occurrences = Array.isArray(entry.metadata?.occurrences) ? entry.metadata.occurrences : [entry.metadata];
    for (const occurrence of occurrences) {
      if (occurrence?.sessionId !== sessionId || typeof occurrence.turnId !== "string") continue;
      const rows = covered.get(occurrence.turnId) ?? [];
      rows.push({ text: entry.text, ts: occurrence.ts, role: occurrence.role });
      covered.set(occurrence.turnId, rows);
    }
  }
  return messages.filter(message => {
    if (!["user", "model", "assistant"].includes(message.role)) return false;
    const text = historyIndexText(message);
    if (!text) return false;
    return !(covered.get(message.id) ?? []).some(row => row.text === text && row.ts === message.at
      && row.role === (message.role === "user" ? "user" : "assistant"));
  }).map(message => message.id);
}
