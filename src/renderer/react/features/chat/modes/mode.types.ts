export type ChatMode =
  | "chat"
  | "work"
  | "code"
  | "learn"
  | "daily";

export interface ChatModeDefinition {
  id: ChatMode;
  label: string;
  description: string;
  supportsProjects: boolean;
  supportsTools: boolean;
  supportsAttachments: boolean;
  supportsLearningProgress: boolean;
  supportsDailyContext: boolean;
  composerPlaceholder: string;
}
