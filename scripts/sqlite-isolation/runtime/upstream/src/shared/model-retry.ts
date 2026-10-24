import type { ModelErrorCategory } from "./model-error";

/** 仅用于当前运行的进度事件，不应进入持久化消息。 */
export interface ModelRetryStatus {
  phase: "waiting" | "attempting" | "cleared";
  retryNumber: number;
  maxRetries: number;
  delayMs?: number;
  category?: ModelErrorCategory;
}
