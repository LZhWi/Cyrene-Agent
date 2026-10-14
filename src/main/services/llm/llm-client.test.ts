import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelSettings } from "../../settings/model-settings";

vi.mock("../../orchestrator/vendors", () => ({
  getAdapterForConfig: () => ({
    buildRequest: () => ({ url: "https://fake.invalid", headers: {}, body: "{}" }),
    parseResponse: (value: unknown) => value,
  }),
}));
vi.mock("../../token-usage-store", () => ({ recordUsage: vi.fn(), recordRequest: vi.fn() }));
vi.mock("../../chat-api-utils", () => ({ appendApiLog: vi.fn() }));
import { createLlmClient } from "./llm-client";

const settings = { provider: "OpenAI", model: "test", apiKey: "fake", baseUrl: "https://fake.invalid" } as ModelSettings;
const messages = [{ role: "user" as const, content: "synthetic" }];
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("non-stream model failure facts", () => {
  it.each([[503, "UNAVAILABLE"], [401, "AUTH"], [400, "INVALID_REQUEST"]])("preserves HTTP %s classification", async (status, category) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "failed" } }), { status: Number(status), headers: { "retry-after": "2" } })));
    await expect(createLlmClient().chatNonStream(settings, messages, undefined, 1000, "test")).rejects.toMatchObject({
      message: "failed", retryAfterMs: 2000, modelFailure: { category, status },
    });
  });

  it("preserves network codes from fetch causes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } }); }));
    await expect(createLlmClient().chatNonStream(settings, messages, undefined, 1000, "test")).rejects.toMatchObject({ modelFailure: { category: "NETWORK" } });
  });

  it("does not send a pre-cancelled request", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    controller.abort();
    await expect(createLlmClient().chatNonStream(settings, messages, undefined, 1000, "test", undefined, undefined, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("classifies its own deadline as timeout, not user cancellation", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_url, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("timeout", "AbortError")), { once: true });
    })));
    const pending = createLlmClient().chatNonStream(settings, messages, undefined, 1000, "test");
    const check = expect(pending).rejects.toMatchObject({ modelFailure: { category: "TIMEOUT", retryable: true } });
    await vi.advanceTimersByTimeAsync(1000);
    await check;
  });
});
