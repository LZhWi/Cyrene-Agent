import { createHash } from "node:crypto";
import type { Entry } from "./entries";
import type { SourceSession, SourceMessage } from "./source-matcher";
import { stripAssistantHiddenText } from "./derived-text";
import { legacyUserText } from "./legacy-sticker-text";

export interface LegacySource {
  conversationId: string;
  messageIds: string[];
  evidence: Array<{ conversationId: string; messageId: string; quote: string }>;
  contentRevision?: number;
  parentEntryIds?: string[];
}
export function validateLegacySource(source: LegacySource): void {
  if (!source || typeof source.conversationId !== "string" || !Array.isArray(source.messageIds)
    || source.messageIds.some(id => typeof id !== "string" || !id) || new Set(source.messageIds).size !== source.messageIds.length
    || !Array.isArray(source.evidence) || source.evidence.some(e => !e || ![e.conversationId, e.messageId, e.quote].every(s => typeof s === "string" && s.length > 0))
    || (source.contentRevision !== undefined && (!Number.isSafeInteger(source.contentRevision) || source.contentRevision < 0))) throw new Error("旧记忆来源绑定损坏");
  if (source.parentEntryIds !== undefined && (!Array.isArray(source.parentEntryIds) || source.parentEntryIds.length < 2 || source.parentEntryIds.length > 100 || new Set(source.parentEntryIds).size !== source.parentEntryIds.length || source.parentEntryIds.some(id => typeof id !== "string" || !id))) throw new Error("旧裁决来源谱系损坏");
}
export const messageVersion = (message: SourceMessage) => createHash("sha256").update(JSON.stringify([message.role === "model" ? "assistant" : message.role, message.role === "user" ? message.content : stripAssistantHiddenText(message.content), message.at])).digest("hex");

/** Original IDs are hints only. Rebind only after the selected host messages also match the saved quotes. */
export function explicitLegacySources(entry: Entry, sessions: SourceSession[]) {
  const source = entry.legacySource;
  if (!source || (!source.messageIds.length && !source.evidence.length)) return undefined;
  const refs = [...source.evidence, ...source.messageIds.filter(id => !source.evidence.some(e => e.conversationId === source.conversationId && e.messageId === id))
    .map(messageId => ({ conversationId: source.conversationId, messageId, quote: entry.triggerText?.trim() || entry.quote.trim() }))];
  const matches = refs.map(ref => {
    const session = sessions.find(s => s.id === ref.conversationId);
    const message = session?.messages.find(m => m.id === ref.messageId);
    if (!message || message.role !== "user" || !ref.quote || !legacyUserText(message.content).includes(legacyUserText(ref.quote))) throw new Error("旧来源 ID 或原文未通过核验");
    return { session: session!, message };
  });
  return matches.filter((item, index) => matches.findIndex(other => other.session.id === item.session.id && other.message.id === item.message.id) === index);
}

const quoteText = (text: string) => legacyUserText(text).normalize("NFC").replace(/[\p{P}\p{S}\s]/gu, "");
/** Locate every excerpt in order; never use similarity or silently drop an unmatched clause. */
export function excerptLegacySources(entry: Entry, sessions: SourceSession[]) {
  const quote = entry.quote.trim() || entry.triggerText?.trim() || "";
  const normalized = quoteText(quote);
  if (normalized.length >= 8) {
    const whole = sessions.flatMap(session => session.messages.filter(message => message.role === "user" && quoteText(message.content).includes(normalized)).map(message => ({ session, message })));
    if (whole.length) return whole.length === 1 ? whole : undefined;
  }
  const fragments = quote.split(/…+|\.{3,}|[。！？；\n]| \/ /).map(quoteText).filter(Boolean);
  if (fragments.length < 2 || fragments.join("").length < 16) {
    // Old extraction sometimes removed a parenthetical clause without an ellipsis.
    // Comma-fragment matching requires the exact saved source timestamp as an additional anchor.
    const clauses = quote.split(/[,，:：]/).map(quoteText).filter(Boolean);
    if (clauses.length < 2 || clauses.join("").length < 24) return undefined;
    const matches = sessions.flatMap(session => session.messages.filter(message => {
      if (message.role !== "user" || message.at !== entry.sourceAt) return false;
      const text = quoteText(message.content); let cursor = 0;
      for (const clause of clauses) { const at = text.indexOf(clause, cursor); if (at < 0 || (cursor && at - cursor > 200)) return false; cursor = at + clause.length; }
      return true;
    }).map(message => ({ session, message })));
    return matches.length === 1 ? matches : undefined;
  }
  const users = sessions.flatMap(session => session.messages.flatMap((message, index) => message.role === "user" ? [{ session, message, index }] : []));
  const matches = fragments.map(fragment => users.filter(item => quoteText(item.message.content).includes(fragment)));
  if (matches.some(hits => hits.length !== 1)) return undefined;
  const rows = matches.map(hits => hits[0]);
  if (rows.some(row => row.session.id !== rows[0].session.id) || rows.at(-1)!.index - rows[0].index > 32) return undefined;
  let lastIndex = -1, cursor = 0;
  for (const [i, row] of rows.entries()) {
    if (row.index < lastIndex) return undefined;
    if (row.index !== lastIndex) cursor = 0;
    const at = quoteText(row.message.content).indexOf(fragments[i], cursor);
    if (at < 0) return undefined;
    cursor = at + fragments[i].length; lastIndex = row.index;
  }
  return rows.filter((row, i) => rows.findIndex(other => other.message.id === row.message.id) === i).map(({ session, message }) => ({ session, message }));
}

export const sourceNodes = (entries: Entry[]) => entries.map(entry => ({ id: entry.id,
  isSummary: entry.isSummary || Boolean(entry.legacySource?.parentEntryIds), subEntryIds: entry.subEntryIds ?? entry.legacySource?.parentEntryIds }));
