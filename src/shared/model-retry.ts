import type { ModelErrorCategory } from "./model-error";
import { isModelFailureInfo } from "./model-error";

/** 仅用于当前运行的进度事件，不应进入持久化消息。 */
export interface ModelRetryStatus {
  phase: "waiting" | "attempting" | "cleared";
  retryNumber: number;
  maxRetries: number;
  delayMs?: number;
  category?: ModelErrorCategory;
}

export function isModelRetryStatus(value: unknown): value is ModelRetryStatus {
  if (!value || typeof value !== "object") return false;
  const status = value as ModelRetryStatus;
  return ["waiting", "attempting", "cleared"].includes(status.phase)
    && Number.isInteger(status.maxRetries) && status.maxRetries >= 0 && status.maxRetries <= 10
    && Number.isInteger(status.retryNumber) && status.retryNumber >= 0 && status.retryNumber <= status.maxRetries
    && (status.delayMs === undefined || (Number.isFinite(status.delayMs) && status.delayMs >= 0))
    && (status.category === undefined || isModelFailureInfo({ provider: "", model: "", category: status.category }));
}
