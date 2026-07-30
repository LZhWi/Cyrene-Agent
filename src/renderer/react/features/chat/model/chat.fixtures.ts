import type {
  ChatMessageViewModel,
  ChatSessionViewModel,
} from "./chat.types";

export const mockSessions: ChatSessionViewModel[] = [
  {
    id: "session-1",
    title: "关于天气的闲聊",
    mode: "chat",
    updatedAt: Date.now() - 3600_000,
  },
  {
    id: "session-2",
    title: "项目代码重构",
    mode: "work",
    updatedAt: Date.now() - 7200_000,
  },
  {
    id: "session-3",
    title: "学习 React Hooks",
    mode: "learn",
    updatedAt: Date.now() - 86400_000,
  },
];

export const mockMessages: ChatMessageViewModel[] = [
  {
    id: "msg-welcome",
    role: "assistant",
    content: "你好！我是昔涟，很高兴见到你 ✨",
    status: "completed",
    createdAt: Date.now() - 60_000,
  },
  {
    id: "msg-user-1",
    role: "user",
    content: "今天天气怎么样？",
    status: "completed",
    createdAt: Date.now() - 50_000,
  },
  {
    id: "msg-assistant-1",
    role: "assistant",
    content:
      "今天天气不错呢！温度大约 25°C，晴朗无云，很适合出去走走 ☀️\n\n如果你需要更详细的天气信息，可以告诉我你所在的城市哦。",
    status: "completed",
    createdAt: Date.now() - 40_000,
  },
  {
    id: "msg-thinking",
    role: "assistant",
    content: "",
    status: "streaming",
    createdAt: Date.now(),
  },
];

export const mockEmptyMessages: ChatMessageViewModel[] = [];
