import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRuntimeError } from "../agent-runtime-error";
import type { ChatResponse, VendorConfig } from "../vendors/types";
import type { HarnessConfig } from "./types";

const { stream, adapter, recordUsage, recordRequest } = vi.hoisted(() => ({
  stream: vi.fn(),
  adapter: {
    id: "openai",
    buildRequest: (request: unknown) => ({ url: "https://test.invalid", headers: {}, body: JSON.stringify(request) }),
    parseResponse: (response: unknown) => response,
  },
  recordUsage: vi.fn(), recordRequest: vi.fn(),
}));
vi.mock("../vendors", () => ({
  getAdapterForConfig: () => adapter,
  streamChatWithSdk: stream,
  resolveTransport: () => "openai",
}));
vi.mock("../../token-usage-store", () => ({ recordUsage, recordRequest }));
import { callLLM, summarizeHistory } from "./harness-llm";

const vendor: VendorConfig = { provider: "test", baseUrl: "https://test.invalid", apiKey: "dummy", model: "m" };
const config = { totalTimeoutMs: 30_000, modelRequestMaxRetries: 1, modelRequestIdleTimeoutMs: 1000 } as HarnessConfig;
const response: ChatResponse = {
  text: "完成", assistantMessage: { role: "assistant", content: "完成" },
  toolCalls: [], finishReason: "stop", raw: {}, usage: { input: 10, output: 2 },
};
const transient = () => new AgentRuntimeError("E_MODEL_REQUEST_FAILED", "暂时失败", {
  modelFailure: { provider: "test", model: "m", category: "UNAVAILABLE", retryable: true }, retryAfterMs: 0,
});
afterEach(() => { vi.resetAllMocks(); vi.unstubAllGlobals(); });

describe("Harness model retry wiring", () => {
  it("retries the same Tool prompt and accounts usage only for a successful result", async () => {
    stream.mockRejectedValueOnce(transient()).mockResolvedValueOnce(response);
    const status = vi.fn();
    const result = await callLLM(vendor, { stablePrefix: "system" }, [{ role: "user", content: "测试" }], [], config, undefined, undefined, status);
    expect(result).toEqual(response);
    expect(stream).toHaveBeenCalledTimes(2);
    expect(stream.mock.calls[0][0].request).toEqual(stream.mock.calls[1][0].request);
    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordRequest).toHaveBeenCalledTimes(1);
    expect(status.mock.calls.map(([value]) => value.phase)).toEqual(["waiting", "attempting", "cleared"]);
  });

  it("does not replay Tool decisions after a reasoning delta", async () => {
    stream.mockImplementationOnce(async ({ onDelta }) => {
      onDelta({ type: "reasoning_delta", delta: "分析中" });
      throw transient();
    });
    const reasoning = vi.fn();
    await expect(callLLM(vendor, { stablePrefix: "system" }, [], [], config, undefined, reasoning)).rejects.toThrow("暂时失败");
    expect(stream).toHaveBeenCalledTimes(1);
    expect(reasoning).toHaveBeenCalledWith("分析中");
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it("does not retry authentication failure and preserves the final model error", async () => {
    stream.mockRejectedValueOnce(new AgentRuntimeError("E_MODEL_REQUEST_FAILED", "鉴权失败", {
      modelFailure: { provider: "test", model: "m", category: "AUTH", status: 401 },
    }));
    await expect(callLLM(vendor, { stablePrefix: "system" }, [], [], config)).rejects.toThrow("鉴权失败");
    expect(stream).toHaveBeenCalledTimes(1);
  });

  it("wires the same retry policy into history compaction without changing its messages", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503, headers: { "Retry-After": "0" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(response), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    expect(await summarizeHistory(vendor, "system", [{ role: "user", content: "历史" }], [], undefined,
      { maxRetries: 1, idleTimeoutMs: 1000 })).toBe("完成");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0][1].body).toEqual(fetch.mock.calls[1][1].body);
  });
});
