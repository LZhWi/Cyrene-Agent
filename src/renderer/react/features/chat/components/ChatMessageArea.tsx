import { Bubble, Welcome } from "@ant-design/x";
import type { ChatMessageViewModel } from "../model/chat.types";
import { messageToBubbleProps } from "../adapters/chat-ui.adapter";

interface ChatMessageAreaProps {
  messages: ChatMessageViewModel[];
}

export function ChatMessageArea({ messages }: ChatMessageAreaProps) {
  if (messages.length === 0) {
    return (
      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Welcome
          icon={
            <span style={{ fontSize: 48, opacity: 0.6 }}>✨</span>
          }
          title="昔涟期待与你聊天哦"
          description="说点什么开始对话吧"
          style={{ width: "100%", maxWidth: 400 }}
        />
      </div>
    );
  }

  return (
    <div
      style={{
        flex: 1,
        overflowY: "auto",
        padding: "34px 88px 18px",
        display: "flex",
        flexDirection: "column",
        gap: 18,
      }}
    >
      {messages.map((msg) => (
        <Bubble key={msg.id} {...messageToBubbleProps(msg)} />
      ))}
    </div>
  );
}
