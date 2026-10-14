import type { ChatMessage } from "../../../../../shared/chat-types";

export function CallEventCard({ event }: { event: NonNullable<ChatMessage["callEvent"]> }) {
  const minutes = Math.max(1, Math.round((event.endedAt - event.startedAt) / 60_000));
  return (
    <div className="cy-message__user-bubble">
      <div>通话已结束 · 持续约 {minutes} 分钟</div>
      {event.summary && <details><summary>查看通话摘要</summary><p style={{ whiteSpace: "pre-wrap" }}>{event.summary}</p></details>}
    </div>
  );
}
