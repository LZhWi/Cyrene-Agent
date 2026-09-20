export interface AuditMessage { id: string; role: "user" | "model"; content: string }
export interface AuditSession { id: string; messages: AuditMessage[] }
export type AuditResult = "exact-user-message" | "user-session-match" | "assistant-only" | "missing-message" | "missing-session" | "not-found" | "empty" | "deleted";
/** 只证明文本出处，不判断语义蕴含；绝不跨会话猜测或把助手文本算成用户原话。 */
export function auditQuote(quote: string, session: AuditSession | undefined, messageIds?: string[], deleted = false): AuditResult {
  if (deleted) return "deleted";
  if (!quote.trim()) return "empty";
  if (!session) return "missing-session";
  const selected = messageIds?.length ? session.messages.filter((m) => messageIds.includes(m.id)) : session.messages;
  if (messageIds?.some((id) => !selected.some((m) => m.id === id))) return "missing-message";
  if (selected.some((m) => m.role === "user" && m.content.includes(quote))) return messageIds?.length ? "exact-user-message" : "user-session-match";
  if (selected.some((m) => m.role === "model" && m.content.includes(quote))) return "assistant-only";
  return "not-found";
}
