/**
 * Harness LLM 调用层
 *
 * 职责：怎么跟模型供应商对话——流式优先、非流式兜底、用量记账、压缩摘要请求。
 * 全部为显式参数的纯函数，不依赖 HarnessRun 运行上下文。
 *
 * 调用方：
 * - cyrene-harness.ts 的 callRoundLLM（主循环每轮请求）
 * - cyrene-harness.ts 的 runCompaction（mid-loop 压缩摘要）
 */

import { getAdapterForConfig, streamChatWithSdk, resolveTransport } from "../vendors";
import { recordUsage, recordRequest } from "../../token-usage-store";
import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ToolSpec,
  VendorConfig,
} from "../vendors/types";
import type { HarnessConfig } from "./types";
import { AGENT_COMPACTION_PROMPT } from "./compaction";
import { isExplicitStreamUnsupported } from "../vendors/stream-support";
import { AgentRuntimeError } from "../agent-runtime-error";
import { classifyModelFailure } from "../vendors/model-error-classifier";
import { runModelRequestWithRetry } from "../vendors/model-retry-runner";
import { readRetryAfterMs } from "../vendors/model-retry-policy";
import type { ModelRetryStatus } from "../../../shared/model-retry";
import {
  composePromptLayers,
  normalizeToolSpecsForCache,
  type PromptLayers,
} from "../prompt-layers";
import { logPromptCacheRequest } from "../prompt-cache-diagnostics";

/**
 * 输出上限策略（docs/design/2026-08-26-maxtoken-model-switch-glm53-known-issues.md 问题 1）：
 * - OpenAI / Responses 协议：max_tokens 可选，缺省即模型自身输出上限。
 *   不传，避免固定预算把长思维链拦腰截断。
 * - Anthropic 协议：max_tokens 必填（缺字段直接 400），传模型级安全大值。
 *   32k 对 Claude Sonnet 4.6+（64k）/ MiniMax M3 / GLM-5.x / DeepSeek V4 均在限内。
 *
 * config.reservedOutputTokens 仅参与压缩预算计算（computeTokenBudget），不再限流。
 */
const ANTHROPIC_REQUIRED_MAX_TOKENS = 32_768;

function resolveRequestMaxTokens(vendorConfig: VendorConfig): number | undefined {
  return resolveTransport(vendorConfig) === "anthropic"
    ? ANTHROPIC_REQUIRED_MAX_TOKENS
    : undefined;
}

/**
 * 单次 LLM 调用（流式优先）。
 * 部分兼容模型明确拒绝 stream + tools；只在零增量、明确不支持时降级为非流式，绝不重放半截流。
 */
export async function callLLM(
  vendorConfig: VendorConfig,
  promptLayers: PromptLayers,
  messages: ChatMessage[],
  tools: ToolSpec[],
  config: HarnessConfig,
  signal?: AbortSignal,
  onReasoningDelta?: (delta: string) => void,
  onRetryStatus?: (status: ModelRetryStatus) => void,
  getRemainingBudgetMs?: () => number,
): Promise<ChatResponse> {
  const adapter = getAdapterForConfig(vendorConfig);
  const composed = composePromptLayers(promptLayers, messages);
  const requestMaxTokens = resolveRequestMaxTokens(vendorConfig);
  const baseRequest: ChatRequest = {
    model: vendorConfig.model,
    messages: composed.messages,
    tools: normalizeToolSpecsForCache(tools),
    stream: true,
    ...(requestMaxTokens !== undefined ? { maxTokens: requestMaxTokens } : {}),
    promptLayers: composed.metadata,
  };
  // 缓存路由 hints（Kimi prompt_cache_key 等）：此前只有 ChatLoop / 压缩摘要链路注入，
  // Harness 工具循环整条链漏发；在这里统一补上，下方流式与非流式兜底共用同一份 hints。
  const chatRequest = adapter.applyCacheHints?.(baseRequest, vendorConfig) ?? baseRequest;
  logPromptCacheRequest("tool", chatRequest);

  const recordResponseUsage = (response: ChatResponse): ChatResponse => {
    recordRequest(vendorConfig.model);
    if (!response.usage) return response;
    recordUsage(
      response.usage.input,
      response.usage.output,
      1,
      response.usage.cachedInput,
      vendorConfig.model,
      response.usage.cacheCreation,
    );
    return response;
  };
  let forceNonStreaming = false;
  const response = await runModelRequestWithRetry(async (attempt) => {
    let receivedStreamDelta = false;
    if (!forceNonStreaming) {
      try {
        return await streamChatWithSdk({
          adapter,
          request: chatRequest,
          config: vendorConfig,
          timeoutMs: config.totalTimeoutMs,
          signal: attempt.signal,
          onDelta: (delta) => {
            receivedStreamDelta = true;
            attempt.onStreamActivity();
            if ((delta.type === "text_delta" || delta.type === "reasoning_delta") && delta.delta) attempt.onVisibleDelta();
            if (delta.type === "reasoning_delta" && delta.delta) onReasoningDelta?.(delta.delta);
          },
        });
      } catch (error) {
        if (receivedStreamDelta || !isExplicitStreamUnsupported(error)) throw error;
        forceNonStreaming = true;
      }
    }

    // 非流式兜底
    const fallbackRequest: ChatRequest = { ...chatRequest, stream: false };
    const http = adapter.buildRequest(fallbackRequest, vendorConfig);
    let response: Response;
    try {
      response = await fetch(http.url, {
        method: "POST", headers: http.headers, body: http.body, signal: attempt.signal,
      });
    } catch (error) {
      if (attempt.signal.aborted) throw error;
      const failure = classifyModelFailure({ provider: adapter.id, model: vendorConfig.model, error });
      throw new AgentRuntimeError("E_MODEL_REQUEST_FAILED", "模型服务请求失败。", {
        cause: error,
        retryAfterMs: readRetryAfterMs(error),
        modelFailure: { ...failure, category: failure.category === "UNKNOWN" ? "NETWORK" : failure.category },
      });
    }
    if (!response.ok) {
      // [image-send] 链路日志④：服务端拒绝时打印完整错误体（Anthropic 400 会带具体 reason）。
      const rawBody = await response.text().catch(() => "");
      console.error(`[image-send] LLM 请求被拒 HTTP ${response.status}:`, rawBody.slice(0, 500) || "(无响应体)");
      let errorData: unknown;
      try { errorData = JSON.parse(rawBody || "{}"); } catch { errorData = undefined; }
      throw new AgentRuntimeError("E_MODEL_REQUEST_FAILED", `模型请求失败：HTTP ${response.status}`, {
        retryAfterMs: readRetryAfterMs(response.headers),
        modelFailure: classifyModelFailure({ provider: adapter.id, model: vendorConfig.model, status: response.status, error: errorData }),
      });
    }
    return adapter.parseResponse(await response.json());
  }, {
    provider: adapter.id, model: vendorConfig.model,
    maxRetries: config.modelRequestMaxRetries ?? 5,
    idleTimeoutMs: config.modelRequestIdleTimeoutMs ?? 60_000,
    signal, onStatus: onRetryStatus, getRemainingBudgetMs,
  });
  return recordResponseUsage(response);
}

