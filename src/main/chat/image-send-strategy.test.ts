import { describe, expect, test } from "vitest";
import { decideImageSendStrategy } from "./image-send-strategy";

describe("decideImageSendStrategy", () => {
  test("uses direct image sending when the main provider supports vision over OpenAI transport", () => {
    const strategy = decideImageSendStrategy({
      provider: "Kimi（月之暗面）",
      baseUrl: "https://api.moonshot.cn/v1",
      model: "kimi-k2.7-code",
      apiKey: "key-main",
    });

    expect(strategy).toEqual({ mode: "direct" });
  });

  test("uses direct image sending when main and vision configs are exactly the same OpenAI-compatible config", () => {
    const strategy = decideImageSendStrategy({
      provider: "ChatGPT（OpenAI）",
      baseUrl: "https://api.openai.com/v1/",
      model: "gpt-4o-mini",
      apiKey: "same-key",
      vision: {
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-4o-mini",
        apiKey: "same-key",
      },
    });

    expect(strategy).toEqual({ mode: "direct" });
  });

  test("falls back to captioning for vision-capable providers that are not using OpenAI-compatible transport", () => {
    const strategy = decideImageSendStrategy({
      provider: "MiniMax（稀宇科技）",
      baseUrl: "https://api.minimaxi.com/anthropic",
      model: "MiniMax-M3",
      apiKey: "key-main",
    });

    expect(strategy).toEqual({ mode: "caption" });
  });
});
