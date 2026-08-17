import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { createThinkFilter } from "../../../chat/think-filter";
import { AgentRuntimeError } from "../../agent-runtime-error";
import type { ChatRequest, ChatResponse, ChatVendorAdapter, VendorConfig } from "../types";
import { CyreneStreamAccumulator } from "./accumulator";
import { AnthropicEventNormalizer, reconcileAnthropicTerminal } from "./anthropic-normalizer";
import { dumpRequest, dumpResponse } from "../prompt-dump";
import {
  deriveAnthropicClientConfig,
  deriveOpenAIClientConfig,
  type AnthropicClientConfig,
  type OpenAIClientConfig,
} from "./client-config";
import { normalizeOpenAIChunk } from "./openai-normalizer";
import {
  ProviderProtocolError,
  type StreamDiagnostic,
  type UnifiedStreamDelta,
} from "./types";

export interface OpenAIStreamFactoryInput {
  client: OpenAIClientConfig;
  body: Record<string, unknown>;
  signal: AbortSignal;
}

export interface AnthropicStreamFactoryInput {
  client: AnthropicClientConfig;
  body: Record<string, unknown>;
  signal: AbortSignal;
}

export interface SdkStreamRuntimeDeps {
  openAI: (input: OpenAIStreamFactoryInput) => Promise<AsyncIterable<unknown>>;
  anthropic: (input: AnthropicStreamFactoryInput) => Promise<{
    events: AsyncIterable<unknown>;
    finalMessage: () => Promise<unknown>;
  }>;
}

export interface SdkStreamRunInput {
  adapter: ChatVendorAdapter;
  request: ChatRequest;
  config: VendorConfig;
  timeoutMs: number;
  signal?: AbortSignal;
  onDelta?: (delta: UnifiedStreamDelta) => void;
  onDiagnostic?: (diagnostic: StreamDiagnostic) => void;
}

const defaultDeps: SdkStreamRuntimeDeps = {
  openAI: async ({ client: options, body, signal }) => {
    const client = new OpenAI(options);
    const stream = await client.chat.completions.create(body as never, { signal });
    return stream as unknown as AsyncIterable<unknown>;
  },
  anthropic: async ({ client: options, body, signal }) => {
    const client = new Anthropic(options);
    const stream = client.messages.stream(body as never, { signal });
    return {
      events: stream as unknown as AsyncIterable<unknown>,
      finalMessage: () => stream.finalMessage(),
    };
  },
};

function requestBody(adapter: ChatVendorAdapter, request: ChatRequest, config: VendorConfig): {
  endpoint: string;
  body: Record<string, unknown>;
} {
  const http = adapter.buildStreamRequest({ ...request, stream: true }, config);
  const parsed = JSON.parse(http.body) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new AgentRuntimeError("E_MODEL_RESPONSE_PARSE_FAILED", "模型请求体不是 JSON 对象");
  }
  return { endpoint: http.url, body: parsed as Record<string, unknown> };
}

function cancellationError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted", "AbortError");
}

