import type { ConversationMode } from "../../../../../shared/chat-types";

/** Plan review events are emitted after the originating run has finished. */
export function shouldListenForDeferredPlanEvents(mode: ConversationMode): boolean {
  return mode === "code" || mode === "chat";
}
