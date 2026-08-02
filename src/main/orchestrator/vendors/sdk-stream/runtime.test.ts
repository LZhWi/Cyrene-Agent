import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRuntimeError } from "../../agent-runtime-error";
import { AnthropicAdapter } from "../anthropic-adapter";
import { OpenAICompatAdapter } from "../openai-adapter";
import type { ChatRequest, ProviderCapability, VendorConfig } from "../types";
import { streamChatWithSdk, type SdkStreamRuntimeDeps } from "./runtime";
import type { UnifiedStreamDelta } from "./types";

const openAICapability: ProviderCapability = {
  id: "chatgpt",
  displayName: "OpenAI",
  transport: "openai",
  baseUrl: "https://api.openai.com/v1",
  authStyle: "bearer",
  defaultModel: "gpt-test",
  supportsTools: true,
  supportsThinking: true,
  thinkingField: "reasoning_content",
  cacheStrategy: "none",
  testStrategy: "text",
  supportsVision: true,
};

const anthropicCapability: ProviderCapability = {
  ...openAICapability,
  id: "claude",
  displayName: "Claude",
  transport: "anthropic",
  authStyle: "x-api-key",
  thinkingField: "thinking",
};

const request: ChatRequest = {
  model: "model-test",
  messages: [{ role: "user", content: "hi" }],
};

const openAIConfig: VendorConfig = {
  provider: "OpenAI",
  baseUrl: "https://api.openai.com/v1",
  model: "model-test",
  apiKey: "sk-test",
  explicitTransport: "openai",
};

const anthropicConfig: VendorConfig = {
  provider: "Claude",
  baseUrl: "https://api.anthropic.com",
  model: "model-test",
  apiKey: "sk-test",
  explicitTransport: "anthropic",
};

async function* iterableOf(...values: unknown[]): AsyncIterable<unknown> {
  for (const value of values) yield value;
}

function unusedFactory(): never {
  throw new Error("unexpected transport factory");
}

afterEach(() => {
  vi.useRealTimers();
});

