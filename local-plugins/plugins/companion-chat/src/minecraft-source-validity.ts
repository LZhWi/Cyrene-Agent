import { createHash } from "node:crypto";
import type { createChat } from "./chat";
export function validateMinecraftSources(data: unknown, sessions: ReturnType<ReturnType<typeof createChat>["view"]>["sessions"], signal: AbortSignal) {
  signal.throwIfAborted();
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("来源校验请求无效");
  const v = data as Record<string, unknown>;
  if (v.consent !== true || !Array.isArray(v.turns) || v.turns.length > 200 || Object.keys(v).some((k) => !["consent", "turns"].includes(k))) throw new Error("来源校验请求无效");
  const validTurnIds: string[] = [];
  for (const value of v.turns) {
    signal.throwIfAborted();
    if (!value || typeof value !== "object") throw new Error("来源条目无效");
    const t = value as Record<string, unknown>;
    if (typeof t.sessionId !== "string" || t.sessionId.length > 128 || typeof t.turnId !== "string" || t.turnId.length > 128 || typeof t.fingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(t.fingerprint) || Object.keys(t).some((k) => !["sessionId", "turnId", "fingerprint"].includes(k))) throw new Error("来源条目无效");
    const messages = sessions.find((s) => s.id === t.sessionId)?.messages;
    if (!messages) continue;
    const index = messages.findIndex((m) => m.id === t.turnId && m.role === "user" && (!m.status || m.status === "complete"));
    if (index < 0) continue;
    const user = messages[index], assistant = messages[index + 1];
    if (!assistant || assistant.role !== "assistant" || assistant.status && assistant.status !== "complete") continue;
    const fingerprint = createHash("sha256").update(JSON.stringify([user.text, assistant.text, user.at, assistant.at])).digest("hex");
    if (fingerprint === t.fingerprint) validTurnIds.push(t.turnId);
  }
  return { validTurnIds };
}
