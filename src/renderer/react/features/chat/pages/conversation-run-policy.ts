import type { ConversationMode } from "../../../../../shared/chat-types";

export function shouldRunModelForMode(
  mode: ConversationMode,
  hasDemoResponse: boolean,
  hasDemoSticker: boolean,
): boolean {
  return (mode === "chat" || mode === "work" || mode === "daily" || mode === "code" || mode === "learn")
    && !hasDemoResponse
    && !hasDemoSticker;
}
