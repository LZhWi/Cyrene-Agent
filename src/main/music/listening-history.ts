import { randomUUID } from "node:crypto";
import type { ChatMessage, ChatSession } from "../../shared/chat-types";
import type { PlaybackState } from "../../shared/music-types";

export function createListeningHistory(deps: {
  activeSessionId(): string | null;
  getSession(id: string): ChatSession | null;
  save(sessionId: string, message: ChatMessage): void;
}) {
  let group: { sessionId: string; messageId: string } | undefined;
  let lastTrack: string | undefined;
  let observed: { id: string; position: number } | undefined;
  return (state: PlaybackState) => {
    if (!state.connected || !state.loaded) { group = undefined; lastTrack = undefined; observed = undefined; return; }
    if (!state.track || state.paused || state.position <= 0 || state.eofReached) return;
    const track = state.track;
    if (lastTrack === track.encryptedId) return;
    const advancing = observed?.id === track.encryptedId && state.position > observed.position;
    observed = { id: track.encryptedId, position: state.position };
    if (!advancing) return;
    const sessionId = group?.sessionId ?? deps.activeSessionId();
    if (!sessionId) return;
    const session = deps.getSession(sessionId);
    if (!session || session.mode !== "chat") return;
    const previous = group ? session.messages.find((message) => message.id === group!.messageId) : undefined;
    // 用户已删除该记录时，不因后续播放状态更新将它恢复。
    if (group && !previous) { lastTrack = track.encryptedId; return; }
    const now = Date.now();
    const message: ChatMessage = previous ?? { id: randomUUID(), role: "user", content: "", at: now };
    const tracks = message.musicEvent?.tracks ?? [];
    const next: ChatMessage = { ...message, musicEvent: { startedAt: message.musicEvent?.startedAt ?? now,
      tracks: [...tracks, { id: track.encryptedId, name: track.name, artists: [...track.artists], playedAt: now }] } };
    deps.save(sessionId, next);
    group = { sessionId, messageId: message.id };
    lastTrack = track.encryptedId;
  };
}
