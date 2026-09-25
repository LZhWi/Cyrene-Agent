import { afterEach, describe, expect, it, vi } from "vitest";
import { logPromptCacheRequest, logPromptCacheSegments } from "./prompt-cache-diagnostics";

describe("prompt cache diagnostics", () => {
  afterEach(() => vi.restoreAllMocks());

  it("只输出结构元数据，不泄露提示词、聊天正文或图片数据", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    logPromptCacheSegments("soul", [{ name: "persona", content: "PRIVATE_PERSONA" }]);
    logPromptCacheRequest("soul", {
      model: "test-model",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "PRIVATE_CHAT" },
          { type: "image_url", image_url: { url: "data:image/png;base64,PRIVATE_IMAGE" } },
        ],
      }],
      stream: false,
      extraBody: { prompt_cache_key: "safe-cache-key" },
    });

    const output = JSON.stringify(log.mock.calls);
    expect(output).toContain("PromptCacheDiag");
    expect(output).toContain("safe-cache-key");
    expect(output).not.toContain("PRIVATE_PERSONA");
    expect(output).not.toContain("PRIVATE_CHAT");
    expect(output).not.toContain("PRIVATE_IMAGE");
  });
});
