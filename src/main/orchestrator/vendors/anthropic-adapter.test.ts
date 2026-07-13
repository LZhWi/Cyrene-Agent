import { describe, expect, test } from "vitest";
import { AnthropicAdapter } from "./anthropic-adapter";
import type { ProviderCapability } from "./types";

const anthropicCap: ProviderCapability = {
  id: "test-anthropic",
  displayName: "Test Anthropic",
  transport: "anthropic",
  baseUrl: "https://example.test/v1",
  authStyle: "x-api-key",
  defaultModel: "test-model",
  supportsTools: true,
  supportsThinking: true,
  thinkingField: "thinking",
  cacheStrategy: "cache_control",
  testStrategy: "text",
  supportsVision: true,
};

describe("AnthropicAdapter", () => {
  test("buildRequest uses x-api-key when authStyle=x-api-key (default Anthropic)", () => {
    const adapter = new AnthropicAdapter("test-anthropic", anthropicCap);
    const req = adapter.buildRequest(
      { model: "m", messages: [{ role: "user", content: "hi" }] },
      { provider: "p", baseUrl: "https://e.test/v1", model: "m", apiKey: "sk-test" },
    );
    expect(req.headers["x-api-key"]).toBe("sk-test");
    expect(req.headers.Authorization).toBeUndefined();
    // anthropic-version 与 authStyle 无关，必须保留
    expect(req.headers["anthropic-version"]).toBeDefined();
  });

  test("buildRequest uses Authorization Bearer when authStyle=bearer (decoupled)", () => {
    const mimoCap: ProviderCapability = {
      ...anthropicCap,
      id: "mimo",
      displayName: "MiMo（小米）",
      authStyle: "bearer",
    };
    const adapter = new AnthropicAdapter("mimo", mimoCap);
    const req = adapter.buildRequest(
      { model: "m", messages: [{ role: "user", content: "hi" }] },
      { provider: "MiMo（小米）", baseUrl: "https://api.xiaomimimo.com/anthropic", model: "m", apiKey: "sk-test" },
    );
    // 关键：MiMo capability 传入 AnthropicAdapter，wire 上必须是 Authorization: Bearer
    expect(req.headers.Authorization).toBe("Bearer sk-test");
    expect(req.headers["x-api-key"]).toBeUndefined();
    expect(req.headers["anthropic-version"]).toBeDefined();
  });
});