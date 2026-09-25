import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captionImageWithRetryAndFallback,
  VISION_RETRY_POLICY,
  type VisionAnalyze,
  type VisionConfig,
} from "./vision-captioner";

const image = { base64: "image", mime: "image/png" } as const;
const config: VisionConfig = {
  baseUrl: "https://vision.invalid/v1",
  apiKey: "key",
  model: "primary-vision",
};

afterEach(() => {
  vi.useRealTimers();
});

describe("captionImageWithRetryAndFallback", () => {
  it("retries retryable overload errors for ten seconds, then uses the GLM fallback model", async () => {
    vi.useFakeTimers();
    const analyze = vi.fn<VisionAnalyze>(async (_image, _query, current) => (
      current.model === VISION_RETRY_POLICY.fallbackModel
        ? "fallback ok"
        : "[错误·运行时] 视觉模型请求失败：HTTP 429 overloaded"
    ));

    const pending = captionImageWithRetryAndFallback(image, "看图", config, undefined, 512, analyze);
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(pending).resolves.toBe("fallback ok");
    expect(analyze).toHaveBeenCalledTimes(12);
    expect(analyze.mock.calls.at(-1)?.[2]).toEqual({
      ...config,
      model: "glm-4.1v-thinking-flash",
    });
  });

  it("returns a recovered primary-model result without invoking fallback", async () => {
    vi.useFakeTimers();
    const analyze = vi.fn<VisionAnalyze>()
      .mockResolvedValueOnce("[错误·运行时] 视觉模型请求失败：HTTP 503 busy")
      .mockResolvedValueOnce("primary ok");

    const pending = captionImageWithRetryAndFallback(image, "看图", config, undefined, 512, analyze);
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(pending).resolves.toBe("primary ok");
    expect(analyze).toHaveBeenCalledTimes(2);
    expect(analyze.mock.calls.every((call) => call[2].model === config.model)).toBe(true);
  });

  it.each([
    "[错误·运行时] 视觉模型请求超时",
    "[错误·运行时] 视觉模型未返回有效内容",
  ])("does not retry non-retryable failure: %s", async (failure) => {
    const analyze = vi.fn<VisionAnalyze>(async () => failure);
    await expect(captionImageWithRetryAndFallback(image, "看图", config, undefined, 512, analyze)).resolves.toBe(failure);
    expect(analyze).toHaveBeenCalledOnce();
  });

  it("does not retry or fall back when the configured model is already the fallback", async () => {
    const fallbackConfig = { ...config, model: VISION_RETRY_POLICY.fallbackModel };
    const failure = "[错误·运行时] 视觉模型请求失败：HTTP 429 overloaded";
    const analyze = vi.fn<VisionAnalyze>(async () => failure);

    await expect(captionImageWithRetryAndFallback(image, "看图", fallbackConfig, undefined, 512, analyze)).resolves.toBe(failure);
    expect(analyze).toHaveBeenCalledOnce();
  });
});
