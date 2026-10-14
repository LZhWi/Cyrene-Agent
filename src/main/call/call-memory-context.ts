import type { ChatMessage } from "../../shared/chat-types";
import type { CallContextEvent } from "./call-context-store";

/** Matches local Chat: external events compete with messages in the latest 16-item window. */
export function callMemoryContext(messages: ChatMessage[], inputMessageId: string, events: CallContextEvent[]): string {
  const index = messages.findIndex(message => message.id === inputMessageId && message.role === "user");
  if (index < 0) return "";
  const history = messages.slice(0, index + 1);
  const currentAt = history.at(-1)!.at;
  const previousAt = history.slice(0, -1).filter(message => ["user", "model"].includes(message.role)).at(-1)?.at;
  const timeline = [...history.map(message => ({ at: message.at, event: undefined as CallContextEvent | undefined })),
    ...events.filter(event => event.startedAt <= currentAt).map(event => ({ at: event.startedAt, event }))]
    .sort((left, right) => left.at - right.at).slice(-16);
  const selected = timeline.flatMap(item => item.event && item.event.endedAt > (previousAt ?? currentAt - 86_400_000) ? [item.event] : []);
  if (!selected.length) return "";
  return ["[此前语音通话梗概，仅作为记忆判定的事实来源]", ...selected.map(event =>
    `- 通话时间 ${new Date(event.startedAt).toISOString()}，持续约 ${Math.max(1, Math.round((event.endedAt - event.startedAt) / 60_000))} 分钟：${event.summary.trim()}`)].join("\n");
}
