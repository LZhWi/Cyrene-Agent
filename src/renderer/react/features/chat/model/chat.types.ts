export type ChatMessageRole = "user" | "assistant" | "system" | "tool";

export type ChatMessageStatus =
  | "pending"
  | "streaming"
  | "completed"
  | "error"
  | "cancelled";

export interface AttachmentViewModel {
  id: string;
  name: string;
  kind: "image" | "document";
  filePath?: string;
  mime?: string;
  previewUrl?: string;
  caption?: string;
  status: "pending" | "done" | "error";
}

export interface ReasoningStepViewModel {
  id: string;
  content: string;
  status: "pending" | "active" | "completed";
}

export interface SourceViewModel {
  id: string;
  title: string;
  url?: string;
  snippet?: string;
}

export interface ChatMessageViewModel {
  id: string;
  role: ChatMessageRole;
  content: string;
  status: ChatMessageStatus;
  createdAt?: number;
  attachments?: AttachmentViewModel[];
  reasoning?: ReasoningStepViewModel[];
  sources?: SourceViewModel[];
  errorMessage?: string;
}

export interface ChatSessionViewModel {
  id: string;
  title: string;
  mode: string;
  updatedAt: number;
  unread?: boolean;
}

export interface ChatSubmitPayload {
  content: string;
  attachments?: AttachmentViewModel[];
}