export async function streamChatWithSdk(
  input: SdkStreamRunInput,
  deps: SdkStreamRuntimeDeps = defaultDeps,
): Promise<ChatResponse> {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort(input.signal?.reason);
  if (input.signal?.aborted) abortFromCaller();
  else input.signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timer = Number.isFinite(input.timeoutMs) && input.timeoutMs > 0
    ? setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException("Model request timed out", "TimeoutError"));
    }, input.timeoutMs)
    : undefined;

  const accumulator = new CyreneStreamAccumulator();
  const taggedThinkFilter = createThinkFilter("leading-only");
  // LLM 调用原文 traceId —— 即使 dump 关闭也会生成，方便上层日志关联。
  let traceId = "";
  const commitDelta = (delta: UnifiedStreamDelta) => {
    if (delta.type === "finish" && input.adapter.transport === "openai") {
      for (const toolCall of accumulator.snapshot().toolCalls) {
        if (!toolCall.ended) {
          const end: UnifiedStreamDelta = {
            type: "tool_call_end",
            index: toolCall.index,
            ...(toolCall.id ? { id: toolCall.id } : {}),
          };
          accumulator.apply(end);
          input.onDelta?.(end);
        }
      }
    }
    accumulator.apply(delta);
    input.onDelta?.(delta);
  };
  const flushTaggedThink = () => {
    const visibleTail = taggedThinkFilter.flush();
    const thinkingTail = taggedThinkFilter.takeThinking();
    if (thinkingTail) commitDelta({ type: "reasoning_delta", delta: thinkingTail });
    if (visibleTail) commitDelta({ type: "text_delta", delta: visibleTail });
  };
  const dispatch = (delta: UnifiedStreamDelta) => {
    if (delta.type === "text_delta") {
      const visible = taggedThinkFilter.push(delta.delta);
      const thinking = taggedThinkFilter.takeThinking();
      if (thinking) commitDelta({ type: "reasoning_delta", delta: thinking });
      if (visible) commitDelta({ type: "text_delta", delta: visible });
      return;
    }
    if (delta.type !== "reasoning_delta") flushTaggedThink();
    commitDelta(delta);
  };

  try {
    const prepared = requestBody(input.adapter, input.request, input.config);
    traceId = dumpRequest({
      transport: input.adapter.transport,
      endpoint: prepared.endpoint,
      body: prepared.body,
    });
    if (input.adapter.transport === "openai") {
      const chunks = await deps.openAI({
        client: deriveOpenAIClientConfig(prepared.endpoint, input.config.apiKey),
        body: prepared.body,
        signal: controller.signal,
      });
      let lastChunk: unknown = null;
      for await (const chunk of chunks) {
        lastChunk = chunk;
        for (const delta of normalizeOpenAIChunk(chunk)) dispatch(delta);
      }
      flushTaggedThink();
      const openaiFinal = accumulator.finalize(lastChunk);
      dumpResponse(traceId, {
        transport: "openai",
        ok: true,
        text: openaiFinal.text,
        thinking: openaiFinal.thinking,
        toolCalls: openaiFinal.toolCalls,
        usage: openaiFinal.usage,
        raw: openaiFinal.raw,
      });
      return openaiFinal;
    }

    const authStyle = input.adapter.capability.anthropicAuthStyle ?? input.adapter.capability.authStyle;
    const stream = await deps.anthropic({
      client: deriveAnthropicClientConfig(prepared.endpoint, input.config.apiKey, authStyle),
      body: prepared.body,
      signal: controller.signal,
    });
    const normalizer = new AnthropicEventNormalizer();
    for await (const event of stream.events) {
      // [DIAG] 打印每个 SSE 事件的 type + usage 相关字段
      const evt = event as Record<string, unknown>;
      const evtType = typeof evt.type === "string" ? evt.type : "(unknown)";
      if (evtType === "message_start" || evtType === "message_delta") {
        const usageSource = evtType === "message_start" ? (evt.message as Record<string, unknown> | undefined)?.usage : evt.usage;
        console.log(`[DIAG] SSE ${evtType} usage=${JSON.stringify(usageSource ?? "(none)")}`);
      }
      for (const delta of normalizer.normalize(event)) dispatch(delta);
    }
    flushTaggedThink();
    const finalMessage = await stream.finalMessage();
    // [DIAG] 打印 accumulator snapshot 的 usage 和 finalMessage 的 usage
    const liveSnap = accumulator.snapshot();
    console.log(`[DIAG] accumulator.usage=${JSON.stringify(liveSnap.usage ?? "(none)")}`);
    const finalAsRecord = finalMessage as Record<string, unknown>;
    console.log(`[DIAG] finalMessage.usage=${JSON.stringify(finalAsRecord?.usage ?? "(none)")}`);
    const reconciled = reconcileAnthropicTerminal(
      accumulator.snapshot(),
      finalMessage,
      input.adapter,
      input.onDiagnostic,
    );
    console.log(`[DIAG] reconciled.usage=${JSON.stringify(reconciled.usage ?? "(none)")}`);
    dumpResponse(traceId, {
      transport: "anthropic",
      ok: true,
      text: reconciled.text,
      thinking: reconciled.thinking,
      toolCalls: reconciled.toolCalls,
      usage: reconciled.usage,
      raw: reconciled.raw,
    });
    return reconciled;
  } catch (error) {
    if (traceId) {
      dumpResponse(traceId, {
        transport: input.adapter.transport,
        ok: false,
        raw: null,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });
    }
    if (timedOut) {
      throw new AgentRuntimeError("E_MODEL_REQUEST_TIMEOUT", "模型响应超时，请稍后重试。", { cause: error });
    }
    if (input.signal?.aborted) throw cancellationError(input.signal);
    if (error instanceof ProviderProtocolError || error instanceof AgentRuntimeError) throw error;
    throw new AgentRuntimeError("E_MODEL_REQUEST_FAILED", "模型服务请求失败。", { cause: error });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    input.signal?.removeEventListener("abort", abortFromCaller);
  }
}
