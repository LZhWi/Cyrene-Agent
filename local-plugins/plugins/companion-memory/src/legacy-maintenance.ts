import { createHash } from "node:crypto";
import type { SourceSession } from "./source-matcher";
import type { Turn } from "../../companion-chat/src/chat";
import { stripAssistantHiddenText } from "./derived-text";
import { legacyUserText } from "./legacy-sticker-text";

/** Queue inspection never resumes a model call. Missing IDs/versions stay quarantined. */
export function inspectLegacyMaintenance(raw: any, sessions: SourceSession[]) {
  const eligible: Turn[] = [], rejected: Array<{ index: number; reason: string }> = [], seen = new Set<string>();
  for (const [index, item] of (raw?.pendingTurns ?? []).entries()) {
    if (!item || item.sourceUserVersion !== undefined || item.sourceAssistantVersion !== undefined) { rejected.push({ index, reason: "unsupported-source-version" }); continue; }
    const session = sessions.find(s => s.id === item.conversationId);
    const user = session?.messages.find(m => m.id === item.userMessageId), assistant = session?.messages.find(m => m.id === item.assistantMessageId);
    if (!user || !assistant || user.role !== "user" || !["assistant", "model"].includes(assistant.role)) { rejected.push({ index, reason: "missing-source" }); continue; }
    if (legacyUserText(user.content) !== legacyUserText(item.sourceUserText ?? item.userInput ?? "") || stripAssistantHiddenText(assistant.content) !== stripAssistantHiddenText(item.assistantReply ?? "")
      || user.at !== item.userAt || assistant.at !== item.assistantAt || assistant.at < user.at) { rejected.push({ index, reason: "source-changed" }); continue; }
    const key = JSON.stringify([session!.id, user.id, assistant.id]);
    if (seen.has(key)) { rejected.push({ index, reason: "duplicate" }); continue; } seen.add(key);
    eligible.push({ id: `legacy-pending:${createHash("sha256").update(key).digest("hex")}`, sessionId: session!.id, user: user.content, assistant: stripAssistantHiddenText(assistant.content), userAt: user.at, assistantAt: assistant.at, inputMessageId: user.id, finalMessageId: assistant.id, origin: "host" });
  }
  return { eligible, rejected, historicalRoundCount: raw?.l1?.roundCount ?? 0,
    countedTurnRecords: raw?.roundCountState?.turns?.length ?? 0, reflectionLogs: raw?.reflectionLogs?.length ?? 0,
    conflictLogs: raw?.conflictLogs?.length ?? 0, token: createHash("sha256").update(JSON.stringify({ eligible, rejected })).digest("hex") };
}