/** 历史摘要（用于 mid-loop compaction）。 */
export async function summarizeHistory(
  vendorConfig: VendorConfig,
  systemPrompt: string,
  history: ChatMessage[],
  tools: ToolSpec[],
  signal?: AbortSignal,
  retryOptions: { maxRetries?: number; idleTimeoutMs?: number; onStatus?: (status: ModelRetryStatus) => void; getRemainingBudgetMs?: () => number } = {},
): Promise<string> {
  const adapter = getAdapterForConfig(vendorConfig);

  const chatRequest: ChatRequest = {
    model: vendorConfig.model,
    messages: [
      { role: "system", content: systemPrompt },
      ...history,
      { role: "user", content: AGENT_COMPACTION_PROMPT },
    ],
    tools: normalizeToolSpecsForCache(tools),
    stream: false,
    // 摘要输出同样不受固定预算限制（见 resolveRequestMaxTokens 注释）。
    ...(resolveRequestMaxTokens(vendorConfig) !== undefined
      ? { maxTokens: resolveRequestMaxTokens(vendorConfig) }
      : {}),
  };

  const http = adapter.buildRequest(chatRequest, vendorConfig);
  return runModelRequestWithRetry(async (attempt) => {
    let response: Response;
    try {
      response = await fetch(http.url, { method: "POST", headers: http.headers, body: http.body, signal: attempt.signal });
    } catch (error) {
      if (attempt.signal.aborted) throw error;
      const failure = classifyModelFailure({ provider: adapter.id, model: vendorConfig.model, error });
      throw new AgentRuntimeError("E_MODEL_REQUEST_FAILED", "摘要请求失败。", {
        cause: error, retryAfterMs: readRetryAfterMs(error),
        modelFailure: { ...failure, category: failure.category === "UNKNOWN" ? "NETWORK" : failure.category },
      });
    }

    if (!response.ok) {
      const rawBody = await response.text().catch(() => "");
      console.error(`[image-send] 摘要请求被拒 HTTP ${response.status}:`, rawBody.slice(0, 500) || "(无响应体)");
      let errorData: unknown;
      try { errorData = JSON.parse(rawBody); } catch { errorData = undefined; }
      throw new AgentRuntimeError("E_MODEL_REQUEST_FAILED", `摘要请求失败：HTTP ${response.status}`, {
        modelFailure: classifyModelFailure({ provider: adapter.id, model: vendorConfig.model, status: response.status, error: errorData }),
        retryAfterMs: readRetryAfterMs(response.headers),
      });
    }

    const result = adapter.parseResponse(await response.json());
    return result.text;
  }, {
    provider: adapter.id, model: vendorConfig.model,
    maxRetries: retryOptions.maxRetries ?? 5,
    idleTimeoutMs: retryOptions.idleTimeoutMs ?? 60_000,
    signal, onStatus: retryOptions.onStatus, getRemainingBudgetMs: retryOptions.getRemainingBudgetMs,
  });
}
