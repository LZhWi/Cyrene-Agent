import type { ChatMode, ChatModeDefinition } from "./mode.types";

export const chatModeRegistry: Record<ChatMode, ChatModeDefinition> = {
  chat: {
    id: "chat",
    label: "Chat",
    description: "普通聊天",
    supportsProjects: false,
    supportsTools: false,
    supportsAttachments: true,
    supportsLearningProgress: false,
    supportsDailyContext: false,
    composerPlaceholder: "和昔涟聊聊天吧",
  },

  work: {
    id: "work",
    label: "Work",
    description: "工具与任务模式",
    supportsProjects: true,
    supportsTools: true,
    supportsAttachments: true,
    supportsLearningProgress: false,
    supportsDailyContext: false,
    composerPlaceholder: "描述需要完成的任务",
  },

  code: {
    id: "code",
    label: "Code",
    description: "代码工作模式",
    supportsProjects: true,
    supportsTools: true,
    supportsAttachments: true,
    supportsLearningProgress: false,
    supportsDailyContext: false,
    composerPlaceholder: "描述代码任务",
  },

  learn: {
    id: "learn",
    label: "Learn",
    description: "学习模式",
    supportsProjects: false,
    supportsTools: true,
    supportsAttachments: true,
    supportsLearningProgress: true,
    supportsDailyContext: false,
    composerPlaceholder: "今天想学习什么？",
  },

  daily: {
    id: "daily",
    label: "Daily",
    description: "日常辅助模式",
    supportsProjects: false,
    supportsTools: true,
    supportsAttachments: true,
    supportsLearningProgress: false,
    supportsDailyContext: true,
    composerPlaceholder: "今天有什么安排？",
  },
};
