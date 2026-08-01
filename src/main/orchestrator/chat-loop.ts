import { stripLeakedChatTimeContext } from "../chat-time-context";
import { recordUsage } from "../token-usage-store";
import { AgentRuntimeError } from "./agent-runtime-error";
import type {
  AgentLoopSettings,
  TwoPhaseEvent,
  TwoPhaseFcResult,
} from "./two-phase-fc-loop";
import type {
  ChatMessage,
  ChatRequest,
  ChatVendorAdapter,
  ChatResponse,
  VendorConfig,
} from "./vendors/types";
import { createSseReader } from "./vendors";
import type { ApprovedStyleSampling } from "./vendors/style-sampling";
import { getTimeoutSettings } from "../timeout-manager";

export interface ChatLoopOptions {
  settings: AgentLoopSettings;
  adapter: ChatVendorAdapter;
  messages: ChatMessage[];
  soulSystemBaseContent: string;
  soulSampling?: ApprovedStyleSampling;
  timeoutMs: number;
  imageCaptionFallback?: () => Promise<ChatMessage[]>;
  onEvent?: (event: TwoPhaseEvent) => void;
  recordUsage?: (input: number, output: number, calls: number) => void;
  signal?: AbortSignal;
  /** 非流式降级时的展示节奏；测试可设为 0，生产默认 20ms。 */
  fallbackRevealIntervalMs?: number;
}

class StreamUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StreamUnavailableError";
  }
}

function explicitlyRejectsStreaming(status: number, body: string): boolean {
  if (status !== 400 && status !== 422) return false;
  return /(?:stream(?:ing)?[^\r\n]{0,40}(?:not supported|unsupported|must be false|disabled|unavailable)|(?:not supported|unsupported)[^\r\n]{0,40}stream(?:ing)?|only non[- ]?stream|不支持.{0,12}流式|流式.{0,12}不支持)/i.test(body);
}

