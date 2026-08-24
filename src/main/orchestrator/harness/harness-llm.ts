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

import { getAdapterForConfig, streamChatWithSdk } from "../vendors";
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
import {
  composePromptLayers,
  normalizeToolSpecsForCache,
  type PromptLayers,
} from "../prompt-layers";

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
): Promise<ChatResponse> {
  const adapter = getAdapterForConfig(vendorConfig);
  const composed = composePromptLayers(promptLayers, messages);
  const baseRequest: ChatRequest = {
    model: vendorConfig.model,
    messages: composed.messages,
    tools: normalizeToolSpecsForCache(tools),
    stream: true,
    maxTokens: config.reservedOutputTokens,
    promptLayers: composed.metadata,
  };
  // 缓存路由 hints（Kimi prompt_cache_key 等）：此前只有 ChatLoop / 压缩摘要链路注入，
  // Harness 工具循环整条链漏发；在这里统一补上，下方流式与非流式兜底共用同一份 hints。
  const chatRequest = adapter.applyCacheHints?.(baseRequest, vendorConfig) ?? baseRequest;

  let receivedStreamDelta = false;
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
  try {
    return recordResponseUsage(await streamChatWithSdk({
      adapter,
      request: chatRequest,
      config: vendorConfig,
      timeoutMs: config.totalTimeoutMs,
      signal,
      onDelta: (delta) => {
        receivedStreamDelta = true;
        if (delta.type === "reasoning_delta" && delta.delta) onReasoningDelta?.(delta.delta);
      },
    }));
  } catch (error) {
    if (receivedStreamDelta || !isExplicitStreamUnsupported(error)) throw error;
  }

  // 非流式兜底
  const fallbackRequest: ChatRequest = { ...chatRequest, stream: false };
  const http = adapter.buildRequest(fallbackRequest, vendorConfig);
  const response = await fetch(http.url, {
    method: "POST",
    headers: http.headers,
    body: http.body,
    signal,
  });
  if (!response.ok) {
    const errorData = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(errorData.error?.message || `模型请求失败：HTTP ${response.status}`);
  }
  return recordResponseUsage(adapter.parseResponse(await response.json()));
}

/** 历史摘要（用于 mid-loop compaction）。 */
export async function summarizeHistory(
  vendorConfig: VendorConfig,
  systemPrompt: string,
  history: ChatMessage[],
  tools: ToolSpec[],
  config: HarnessConfig,
  signal?: AbortSignal,
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
    maxTokens: config.reservedOutputTokens,
  };

  const http = adapter.buildRequest(chatRequest, vendorConfig);
  const response = await fetch(http.url, {
    method: "POST",
    headers: http.headers,
    body: http.body,
    signal,
  });

  if (!response.ok) {
    throw new Error(`摘要请求失败：HTTP ${response.status}`);
  }

  const result = adapter.parseResponse(await response.json());
  return result.text;
}
