import map from "./model-error-map.json";
import type { ModelErrorCategory, ModelFailureInfo } from "../../../shared/model-error";

type Entry = { category: ModelErrorCategory; retryable?: boolean | "conditional" };
type ProviderMap = {
  http?: Record<string, Entry>;
  business_codes?: Record<string, Entry>;
  codes?: Record<string, Entry>;
  types?: Record<string, Entry>;
  structured_codes?: Record<string, ModelErrorCategory>;
  http_fallback?: Record<string, ModelErrorCategory>;
  message_overrides?: Array<{ code?: string; contains: string[]; category: ModelErrorCategory; retryable?: boolean | "conditional" }>;
  docsUrl?: string;
};

const providers = (map as { providers: Record<string, ProviderMap> }).providers;
const providerAliases: Record<string, string> = { openai: "chatgpt", anthropic: "claude", doubao_seed: "doubao", xai_grok: "grok" };

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function safeString(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const result = String(value).trim();
  return result && result.length <= 160 && !/[\r\n]/.test(result)
    && !/\bBearer\s|\bsk-[A-Za-z0-9_-]{8,}\b|\b(?:api[_-]?key|authorization)\s*[:=]/i.test(result)
    ? result : undefined;
}

export function classifyModelFailure(input: {
  provider: string; model: string; status?: number; error?: unknown;
}): ModelFailureInfo {
  const provider = providerAliases[input.provider.toLowerCase()] ?? input.provider.toLowerCase();
  const table = providers[provider];
  const root = record(input.error);
  const protocolDetails = record(root?.providerDetails);
  const errorName = safeString(root?.name)?.toLowerCase();
  const response = record(root?.response);
  const responseData = record(response?.data);
  const bodyError = record(root?.error) ?? record(responseData?.error);
  const status = input.status ?? (typeof root?.status === "number" ? root.status : undefined)
    ?? (typeof protocolDetails?.status === "number" ? protocolDetails.status : undefined);
  const vendorCode = safeString(bodyError?.code ?? protocolDetails?.vendorCode ?? root?.vendorCode ?? root?.code ?? root?.error_code ?? root?.errorCode);
  const vendorType = safeString(bodyError?.type ?? bodyError?.status ?? protocolDetails?.vendorType ?? root?.vendorType ?? root?.type ?? root?.error_type);
  const requestId = safeString(root?.request_id ?? root?.requestId ?? root?.["x-request-id"] ?? protocolDetails?.requestId ?? root?.id);
  let entry: Entry | undefined = vendorCode
    ? table?.business_codes?.[vendorCode] ?? table?.codes?.[vendorCode]
    : undefined;
  const providerMessage = safeString(bodyError?.message ?? root?.message)?.toLowerCase();
  const messageOverride = table?.message_overrides?.find((override) =>
    (!override.code || override.code === vendorCode)
    && providerMessage
    && override.contains.some((needle) => providerMessage.includes(needle.toLowerCase())));
  if (messageOverride) entry = { category: messageOverride.category, retryable: messageOverride.retryable };
  if (!entry && vendorCode && table?.structured_codes?.[vendorCode]) {
    entry = { category: table.structured_codes[vendorCode] };
  }
  if (!entry && vendorType) entry = table?.types?.[vendorType];
  if (!entry && status) entry = table?.http?.[String(status)];
  if (!entry && status) {
    const category = table?.http_fallback?.[String(status)];
    if (category) entry = { category, retryable: status === 429 || status >= 500 };
  }
  // Message heuristics are intentionally disabled: provider text is not a stable code surface.
  const category = entry?.category
    ?? (status === 408 || status === 504 || errorName?.includes("timeout") ? "TIMEOUT"
      : errorName?.includes("connection") || ["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"].includes(vendorCode ?? "")
        ? "NETWORK" : "UNKNOWN");
  return {
    provider, model: input.model, category,
    ...(Number.isInteger(status) ? { status } : {}),
    ...(vendorCode ? { vendorCode } : {}), ...(vendorType ? { vendorType } : {}),
    ...(requestId ? { requestId } : {}), ...(table?.docsUrl ? { docsUrl: table.docsUrl } : {}),
    ...(entry?.retryable !== undefined ? { retryable: entry.retryable } : {}),
  };
}
