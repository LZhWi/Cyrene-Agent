import { describe, expect, test } from "vitest";
import { resolveStructuredOutputProfile } from "./profiles";

describe("resolveStructuredOutputProfile", () => {
  test.each([
    ["chatgpt", "gpt-5.6", "openai", "provider_json_schema"],
    ["claude", "claude-sonnet-4-6", "anthropic", "provider_json_schema"],
    ["kimi", "kimi-k3", "openai", "provider_json_schema"],
    ["doubao", "doubao-seed-2-1-pro-260628", "openai", "provider_json_schema"],
    ["deepseek", "deepseek-v4-pro", "openai", "provider_json_object"],
    ["qwen", "qwen3.7-plus", "openai", "provider_json_object"],
    ["glm", "glm-5.2", "openai", "provider_json_object"],
    ["mimo", "mimo-v2.5-pro", "openai", "provider_json_object"],
    ["minimax", "MiniMax-M3", "openai", "prompt_json"],
  ] as const)("%s/%s resolves to %s", (provider, model, transport, mode) => {
    expect(resolveStructuredOutputProfile({ provider, model, transport }).mode).toBe(mode);
  });

  test("custom and local endpoints are permanently prompt_json", () => {
    for (const provider of ["custom", "local", "unknown"]) {
      expect(resolveStructuredOutputProfile({
        provider,
        model: "gpt-5.6",
        transport: "openai",
      })).toMatchObject({
        mode: "prompt_json",
        verification: "contract_required",
        allowCapabilityPromotion: false,
      });
    }
  });

  test("unknown model on a built-in provider falls back conservatively", () => {
    expect(resolveStructuredOutputProfile({
      provider: "chatgpt",
      model: "future-unverified-model",
      transport: "openai",
    }).mode).toBe("prompt_json");
  });

  test("official profiles do not apply through the wrong transport", () => {
    expect(resolveStructuredOutputProfile({
      provider: "claude",
      model: "claude-sonnet-4-6",
      transport: "openai",
    }).mode).toBe("prompt_json");
  });

  test("MiniMax M3 keeps JSON hint and reasoning split without upgrading from D", () => {
    expect(resolveStructuredOutputProfile({
      provider: "minimax",
      model: "MiniMax-M3",
      transport: "openai",
    })).toMatchObject({
      mode: "prompt_json",
      requestHints: {
        sendJsonObject: true,
        reasoningSplit: true,
      },
    });
  });
});
