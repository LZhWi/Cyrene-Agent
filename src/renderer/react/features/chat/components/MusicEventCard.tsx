import type { ChatMessage } from "../../../../../shared/chat-types";

export function MusicEventCard({ event }: { event: NonNullable<ChatMessage["musicEvent"]> }) {
  return <details className="cy-message__user-bubble">
    <summary>听歌记录 · {event.tracks.length} 首</summary>
    <ol>{event.tracks.map((track, index) => <li key={`${track.id}-${index}`}>
      {track.name}{track.artists.length > 0 && ` — ${track.artists.join("、")}`}
    </li>)}</ol>
  </details>;
}
