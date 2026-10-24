export type ModelErrorCategory =
  | "AUTH" | "PERMISSION" | "BILLING" | "QUOTA" | "RATE_LIMIT" | "INVALID_REQUEST"
  | "NOT_FOUND" | "CONTEXT_LIMIT" | "PAYLOAD_TOO_LARGE" | "CONTENT_POLICY" | "CONFLICT"
  | "TIMEOUT" | "NETWORK" | "OVERLOADED" | "SERVER_ERROR" | "UNAVAILABLE" | "CANCELLED" | "UNKNOWN";

export interface ModelFailureInfo {
  provider: string;
  model: string;
  category: ModelErrorCategory;
  status?: number;
  vendorCode?: string;
  vendorType?: string;
  requestId?: string;
  docsUrl?: string;
  retryable?: boolean | "conditional";
}

export function isModelFailureInfo(value: unknown): value is ModelFailureInfo {
  if (typeof value !== "object" || value === null) return false;
  const info = value as Record<string, unknown>;
  return typeof info.provider === "string" && typeof info.model === "string"
    && typeof info.category === "string" && ["AUTH", "PERMISSION", "BILLING", "QUOTA", "RATE_LIMIT", "INVALID_REQUEST", "NOT_FOUND", "CONTEXT_LIMIT", "PAYLOAD_TOO_LARGE", "CONTENT_POLICY", "CONFLICT", "TIMEOUT", "NETWORK", "OVERLOADED", "SERVER_ERROR", "UNAVAILABLE", "CANCELLED", "UNKNOWN"].includes(info.category)
    && (info.status === undefined || (typeof info.status === "number" && Number.isInteger(info.status)))
    && ["vendorCode", "vendorType", "requestId", "docsUrl"].every((key) => info[key] === undefined || typeof info[key] === "string");
}
