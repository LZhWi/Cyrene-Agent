import type {
  ChatMessageViewModel,
  ChatSessionViewModel,
  ChatMessageStatus,
} from "./chat.types";

export function createMessageViewModel(
  partial: Partial<ChatMessageViewModel> & Pick<ChatMessageViewModel, "id" | "role" | "content">,
): ChatMessageViewModel {
  return {
    status: "completed" as ChatMessageStatus,
    createdAt: Date.now(),
    ...partial,
  };
}

export function createSessionViewModel(
  partial: Partial<ChatSessionViewModel> & Pick<ChatSessionViewModel, "id">,
): ChatSessionViewModel {
  return {
    title: "新对话",
    mode: "chat",
    updatedAt: Date.now(),
    ...partial,
  };
}
