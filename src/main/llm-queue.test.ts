// llm-queue 限流判定测试：重点覆盖服务端过载（engine_overloaded）被归入可重试类。
import { describe, expect, it } from "vitest";
import { isRateLimitError } from "./llm-queue";

describe("isRateLimitError", () => {
  it("classifies engine overload messages as retryable", () => {
    // Kimi 实际错误文案（HTTP 429 engine_overloaded_error，链路中只剩 message）
    expect(isRateLimitError(new Error("The engine is currently overloaded, please try again later"))).toBe(true);
    expect(isRateLimitError(new Error("Engine Overloaded"))).toBe(true);
  });

  it("classifies conventional rate limit messages as retryable", () => {
    expect(isRateLimitError(new Error("HTTP 429 Too Many Requests"))).toBe(true);
    expect(isRateLimitError(new Error("rate_limit_reached_error"))).toBe(true);
    expect(isRateLimitError("触发速率限制，请稍后再试")).toBe(true);
  });

  it("does not retry on unrelated errors", () => {
    expect(isRateLimitError(new Error("This operation was aborted"))).toBe(false);
    expect(isRateLimitError(new Error("HTTP 401 invalid api key"))).toBe(false);
    expect(isRateLimitError(new Error("network_error"))).toBe(false);
  });
});
