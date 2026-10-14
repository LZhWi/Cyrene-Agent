import { chatModuleUsesOAuth, resolveChatModuleModel } from "../settings/chat-module-routes";
import { getAdapterForConfig } from "./vendors";
import { stripLeakedChatTimeContext } from "../chat-time-context";
import { ChatTimeStreamPrefixFilter } from "../chat-time-stream-filter";
import { recordUsage, recordRequest } from "../token-usage-store";
import { AgentRuntimeError } from "./agent-runtime-error";
import type {
  AgentLoopSettings,
  AgentLoopEvent,
  AgentLoopResult,
} from "./cyrene-agent";
import type {
  ChatMessage,
  ChatRequest,
  ChatVendorAdapter,
  ChatResponse,
  VendorConfig,
} from "./vendors/types";
import { streamChatWithSdk } from "./vendors/sdk-stream/runtime";
import { classifyModelFailure } from "./vendors/model-error-classifier";
import { runModelRequestWithRetry, type ModelRetryAttemptInput } from "./vendors/model-retry-runner";
import { readRetryAfterMs } from "./vendors/model-retry-policy";
import { resolveModelRequestTimeoutMs } from "./config/model-timeout";
import type { UnifiedStreamDelta } from "./vendors/sdk-stream/types";
import type { ApprovedStyleSampling } from "./vendors/style-sampling";
import { getTimeoutSettings } from "../timeout-manager";
import { compressConversation } from "./context-manager";
import { buildContextUsageSnapshot } from "./context-usage";
import { isExplicitStreamUnsupported } from "./vendors/stream-support";
import { composePromptLayers } from "./prompt-layers";
import { logPromptCacheRequest } from "./prompt-cache-diagnostics";

export interface ChatLoopOptions {
  settings: AgentLoopSettings;
  adapter: ChatVendorAdapter;
  messages: ChatMessage[];
  soulSystemBaseContent: string;
  /** Soul 开头 system 的动态资料；与稳定人格合并，但不写回持久化历史。 */
  systemContext?: string;
  /** 每次请求才注入的本轮上下文，不能写回对话历史或稳定前缀。 */
  runtimeContext?: string;
  /** Soul 生成点前的近端 system 锚点；用于对齐本地 2FC 的消息顺序。 */
  tailSystemContext?: string;
  /** 两阶段 Soul 失败时按本地版返回可诊断的中断回复，而不是让整轮直接失败。 */
  diagnosticFailureReply?: boolean;
  /** 陪伴 Chat 的非流式 Soul 回复可携带末尾生活提案；提案不进入可见正文。 */
  companionLifeSidecar?: boolean;
  soulSampling?: ApprovedStyleSampling;
  timeoutMs: number;
  imageCaptionFallback?: () => Promise<ChatMessage[]>;
  onEvent?: (event: AgentLoopEvent) => void;
  recordUsage?: (input: number, output: number, calls: number, cachedInput?: number, cacheCreation?: number) => void;
  signal?: AbortSignal;
  /** 非流式降级时的展示节奏；测试可设为 0，生产默认 20ms。 */
  fallbackRevealIntervalMs?: number;
  /** 是否使用流式请求；默认开启，桌面 Chat 的 Soul 阶段会显式关闭以对齐本地 2FC。 */
  streaming?: boolean;
  /** 默认使用官方 SDK；测试可注入可控流实现。 */
  streamChat?: typeof streamChatWithSdk;
  /** 当前对话模式，用于上下文压缩保留的最近轮数。 */
  mode?: string;
}

class StreamUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StreamUnavailableError";
  }
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
  if (intervalMs <= 0) {
    if (text) onEvent?.({ type: "text_message_content", messageId, delta: text });
    return;
  }
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

function splitCompanionLifeSidecar(text: string): { reply: string; update?: string } {
  const open = "<cyrene-life-update>", close = "</cyrene-life-update>";
  const start = text.lastIndexOf(open);
  if (start < 0) return { reply: text };
  const reply = text.slice(0, start).trim();
  const tail = text.slice(start + open.length).trim();
  if (!reply || !tail.endsWith(close)) return { reply };
  const update = tail.slice(0, -close.length).trim();
  if (update.length > 4_000) return { reply };
  try {
    const value: unknown = JSON.parse(update);
    if (value && typeof value === "object" && !Array.isArray(value)) return { reply, update };
  } catch { /* 无效提案仅保留可见回复 */ }
  return { reply };
}

