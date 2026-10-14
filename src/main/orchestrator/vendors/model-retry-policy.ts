import type { ModelErrorCategory, ModelFailureInfo } from "../../../shared/model-error";

const TRANSIENT_CATEGORIES = new Set<ModelErrorCategory>([
  "NETWORK", "TIMEOUT", "RATE_LIMIT", "OVERLOADED", "SERVER_ERROR", "UNAVAILABLE",
]);
const TERMINAL_CATEGORIES = new Set<ModelErrorCategory>([
  "AUTH", "PERMISSION", "BILLING", "QUOTA", "INVALID_REQUEST", "NOT_FOUND",
  "CONTEXT_LIMIT", "PAYLOAD_TOO_LARGE", "CONTENT_POLICY", "CONFLICT", "CANCELLED", "UNKNOWN",
]);
const INITIAL_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 60_000;
export const MAX_RETRY_AFTER_MS = 5 * 60_000;

export function shouldRetryModelFailure(info: ModelFailureInfo): boolean {
  if (TERMINAL_CATEGORIES.has(info.category)) return false;
  if (info.retryable === false || info.retryable === "conditional") return false;
  return TRANSIENT_CATEGORIES.has(info.category);
}

export function nextModelRetryDelayMs(
  retryNumber: number,
  retryAfterMs?: number,
  random: () => number = Math.random,
): number | undefined {
  if (retryAfterMs !== undefined) {
    if (!Number.isFinite(retryAfterMs) || retryAfterMs < 0 || retryAfterMs > MAX_RETRY_AFTER_MS) return undefined;
    return retryAfterMs;
  }
  const exponent = Math.max(0, Math.trunc(retryNumber) - 1);
  const baseDelay = Math.min(MAX_BACKOFF_MS, INITIAL_BACKOFF_MS * (2 ** exponent));
  const jitter = 0.5 + Math.max(0, Math.min(1, random())) * 0.5;
  return Math.round(baseDelay * jitter);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function readHeader(source: unknown): string | undefined {
  if (typeof source !== "object" || source === null) return undefined;
  const candidate = source as { get?: (name: string) => unknown };
  if (typeof candidate.get === "function") {
    const value = candidate.get("retry-after");
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  const record = asRecord(source);
  if (!record) return undefined;
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() === "retry-after" && (typeof value === "string" || typeof value === "number")) {
      return String(value).trim();
    }
  }
  return undefined;
}

function parseRetryAfter(value: string, nowMs: number): number | undefined {
  if (!value) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(value)) return Math.round(Number(value) * 1_000);
  const dateMs = Date.parse(value);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - nowMs) : undefined;
}

export function readRetryAfterMs(headersOrError: unknown, nowMs = Date.now()): number | undefined {
  const queue: unknown[] = [headersOrError];
  const visited = new Set<object>();
  for (let depth = 0; queue.length && depth < 8; depth += 1) {
    const current = queue.shift();
    const record = asRecord(current);
    if (!record) continue;
    if (visited.has(record)) continue;
    visited.add(record);

    const directMs = record.retryAfterMs;
    if (typeof directMs === "number" && Number.isFinite(directMs) && directMs >= 0) return directMs;
    const headerValue = readHeader(record.headers);
    if (headerValue) {
      const parsed = parseRetryAfter(headerValue, nowMs);
      if (parsed !== undefined) return parsed;
    }
    const directHeader = readHeader(record);
    if (directHeader) {
      const parsed = parseRetryAfter(directHeader, nowMs);
      if (parsed !== undefined) return parsed;
    }
    if (record.headers) queue.push(record.headers);
    if (record.response) queue.push(record.response);
    if (record.cause) queue.push(record.cause);
  }
  return undefined;
}
