import { describe, expect, it, vi } from "vitest";
import { createWeatherContextService } from "./weather-context-service";

describe("插件天气上下文服务", () => {
  it("只返回非定位字段并缓存至明确有效期", async () => {
    let now = Date.parse("2026-09-20T04:00:00.000Z");
    const read = vi.fn(async () => ({
      category: "rain" as const,
      temperatureC: 21,
      precipitationMm: 2.5,
      todayHighC: 23,
      previousDayHighC: 30,
    }));
    const service = createWeatherContextService(read, () => now);
    await expect(service.snapshot()).resolves.toEqual({
      observedAt: "2026-09-20T04:00:00.000Z",
      expiresAt: "2026-09-20T04:30:00.000Z",
      category: "rain",
      temperatureC: 21,
      precipitationMm: 2.5,
      todayHighC: 23,
      previousDayHighC: 30,
    });
    now += 29 * 60_000;
    await service.snapshot();
    expect(read).toHaveBeenCalledOnce();
  });

  it("失败返回 null 并在五分钟内不重复查询", async () => {
    let now = 0;
    const read = vi.fn(async () => null);
    const service = createWeatherContextService(read, () => now);
    await expect(service.snapshot()).resolves.toBeNull();
    now += 4 * 60_000;
    await expect(service.snapshot()).resolves.toBeNull();
    expect(read).toHaveBeenCalledOnce();
  });

  it("底层查询异常也按失败快照处理，不让天气阻断插件", async () => {
    const service = createWeatherContextService(async () => { throw new Error("network"); }, () => 0);
    await expect(service.snapshot()).resolves.toBeNull();
  });
});
