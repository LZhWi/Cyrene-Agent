export { ChatPage } from "./pages/ChatPage";
export { ChatHeader } from "./components/ChatHeader";
export { ChatSidebar } from "./components/ChatSidebar";
export { ChatMessageArea } from "./components/ChatMessageArea";
export { ChatComposer } from "./components/ChatComposer";

export { chatModeRegistry } from "./modes/mode.registry";
export type { ChatMode, ChatModeDefinition } from "./modes/mode.types";

export type {
  ChatMessageViewModel,
  ChatSessionViewModel,
  ChatMessageRole,
  ChatMessageStatus,
  ChatSubmitPayload,
  AttachmentViewModel,
} from "./model/chat.types";

export { messageToBubbleProps } from "./adapters/chat-ui.adapter";
