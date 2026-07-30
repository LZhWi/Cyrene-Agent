import type { BubbleProps } from "@ant-design/x";
import type { ChatMessageViewModel } from "../model/chat.types";

export function messageToBubbleProps(msg: ChatMessageViewModel): BubbleProps {
  return {
    content: msg.content,
    placement: msg.role === "user" ? "end" : "start",
    loading: msg.status === "streaming" && !msg.content,
    typing:
      msg.status === "streaming"
        ? { step: 2, interval: 50, suffix: <>💗</> }
        : undefined,
  };
}