function sanitizeDiagnosticReason(reason: string): string {
  return reason
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "sk-[REDACTED]")
    .replace(/((?:api[_-]?key|authorization)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .slice(0, 1_000);
}

function buildDiagnosticFailureReply(messages: readonly ChatMessage[], error: unknown): string {
  const rawReason = error instanceof Error && error.name === "AbortError"
    ? "总结请求超时"
    : error instanceof Error ? error.message : String(error);
  const lines = [
    "抱歉，任务执行到一半被中断了。",
    "",
    `中断原因：${sanitizeDiagnosticReason(rawReason)}`,
  ];
  const completed = messages.filter((message) => message.role === "tool");
  if (completed.length === 0) {
    lines.push("", "（暂无已完成的步骤信息）");
  } else {
    lines.push("", "以下是中断前已经完成的步骤：");
    for (const message of completed) {
      const output = typeof message.content === "string" ? message.content : "";
      const preview = output.length > 200 ? `${output.slice(0, 200)}…` : output;
      lines.push(`- 「${message.name || "tool"}」：${preview}`);
    }
  }
  return lines.join("\n");
}

export async function runChatLoop(options: ChatLoopOptions): Promise<AgentLoopResult> {
  if (options.mode === "chat") {
    const settings = resolveChatModuleModel("soul", options.settings);
    const toolSettings = resolveChatModuleModel("tools", options.settings);
    if (chatModuleUsesOAuth("tools") !== chatModuleUsesOAuth("soul") || toolSettings.model !== settings.model || toolSettings.baseUrl !== settings.baseUrl) {
      options = { ...options, messages: options.messages.map(({ rawAssistant, thinking, ...message }) => message) };
    }
    if (settings !== options.settings) options = { ...options, settings, adapter: getAdapterForConfig(settings), soulSampling: undefined };
  }
  const startedAt = Date.now();
  const usageRecorder = options.recordUsage ?? ((input, output, calls, cachedInput, cacheCreation) => recordUsage(input, output, calls, cachedInput, options.settings.model, cacheCreation));
  let usedImageCaptionFallback = false;

  const leadingSystemContent = [options.soulSystemBaseContent, options.systemContext]
    .filter(Boolean).join("\n\n---\n\n");
  const measuredRuntimeContext = [options.systemContext, options.runtimeContext, options.tailSystemContext]
    .filter(Boolean).join("\n\n---\n\n");
  const messages = await compressConversation({
    messages: options.messages,
    adapter: options.adapter,
    settings: options.settings,
    systemContent: [leadingSystemContent, options.tailSystemContext].filter(Boolean).join("\n\n---\n\n"),
    mode: options.mode,
    onEvent: options.onEvent,
    signal: options.signal,
  });

  // 上下文容量快照（preRequest）：压缩后、请求前。
  // messages 为压缩后的原始消息，不含 composePromptLayers 追加的 runtime_context
  // 尾部（不变量），runtimeContext 由独立参数计量，避免双重计数。
  const emitContextUsage = (phase: "preRequest" | "terminal", extraAssistantReply?: string): void => {
    options.onEvent?.({
      type: "context_usage",
      contextUsage: buildContextUsageSnapshot({
        phase,
        contextWindowTokens: options.settings.contextWindowTokens,
        personaContent: options.soulSystemBaseContent,
        ...(measuredRuntimeContext ? { runtimeContext: measuredRuntimeContext } : {}),
        ...(extraAssistantReply !== undefined
          ? { messages: [...messages, { role: "assistant" as const, content: extraAssistantReply }] }
          : { messages }),
      }),
    });
  };
  emitContextUsage("preRequest");

  const timeout = getTimeoutSettings().chatRequestTimeout;

  const remainingBudget = (): number => {
    if (options.signal?.aborted) throw new Error("E_SOUL_ONLY_CANCELLED");
    // 0 表示没有整轮预算；单次请求仍使用局部请求超时。
    if (options.timeoutMs <= 0 || !Number.isFinite(options.timeoutMs)) return timeout;
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

  const buildRequest = (reqMessages: ChatMessage[], stream: boolean): ChatRequest => {
    const composed = composePromptLayers({
      stablePrefix: options.soulSystemBaseContent,
      sessionPrefix: options.systemContext,
      runtimeContext: options.runtimeContext,
      mode: options.mode,
    }, reqMessages);
    return {
      model: options.settings.model,
      ...composed,
      messages: options.tailSystemContext?.trim()
        ? [...composed.messages, { role: "system", content: options.tailSystemContext.trim() }]
        : composed.messages,
      stream,
      ...(options.soulSampling ?? {}),
    };
  };

  const invokeNonStreaming = async (messages: ChatMessage[], signal: AbortSignal): Promise<ChatResponse> => {
    const request: ChatRequest = {
      ...buildRequest(messages, false),
    };
    const effectiveRequest = options.adapter.applyCacheHints?.(request, vendorConfig) ?? request;
    logPromptCacheRequest("soul", effectiveRequest);
    const http = options.adapter.buildRequest(effectiveRequest, options.settings);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; abort(); }, remainingBudget());
    try {
      let response: Response;
      try {
        response = await fetch(http.url, {
          method: "POST",
          headers: http.headers,
          body: http.body,
          signal: controller.signal,
        });
      } catch (error) {
        if (signal.aborted) throw error;
        const failure = classifyModelFailure({ provider: options.adapter.id, model: effectiveRequest.model, error });
        throw new AgentRuntimeError("E_MODEL_REQUEST_FAILED", "模型服务请求失败。", {
          cause: error,
          modelFailure: { ...failure, category: timedOut ? "TIMEOUT" : failure.category === "UNKNOWN" ? "NETWORK" : failure.category },
        });
      }
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        // [image-send] 链路日志④：服务端拒绝时打印完整错误体（Anthropic 400 会带具体 reason）。
        console.error(`[image-send] ChatLoop 请求被拒 HTTP ${response.status}:`, body.slice(0, 500) || "(无响应体)");
        let errorPayload: unknown;
        try { errorPayload = JSON.parse(body); } catch { errorPayload = undefined; }
        // 非 JSON 错误体仍保留安全格式的 request_id，供诊断与用户报障；不回显原始响应体。
        const plainRequestId = errorPayload === undefined
          ? body.match(/\brequest_id\s*[:=]\s*([A-Za-z0-9._-]{1,80})\b/i)?.[1]
          : undefined;
        throw new AgentRuntimeError("E_MODEL_REQUEST_FAILED", `模型请求失败：HTTP ${response.status}${plainRequestId ? ` request_id=${plainRequestId}` : ""}`, {
          retryAfterMs: readRetryAfterMs(response.headers),
          modelFailure: classifyModelFailure({
            provider: options.adapter.id, model: effectiveRequest.model, status: response.status,
            error: errorPayload ?? (plainRequestId ? { request_id: plainRequestId } : undefined),
          }),
        });
      }
      return options.adapter.parseResponse(await response.json());
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
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

  const invokeStreaming = async (messages: ChatMessage[], attempt: ModelRetryAttemptInput): Promise<{
    response: ChatResponse;
    needsReveal: boolean;
  }> => {
    const request = buildRequest(messages, true);
    const effectiveRequest = options.adapter.applyCacheHints?.(request, vendorConfig) ?? request;
    logPromptCacheRequest("soul", effectiveRequest);
    const timePrefixFilter = new ChatTimeStreamPrefixFilter();
    let text = "";
    const emitTextDelta = (delta: string) => {
      if (!delta) return;
      text += delta;
      emittedStreamContent = true;
      attempt.onVisibleDelta();
      startText();
      options.onEvent?.({ type: "text_message_content", messageId, delta });
    };
    const onDelta = (delta: UnifiedStreamDelta) => {
      attempt.onStreamActivity();
      if (delta.type === "reasoning_delta" && delta.delta) {
        emittedStreamContent = true;
        attempt.onVisibleDelta();
        startReasoning();
        options.onEvent?.({
          type: "reasoning_message_content",
          messageId: reasoningMessageId,
          delta: delta.delta,
        });
      } else if (delta.type === "text_delta" && delta.delta) {
        emitTextDelta(timePrefixFilter.push(delta.delta));
      }
    };
    try {
      const response = await (options.streamChat ?? streamChatWithSdk)({
        adapter: options.adapter,
        request: effectiveRequest,
        config: vendorConfig,
        timeoutMs: remainingBudget(),
        signal: attempt.signal,
        onDelta,
      });
      emitTextDelta(timePrefixFilter.finish());
      if (!text.trim()) {
        if (response.text.trim()) return { response, needsReveal: true };
        throw new AgentRuntimeError("E_MODEL_RESPONSE_PARSE_FAILED", "模型流式响应没有返回可见文本");
      }
      return {
        response: {
          ...response,
          text,
          assistantMessage: { ...response.assistantMessage, content: text },
        },
        needsReveal: false,
      };
    } catch (error) {
      if (!emittedStreamContent && isExplicitStreamUnsupported(error)) {
        throw new StreamUnavailableError("流式请求不受支持", { cause: error });
      }
      if (error instanceof AgentRuntimeError && error.modelFailure) throw error;
      if (options.signal?.aborted) throw error;
      if (emittedStreamContent) throw error;
      const modelFailure = classifyModelFailure({ provider: options.adapter.id, model: options.settings.model, error });
      throw new AgentRuntimeError("E_MODEL_REQUEST_FAILED", modelFailure.status ? `模型请求失败：HTTP ${modelFailure.status}` : "模型服务请求失败。", {
        cause: error,
        modelFailure,
        retryAfterMs: readRetryAfterMs(error),
      });
    }
  };

  let forceNonStreaming = options.streaming === false || Boolean(options.companionLifeSidecar);
  const invokeWithStreamFallback = async (messages: ChatMessage[], attempt: ModelRetryAttemptInput) => {
    if (forceNonStreaming) return { response: await invokeNonStreaming(messages, attempt.signal), needsReveal: true };
    try {
      return await invokeStreaming(messages, attempt);
    } catch (error) {
      if (!(error instanceof StreamUnavailableError) || emittedStreamContent) throw error;
      forceNonStreaming = true;
      return { response: await invokeNonStreaming(messages, attempt.signal), needsReveal: true };
    }
  };

  const invokeModel = async (messages: ChatMessage[]) => {
    return runModelRequestWithRetry((attempt) => invokeWithStreamFallback(messages, attempt), {
      provider: options.adapter.id,
      model: options.settings.model,
      maxRetries: options.settings.modelRequestMaxRetries ?? 5,
      idleTimeoutMs: resolveModelRequestTimeoutMs(getTimeoutSettings()),
      signal: options.signal,
      getRemainingBudgetMs: remainingBudget,
      onStatus: (retryStatus) => options.onEvent?.({ type: "model_retry", retryStatus }),
    });
  };

  options.onEvent?.({ type: "step_started", stepName: "chat" });
  try {
    let result;
    try {
      result = await invokeModel(options.messages);
    } catch (error) {
      const failure = error instanceof AgentRuntimeError ? error.modelFailure : undefined;
      if (emittedStreamContent || options.signal?.aborted || failure?.status !== 400 || failure.category !== "INVALID_REQUEST" || !options.imageCaptionFallback || usedImageCaptionFallback) {
        throw error;
      }
      usedImageCaptionFallback = true;
      result = await invokeModel(await options.imageCaptionFallback());
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

    recordRequest(options.settings.model);
    if (response.usage) {
      usageRecorder(response.usage.input, response.usage.output, 1, response.usage.cachedInput, response.usage.cacheCreation);
    }
    const cleaned = stripLeakedChatTimeContext(stripToolProtocol(response.text));
    const sidecar = options.companionLifeSidecar ? splitCompanionLifeSidecar(cleaned) : { reply: cleaned };
    const reply = sidecar.reply
      || "刚才没有生成正常回复，请再试一次。";
    // 终态快照：把最终回复并入历史口径（与下一轮进入历史的文本一致）。
    emitContextUsage("terminal", reply);
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
      ...(sidecar.update ? { companionLifeUpdate: sidecar.update } : {}),
      toolResults: [],
      totalUsage: response.usage,
      completionReason: "no_tool",
    };
  } catch (error) {
    if (!options.diagnosticFailureReply || options.signal?.aborted) throw error;
    const reply = buildDiagnosticFailureReply(messages, error);
    emitContextUsage("terminal", reply);
    startText();
    await emitFallbackText(options.onEvent, messageId, reply, 0, options.signal);
    endText();
    return {
      reply,
      toolResults: [],
      completionReason: "no_tool",
    };
  } finally {
    endReasoning();
    endText();
    options.onEvent?.({ type: "step_finished", stepName: "chat" });
  }
}
