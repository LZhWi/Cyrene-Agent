import type { ChatMessage, ChatVendorAdapter, VendorConfig } from "../orchestrator/vendors";

export interface WorkStructuredProfile {
  mode: "json_object" | "prompt_json";
  maxAttempts: number;
  timeoutMs: number;
}

export function resolveWorkStructuredProfile(adapter: ChatVendorAdapter): WorkStructuredProfile {
  if (adapter.transport === "anthropic" || adapter.id === "minimax") {
    return { mode: "prompt_json", maxAttempts: 2, timeoutMs: 20_000 };
  }
  return { mode: "json_object", maxAttempts: 2, timeoutMs: 20_000 };
}

function extractJson(text: string): unknown {
  const clean = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(clean); } catch { /* continue */ }
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(clean.slice(start, end + 1));
  throw new Error("E_WORK_NO_JSON_OBJECT");
}

async function callModel(
  adapter: ChatVendorAdapter,
  config: VendorConfig,
  messages: ChatMessage[],
  profile: WorkStructuredProfile,
  signal?: AbortSignal,
): Promise<string> {
  const baseRequest = {
    model: config.model,
    messages,
    stream: false,
    maxTokens: 1_200,
    ...(profile.mode === "json_object" ? { extraBody: { response_format: { type: "json_object" } } } : {}),
  };
  const request = adapter.applyCacheHints?.(baseRequest, config) ?? baseRequest;
  const http = adapter.buildRequest(request, config);
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(), profile.timeoutMs);
  try {
    const response = await fetch(http.url, {
      method: "POST",
      headers: http.headers,
      body: http.body,
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Work LLM HTTP ${response.status}${body ? `: ${body.slice(0, 300)}` : ""}`);
    }
    return adapter.parseResponse(await response.json()).text;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

export async function runWorkStructuredOutput<T>(input: {
  adapter: ChatVendorAdapter;
  config: VendorConfig;
  systemPrompt: string;
  userPayload: unknown;
  validate: (value: unknown) => T;
  signal?: AbortSignal;
}): Promise<T> {
  const profile = resolveWorkStructuredProfile(input.adapter);
  let feedback = "";
  let lastError: unknown;
  for (let attempt = 0; attempt < profile.maxAttempts; attempt += 1) {
    const messages: ChatMessage[] = [
      { role: "system", content: `${input.systemPrompt}\n\n只返回一个 JSON 对象，不要使用 Markdown 代码块。` },
      { role: "user", content: JSON.stringify({ input: input.userPayload, repairFeedback: feedback || undefined }) },
    ];
    try {
      const text = await callModel(input.adapter, input.config, messages, profile, input.signal);
      return input.validate(extractJson(text));
    } catch (error) {
      lastError = error;
      feedback = error instanceof Error ? error.message.slice(0, 500) : "invalid structured output";
    }
  }
  throw lastError instanceof Error ? lastError : new Error("E_WORK_STRUCTURED_OUTPUT_FAILED");
}

export async function callWorkTextModel(input: {
  adapter: ChatVendorAdapter;
  config: VendorConfig;
  messages: ChatMessage[];
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<string> {
  const request = input.adapter.applyCacheHints?.({
    model: input.config.model,
    messages: input.messages,
    stream: false,
  }, input.config) ?? { model: input.config.model, messages: input.messages, stream: false };
  const http = input.adapter.buildRequest(request, input.config);
  const controller = new AbortController();
  const abort = () => controller.abort();
  input.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 90_000);
  try {
    const response = await fetch(http.url, {
      method: "POST",
      headers: http.headers,
      body: http.body,
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Work LLM HTTP ${response.status}${body ? `: ${body.slice(0, 500)}` : ""}`);
    }
    return input.adapter.parseResponse(await response.json()).text;
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", abort);
  }
}
