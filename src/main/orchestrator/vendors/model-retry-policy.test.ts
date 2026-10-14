import { describe, expect, it } from "vitest";
import type { ModelErrorCategory, ModelFailureInfo } from "../../../shared/model-error";

async function loadPolicy() {
  const policy = await import("./model-retry-policy").catch(() => undefined);
  expect(policy).toBeDefined();
  return policy!;
}

function failure(category: ModelErrorCategory, retryable?: ModelFailureInfo["retryable"]): ModelFailureInfo {
  return { provider: "test", model: "m", category, ...(retryable !== undefined ? { retryable } : {}) };
}

describe("shouldRetryModelFailure", () => {
  it.each(["NETWORK", "TIMEOUT", "RATE_LIMIT", "OVERLOADED", "SERVER_ERROR", "UNAVAILABLE"] as const)(
    "重试明确的暂时性类别 %s",
    async (category) => expect((await loadPolicy()).shouldRetryModelFailure(failure(category))).toBe(true),
  );

  it.each(["AUTH", "PERMISSION", "BILLING", "QUOTA", "INVALID_REQUEST", "CONTEXT_LIMIT", "CANCELLED", "UNKNOWN"] as const)(
    "不重试终态类别 %s",
    async (category) => expect((await loadPolicy()).shouldRetryModelFailure(failure(category, true))).toBe(false),
  );

  it.each([false, "conditional"] as const)("显式 retryable=%s 时不重试", async (retryable) => {
    expect((await loadPolicy()).shouldRetryModelFailure(failure("RATE_LIMIT", retryable))).toBe(false);
  });
});

describe("model retry delays", () => {
  it("指数等待按 2 秒起步、60 秒封顶并加入 50%–100% 抖动", async () => {
    const { nextModelRetryDelayMs } = await loadPolicy();
    expect(nextModelRetryDelayMs(1, undefined, () => 0)).toBe(1_000);
    expect(nextModelRetryDelayMs(1, undefined, () => 1)).toBe(2_000);
    expect(nextModelRetryDelayMs(2, undefined, () => 0.5)).toBe(3_000);
    expect(nextModelRetryDelayMs(8, undefined, () => 1)).toBe(60_000);
  });

  it("解析 Retry-After 秒数和 HTTP 日期，并拒绝超过 5 分钟的建议等待", async () => {
    const { nextModelRetryDelayMs, readRetryAfterMs } = await loadPolicy();
    const now = Date.parse("2026-09-30T00:00:00.000Z");
    expect(readRetryAfterMs({ "retry-after": "2.5" }, now)).toBe(2_500);
    expect(readRetryAfterMs({ response: { headers: { "retry-after": "4" } } }, now)).toBe(4_000);
    expect(readRetryAfterMs({ headers: { get: (name: string) => name === "retry-after" ? "Wed, 30 Sep 2026 00:00:03 GMT" : null } }, now)).toBe(3_000);
    expect(readRetryAfterMs({ "Retry-After": "not-a-date" }, now)).toBeUndefined();
    expect(nextModelRetryDelayMs(1, 300_001)).toBeUndefined();
    expect(nextModelRetryDelayMs(1, 0)).toBe(0);
  });
});
