import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRuntimeError } from "./orchestrator/agent-runtime-error";
import type { LlmClient } from "./services/llm/llm-client";
import type { ModelSettings } from "./settings/model-settings";
import { pluginGenerateText, type EnqueuePluginLlmTask } from "./plugin-llm";

function settings(patch: Partial<ModelSettings> = {}): ModelSettings {
  return {
    mode: "auto",
    provider: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-5-mini",
    apiKey: "secret",
    explicitTransport: "openai",
    perProvider: {},
    runtimeSync: "off",
    stickerEnabled: true,
    stickerSize: "standard",
    stickerSimilarityThreshold: 0.55,
    chatRequestTimeoutSec: 300,
    modelRequestMaxRetries: 5,
    citaRepairBudgetSec: 8,
    rerankerMode: "none",
    embeddingModel: "bgem3",
    multimodal: false,
    visionBackend: "main",
    contextWindowTokens: 128000,
    ...patch,
  };
}

function harness() {
  const chatNonStream = vi.fn(async () => ({
    text: "generated text",
    finishReason: "stop",
  }));
  const llmClient = { chatNonStream } as unknown as LlmClient;
  const labels: string[] = [];
  const enqueueTask: EnqueuePluginLlmTask = async (label, task) => {
    labels.push(label);
    return task();
  };
  return { chatNonStream, llmClient, enqueueTask, labels };
}

describe("pluginGenerateText", () => {
  it("通过统一 LlmClient 和后台队列发送非流式请求", async () => {
    const h = harness();
    const result = await pluginGenerateText(
      [{ role: "user", content: "Write a short greeting" }],
      settings(),
      h.llmClient,
      h.enqueueTask,
      { maxTokens: 2048, timeoutMs: 5000, purpose: "demo:summary" },
    );

    expect(result).toBe("generated text");
    expect(h.labels).toEqual(["plugin:demo:summary"]);
    expect(h.chatNonStream).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-5-mini" }),
      [{ role: "user", content: "Write a short greeting" }],
      undefined,
      5000,
      "plugin:demo:summary",
      undefined,
      { maxTokens: 2048 },
      expect.any(AbortSignal),
    );
  });

  it("没有 API Key 时拒绝请求", async () => {
    const h = harness();
    await expect(
      pluginGenerateText(
        [{ role: "user", content: "你好" }],
        settings({ apiKey: "" }),
        h.llmClient,
        h.enqueueTask,
      ),
    ).rejects.toThrow(/API Key/);
  });

  it("限制 maxTokens 和 timeoutMs，避免插件制造无界请求", async () => {
    const h = harness();
    await expect(
      pluginGenerateText(
        [{ role: "user", content: "你好" }],
        settings(),
        h.llmClient,
        h.enqueueTask,
        { maxTokens: 32769 },
      ),
    ).rejects.toThrow(/maxTokens/);
  });

  it("允许记忆提取使用本地版预算并逐请求强制开启思考", async () => {
    const h = harness();
    await pluginGenerateText(
      [{ role: "user", content: "提取记忆" }],
      settings(),
      h.llmClient,
      h.enqueueTask,
      { maxTokens: 32768, timeoutMs: 300000, reasoning: "on", purpose: "memory-extraction" },
    );

    expect(h.chatNonStream).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-5-mini" }),
      [{ role: "user", content: "提取记忆" }],
      undefined,
      300000,
      "plugin:memory-extraction",
      { mode: "on" },
      { maxTokens: 32768 },
      expect.any(AbortSignal),
    );
  });

  afterEach(() => vi.useRealTimers());

  it("retries transient failures once in the host, not again in the queue", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.chatNonStream.mockRejectedValueOnce(new AgentRuntimeError("E_MODEL_HTTP_ERROR", "busy", {
      modelFailure: { provider: "openai", model: "test", category: "SERVER_ERROR", retryable: true },
      retryAfterMs: 10,
    }));
    const queue = vi.fn(h.enqueueTask);
    const pending = pluginGenerateText([{ role: "user", content: "test" }], settings({ modelRequestMaxRetries: 1 }), h.llmClient, queue);
    await vi.advanceTimersByTimeAsync(10);
    expect(await pending).toBe("generated text");
    expect(h.chatNonStream).toHaveBeenCalledTimes(2);
    expect(queue).toHaveBeenCalledWith(expect.any(String), expect.any(Function), { retryRateLimit: false });
  });

  it.each(["AUTH", "BILLING", "INVALID_REQUEST", "UNKNOWN"] as const)("does not retry %s", async (category) => {
    const h = harness();
    h.chatNonStream.mockRejectedValue(new AgentRuntimeError("E_MODEL_HTTP_ERROR", "failed", {
      modelFailure: { provider: "openai", model: "test", category },
    }));
    await expect(pluginGenerateText([{ role: "user", content: "test" }], settings(), h.llmClient, h.enqueueTask)).rejects.toThrow("failed");
    expect(h.chatNonStream).toHaveBeenCalledTimes(1);
  });

  it("allows explicit one-shot requests and rejects invalid retry counts", async () => {
    const h = harness();
    h.chatNonStream.mockRejectedValue(new AgentRuntimeError("E_MODEL_HTTP_ERROR", "busy", {
      modelFailure: { provider: "openai", model: "test", category: "RATE_LIMIT", retryable: true },
    }));
    await expect(pluginGenerateText([{ role: "user", content: "test" }], settings(), h.llmClient, h.enqueueTask, { maxRetries: 0 })).rejects.toThrow("busy");
    expect(h.chatNonStream).toHaveBeenCalledTimes(1);
    await expect(pluginGenerateText([{ role: "user", content: "test" }], settings(), h.llmClient, h.enqueueTask, { maxRetries: 11 })).rejects.toThrow("maxRetries");
  });

  it("does not start a queued request after cancellation", async () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort();
    await expect(pluginGenerateText([{ role: "user", content: "test" }], settings(), h.llmClient, h.enqueueTask, { signal: controller.signal })).rejects.toThrow("CANCELLED");
    expect(h.chatNonStream).not.toHaveBeenCalled();
  });

  it("cancels during backoff without another request", async () => {
    const h = harness();
    const controller = new AbortController();
    h.chatNonStream.mockRejectedValue(new AgentRuntimeError("E_MODEL_HTTP_ERROR", "busy", {
      modelFailure: { provider: "openai", model: "test", category: "RATE_LIMIT", retryable: true },
    }));
    const pending = pluginGenerateText([{ role: "user", content: "test" }], settings(), h.llmClient, h.enqueueTask, { signal: controller.signal });
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toThrow("CANCELLED");
    expect(h.chatNonStream).toHaveBeenCalledTimes(1);
  });
});
