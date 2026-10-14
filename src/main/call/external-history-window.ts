import type { ChatContextMessage } from "../chat-time-context";
import type { PluginCompanionContextItem } from "../../plugins/api";
export interface CompanionTimelineEvent extends PluginCompanionContextItem {
  kind: "call" | "minecraft";
  startedAt: number;
}
/** Events share the local 16-item window but remain data blocks, not conversation roles. */
export function mergeCompanionHistory(messages: ReadonlyArray<ChatContextMessage>, events: ReadonlyArray<CompanionTimelineEvent>) {
  const candidates = [
    ...messages.map((message, index) => ({ message, event: undefined as CompanionTimelineEvent | undefined, at: message.at, index })),
    ...events.map((event, index) => ({ message: undefined as ChatContextMessage | undefined, event, at: event.startedAt, index: messages.length + index })),
  ];
  candidates.sort((a, b) => {
    const aTime = Number.isFinite(a.at) ? a.at! : Number.MAX_SAFE_INTEGER;
    const bTime = Number.isFinite(b.at) ? b.at! : Number.MAX_SAFE_INTEGER;
    return aTime - bTime || a.index - b.index;
  });
  const recent = candidates.slice(-16);
  return { messages: recent.flatMap(item => item.message ? [{ ...item.message }] : []),
    events: recent.flatMap(item => item.event ? [item.event] : []) };
}
