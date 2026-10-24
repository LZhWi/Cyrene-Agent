import { describe, expect, it } from "vitest";

async function loadPolicy() {
  const policy = await import("./model-retry-policy").catch(() => undefined);
  expect(policy).toBeDefined();
  return policy!;
}

describe("model retry delays", () => {
  it("指数等待按 2 秒起步、60 秒封顶并加入 50%–100% 抖动", async () => {
    const { nextModelRetryDelayMs } = await loadPolicy();
    expect(nextModelRetryDelayMs(1, undefined, () => 0)).toBe(1_000);
    expect(nextModelRetryDelayMs(1, undefined, () => 1)).toBe(2_000);
    expect(nextModelRetryDelayMs(2, undefined, () => 0.5)).toBe(3_000);
    expect(nextModelRetryDelayMs(8, undefined, () => 1)).toBe(60_000);
  });

  it("解析 Retry-After 秒数和 HTTP 日期，并将超长等待限制在 5 分钟", async () => {
    const { nextModelRetryDelayMs, readRetryAfterMs, MAX_RETRY_AFTER_MS } = await loadPolicy();
    const now = Date.parse("2026-09-30T00:00:00.000Z");
    expect(readRetryAfterMs({ "retry-after": "2.5" }, now)).toBe(2_500);
    expect(readRetryAfterMs({ response: { headers: { "retry-after": "4" } } }, now)).toBe(4_000);
    expect(readRetryAfterMs({ headers: { get: (name: string) => name === "retry-after" ? "Wed, 30 Sep 2026 00:00:03 GMT" : null } }, now)).toBe(3_000);
    expect(readRetryAfterMs({ "Retry-After": "not-a-date" }, now)).toBeUndefined();
    expect(nextModelRetryDelayMs(1, 300_001)).toBe(MAX_RETRY_AFTER_MS);
    expect(nextModelRetryDelayMs(1, 0)).toBe(0);
  });
});