describe("streamChatWithSdk", () => {
  it("streams OpenAI deltas before returning the accumulated response", async () => {
    const adapter = new OpenAICompatAdapter("chatgpt", openAICapability);
    const seen: UnifiedStreamDelta[] = [];
    let factoryInput: Parameters<SdkStreamRuntimeDeps["openAI"]>[0] | undefined;
    const deps: SdkStreamRuntimeDeps = {
      openAI: async (input) => {
        factoryInput = input;
        return iterableOf(
          { choices: [{ delta: { reasoning_content: "think" }, finish_reason: null }] },
          { choices: [{ delta: { content: "answer" }, finish_reason: null }] },
          {
            choices: [{ delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 5, completion_tokens: 2 },
          },
        );
      },
      anthropic: unusedFactory,
    };

    const response = await streamChatWithSdk({
      adapter,
      request,
      config: openAIConfig,
      timeoutMs: 1_000,
      onDelta: (delta) => seen.push(delta),
    }, deps);

    expect(factoryInput?.body).toMatchObject({ model: "model-test", stream: true });
    expect(factoryInput?.client).toMatchObject({
      baseURL: "https://api.openai.com/v1",
      apiKey: "sk-test",
      maxRetries: 0,
    });
    expect(factoryInput?.signal.aborted).toBe(false);
    expect(seen).toEqual([
      { type: "reasoning_delta", delta: "think" },
      { type: "text_delta", delta: "answer" },
      { type: "usage", inputTokens: 5, outputTokens: 2 },
      { type: "finish", reason: "stop" },
    ]);
    expect(response).toMatchObject({
      text: "answer",
      thinking: "think",
      finishReason: "stop",
      usage: { input: 5, output: 2 },
    });
  });

  it("delivers Anthropic raw deltas before asking the SDK for finalMessage", async () => {
    const adapter = new AnthropicAdapter("claude", anthropicCapability);
    const order: string[] = [];
    const deps: SdkStreamRuntimeDeps = {
      openAI: unusedFactory,
      anthropic: async () => ({
        events: iterableOf(
          { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "think" } },
          { type: "content_block_stop", index: 0 },
          { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "answer" } },
          { type: "content_block_stop", index: 1 },
          { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
          { type: "message_stop" },
        ),
        finalMessage: async () => {
          order.push("finalMessage");
          return {
            stop_reason: "end_turn",
            usage: { input_tokens: 5, output_tokens: 2 },
            content: [
              { type: "thinking", thinking: "think", signature: "sig" },
              { type: "text", text: "answer" },
            ],
          };
        },
      }),
    };

    const response = await streamChatWithSdk({
      adapter,
      request,
      config: anthropicConfig,
      timeoutMs: 1_000,
      onDelta: (delta) => {
        if (delta.type === "reasoning_delta" || delta.type === "text_delta") order.push(delta.type);
      },
    }, deps);

    expect(order).toEqual(["reasoning_delta", "text_delta", "finalMessage"]);
    expect(response.assistantMessage.rawAssistant).toEqual([
      { type: "thinking", thinking: "think", signature: "sig" },
      { type: "text", text: "answer" },
    ]);
  });

  it("turns only the runtime-owned deadline into E_MODEL_REQUEST_TIMEOUT", async () => {
    vi.useFakeTimers();
    const adapter = new OpenAICompatAdapter("chatgpt", openAICapability);
    let capturedSignal: AbortSignal | undefined;
    const deps: SdkStreamRuntimeDeps = {
      openAI: async ({ signal }) => {
        capturedSignal = signal;
        return {
          [Symbol.asyncIterator]() {
            return {
              next: () => new Promise<IteratorResult<unknown>>((_resolve, reject) => {
                signal.addEventListener("abort", () => reject(signal.reason), { once: true });
              }),
            };
          },
        };
      },
      anthropic: unusedFactory,
    };
    const pending = streamChatWithSdk({
      adapter,
      request,
      config: openAIConfig,
      timeoutMs: 25,
    }, deps);
    const rejection = expect(pending).rejects.toEqual(
      expect.objectContaining<Partial<AgentRuntimeError>>({ code: "E_MODEL_REQUEST_TIMEOUT" }),
    );

    await vi.advanceTimersByTimeAsync(25);

    await rejection;
    expect(capturedSignal?.aborted).toBe(true);
  });

  it("preserves caller cancellation instead of classifying it as timeout", async () => {
    const adapter = new OpenAICompatAdapter("chatgpt", openAICapability);
    const caller = new AbortController();
    const cancelled = new DOMException("user cancelled", "AbortError");
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const deps: SdkStreamRuntimeDeps = {
      openAI: async ({ signal }) => {
        markStarted?.();
        return {
          [Symbol.asyncIterator]() {
            return {
              next: () => new Promise<IteratorResult<unknown>>((_resolve, reject) => {
                signal.addEventListener("abort", () => reject(signal.reason), { once: true });
              }),
            };
          },
        };
      },
      anthropic: unusedFactory,
    };
    const pending = streamChatWithSdk({
      adapter,
      request,
      config: openAIConfig,
      timeoutMs: 10_000,
      signal: caller.signal,
    }, deps);

    await started;
    caller.abort(cancelled);

    await expect(pending).rejects.toBe(cancelled);
  });

  it("clears the deadline after a successful stream", async () => {
    vi.useFakeTimers();
    const adapter = new OpenAICompatAdapter("chatgpt", openAICapability);
    let capturedSignal: AbortSignal | undefined;
    const deps: SdkStreamRuntimeDeps = {
      openAI: async ({ signal }) => {
        capturedSignal = signal;
        return iterableOf({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] });
      },
      anthropic: unusedFactory,
    };

    await streamChatWithSdk({
      adapter,
      request,
      config: openAIConfig,
      timeoutMs: 25,
    }, deps);
    await vi.advanceTimersByTimeAsync(100);

    expect(capturedSignal?.aborted).toBe(false);
  });
});