function waitForReveal(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(new Error("E_SOUL_ONLY_CANCELLED"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("E_SOUL_ONLY_CANCELLED"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function emitFallbackText(
  onEvent: ChatLoopOptions["onEvent"],
  messageId: string,
  text: string,
  intervalMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const chars = Array.from(text);
  // 最长约 1.2 秒；短回复保持逐字感，长回复按小块展示。
  const targetFrames = Math.max(1, Math.min(60, Math.ceil(chars.length / 2)));
  const chunkSize = Math.max(1, Math.ceil(chars.length / targetFrames));
  for (let index = 0; index < chars.length; index += chunkSize) {
    onEvent?.({
      type: "text_message_content",
      messageId,
      delta: chars.slice(index, index + chunkSize).join(""),
    });
    if (index + chunkSize < chars.length) await waitForReveal(intervalMs, signal);
  }
}

function stripToolProtocol(text: string): string {
  return text
    .split("]<]minimax[>[").join("")
    .replace(/<tool_call\b[^>]*>[\s\S]*?<\/tool_call>/gi, "")
    .replace(/\[tool_call\][\s\S]*?\[\/tool_call\]/gi, "")
    .replace(/<invoke\b[^>]*>[\s\S]*?<\/invoke>/gi, "")
    .trim();
}

function withSoulSystem(messages: ChatMessage[], system: string): ChatMessage[] {
  if (messages[0]?.role === "system") return messages;
  return [{ role: "system", content: system }, ...messages];
}

export async function runChatLoop(options: ChatLoopOptions): Promise<TwoPhaseFcResult> {
  const startedAt = Date.now();
  const usageRecorder = options.recordUsage ?? ((input, output, calls) => recordUsage(input, output, calls));
  let usedImageCaptionFallback = false;

  const timeout = getTimeoutSettings().chatRequestTimeout;

  const remainingBudget = (): number => {
    if (options.signal?.aborted) throw new Error("E_SOUL_ONLY_CANCELLED");
    const remaining = options.timeoutMs - (Date.now() - startedAt);
    if (remaining <= 0) throw new Error("E_SOUL_ONLY_TIMEOUT");
    return Math.max(1, Math.min(timeout, remaining));
  };

  const vendorConfig: VendorConfig = {
    provider: options.settings.provider,
    baseUrl: options.settings.baseUrl,
    model: options.settings.model,
    apiKey: options.settings.apiKey,
    explicitTransport: options.settings.explicitTransport,
    reasoning: options.settings.reasoning,
  };

  const buildRequest = (messages: ChatMessage[], stream: boolean): ChatRequest => ({
    model: options.settings.model,
    messages: withSoulSystem(messages, options.soulSystemBaseContent),
    stream,
    ...(options.soulSampling ?? {}),
  });

  const invokeNonStreaming = async (messages: ChatMessage[]): Promise<ChatResponse> => {
    const request: ChatRequest = {
      ...buildRequest(messages, false),
    };
    const effectiveRequest = options.adapter.applyCacheHints?.(request, vendorConfig) ?? request;
    const http = options.adapter.buildRequest(effectiveRequest, options.settings);
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, remainingBudget());
    try {
      const response = await fetch(http.url, {
        method: "POST",
        headers: http.headers,
        body: http.body,
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new AgentRuntimeError(
          "E_MODEL_REQUEST_FAILED",
          `模型请求失败：HTTP ${response.status}${body ? ` - ${body.slice(0, 200)}` : ""}`,
        );
      }
      return options.adapter.parseResponse(await response.json());
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  };

  const messageId = `msg-${Date.now()}`;
  const reasoningMessageId = `${messageId}-reasoning`;
  let emittedStreamContent = false;
  let reasoningStarted = false;
  let reasoningEnded = false;
  let textStarted = false;
  let textEnded = false;

  const startReasoning = () => {
    if (reasoningStarted) return;
    reasoningStarted = true;
    options.onEvent?.({ type: "reasoning_message_start", messageId: reasoningMessageId, role: "reasoning" });
  };
  const endReasoning = () => {
    if (!reasoningStarted || reasoningEnded) return;
    reasoningEnded = true;
    options.onEvent?.({ type: "reasoning_message_end", messageId: reasoningMessageId });
  };
  const startText = () => {
    if (textStarted) return;
    endReasoning();
    textStarted = true;
    options.onEvent?.({ type: "text_message_start", messageId, role: "assistant" });
  };
  const endText = () => {
    if (!textStarted || textEnded) return;
    textEnded = true;
    options.onEvent?.({ type: "text_message_end", messageId });
  };

  const invokeStreaming = async (messages: ChatMessage[]): Promise<{
    text: string;
    usage?: { input: number; output: number };
    nonStreamingResponse?: ChatResponse;
  }> => {
    const request = buildRequest(messages, true);
    const effectiveRequest = options.adapter.applyCacheHints?.(request, vendorConfig) ?? request;
    const http = options.adapter.buildStreamRequest(effectiveRequest, vendorConfig);
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, remainingBudget());
    try {
      const response = await fetch(http.url, {
        method: "POST",
        headers: http.headers,
        body: http.body,
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        const detail = `HTTP ${response.status}${body ? ` - ${body.slice(0, 200)}` : ""}`;
        if (explicitlyRejectsStreaming(response.status, body)) {
          throw new StreamUnavailableError(`流式请求不受支持：${detail}`);
        }
        throw new AgentRuntimeError("E_MODEL_REQUEST_FAILED", `模型请求失败：${detail}`);
      }

      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (contentType.includes("application/json")) {
        return { text: "", nonStreamingResponse: options.adapter.parseResponse(await response.json()) };
      }
      if (!response.body) throw new AgentRuntimeError("E_MODEL_RESPONSE_PARSE_FAILED", "模型流式响应体为空");

      let text = "";
      let usage: { input: number; output: number } | undefined;
      for await (const event of createSseReader(options.adapter, response.body)) {
        const chunk = options.adapter.parseStreamEvent(event);
        if (!chunk) continue;
        if (chunk.error) {
          throw new AgentRuntimeError("E_MODEL_REQUEST_FAILED", `模型流式响应错误：${chunk.error}`);
        }
        if (chunk.deltaThinking) {
          emittedStreamContent = true;
          startReasoning();
          options.onEvent?.({
            type: "reasoning_message_content",
            messageId: reasoningMessageId,
            delta: chunk.deltaThinking,
          });
        }
        if (chunk.deltaText) {
          text += chunk.deltaText;
          emittedStreamContent = true;
          startText();
          options.onEvent?.({
            type: "text_message_content",
            messageId,
            delta: chunk.deltaText,
          });
        }
        if (chunk.usage) {
          usage = {
            input: Math.max(usage?.input ?? 0, chunk.usage.input),
            output: Math.max(usage?.output ?? 0, chunk.usage.output),
          };
        }
        if (chunk.done) break;
      }
      if (!text.trim()) {
        throw new AgentRuntimeError("E_MODEL_RESPONSE_PARSE_FAILED", "模型流式响应没有返回可见文本");
      }
      return { text, usage };
    } catch (error) {
      if (emittedStreamContent) throw error;
      if (error instanceof StreamUnavailableError) throw error;
      if (options.signal?.aborted) throw error;
      throw error;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  };

  const invokeWithStreamFallback = async (messages: ChatMessage[]) => {
    try {
      const streamed = await invokeStreaming(messages);
      if (streamed.nonStreamingResponse) {
        return { response: streamed.nonStreamingResponse, needsReveal: true };
      }
      return {
        response: {
          assistantMessage: { role: "assistant" as const, content: streamed.text },
          text: streamed.text,
          toolCalls: [],
          finishReason: "stop",
          raw: null,
          usage: streamed.usage,
        } satisfies ChatResponse,
        needsReveal: false,
      };
    } catch (error) {
      if (!(error instanceof StreamUnavailableError) || emittedStreamContent) throw error;
      return { response: await invokeNonStreaming(messages), needsReveal: true };
    }
  };

  options.onEvent?.({ type: "step_started", stepName: "chat" });
  try {
    let result;
    try {
      result = await invokeWithStreamFallback(options.messages);
    } catch (error) {
      if (emittedStreamContent || options.signal?.aborted || !options.imageCaptionFallback || usedImageCaptionFallback) {
        throw error;
      }
      usedImageCaptionFallback = true;
      result = await invokeWithStreamFallback(await options.imageCaptionFallback());
    }

    const response = result.response;

    if (result.needsReveal && response.thinking) {
      startReasoning();
      options.onEvent?.({
        type: "reasoning_message_content",
        messageId: reasoningMessageId,
        delta: response.thinking,
      });
      endReasoning();
    }

    if (response.usage) {
      usageRecorder(response.usage.input, response.usage.output, 1);
    }
    const reply = stripLeakedChatTimeContext(stripToolProtocol(response.text))
      || "刚才没有生成正常回复，请再试一次。";
    if (result.needsReveal) {
      startText();
      await emitFallbackText(
        options.onEvent,
        messageId,
        reply,
        options.fallbackRevealIntervalMs ?? 20,
        options.signal,
      );
    }
    endText();
    return {
      reply,
      toolResults: [],
      totalUsage: response.usage,
      soulPhaseReason: "no_tool",
    };
  } finally {
    endReasoning();
    endText();
    options.onEvent?.({ type: "step_finished", stepName: "chat" });
  }
}
