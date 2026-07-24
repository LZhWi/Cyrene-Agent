import { describe, expect, test } from "vitest";
import {
  classifyStructuredOutputEndpoint,
  resolveStructuredOutputProfile,
} from "./profiles";

describe("resolveStructuredOutputProfile", () => {
  test.each([
    ["chatgpt", "gpt-5.6", "openai", "provider_json_schema"],
    ["claude", "claude-sonnet-4-6", "anthropic", "provider_json_schema"],
    ["kimi", "kimi-k3", "openai", "provider_json_schema"],
    ["doubao", "doubao-seed-2-1-pro-260628", "openai", "provider_json_schema"],
    ["deepseek", "deepseek-v4-pro", "openai", "provider_json_object"],
    ["qwen", "qwen3.7-plus", "openai", "provider_json_object"],
    ["glm", "glm-5.2", "openai", "provider_json_object"],
    ["glm", "glm-5.1", "openai", "provider_json_object"],
    ["mimo", "mimo-v2.5-pro", "openai", "provider_json_object"],
    ["minimax", "MiniMax-M3", "openai", "prompt_json"],
  ] as const)("%s/%s resolves to %s", (provider, model, transport, mode) => {
    expect(resolveStructuredOutputProfile({
      provider,
      model,
      transport,
      endpointKind: "official",
    }).mode).toBe(mode);
  });

  test("custom and local endpoints are permanently prompt_json", () => {
    for (const provider of ["custom", "local", "unknown"]) {
      expect(resolveStructuredOutputProfile({
        provider,
        model: "gpt-5.6",
        transport: "openai",
        endpointKind: provider === "local" ? "local" : "custom",
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
      endpointKind: "official",
    }).mode).toBe("prompt_json");
  });

  test("official profiles do not apply through the wrong transport", () => {
    expect(resolveStructuredOutputProfile({
      provider: "claude",
      model: "claude-sonnet-4-6",
      transport: "openai",
      endpointKind: "official",
    }).mode).toBe("prompt_json");
  });

  test("MiniMax M3 uses its dedicated M tier and evidence-based repair budget", () => {
    expect(resolveStructuredOutputProfile({
      provider: "minimax",
      model: "MiniMax-M3",
      transport: "openai",
      endpointKind: "official",
    })).toMatchObject({
      id: "minimax-m3-adapter",
      tier: "M",
      mode: "prompt_json",
      requestHints: {
        sendJsonObject: true,
        reasoningSplit: true,
      },
      repair: {
        cita: {
          maxAttempts: 2,
          totalBudgetMs: 10_000,
          perAttemptTimeoutMs: 5_500,
        },
        action_gate: {
          maxAttempts: 2,
          totalBudgetMs: 12_000,
          perAttemptTimeoutMs: 7_000,
        },
      },
    });
  });

  test("B tier doubles the structured-output time budget for slower providers", () => {
    expect(resolveStructuredOutputProfile({
      provider: "glm",
      model: "glm-4.7",
      transport: "openai",
      endpointKind: "official",
    })).toMatchObject({
      tier: "B",
      repair: {
        cita: {
          maxAttempts: 2,
          totalBudgetMs: 16_000,
          perAttemptTimeoutMs: 8_000,
          minimumRemainingBudgetMs: 500,
        },
        action_gate: {
          maxAttempts: 2,
          totalBudgetMs: 20_000,
          perAttemptTimeoutMs: 10_000,
          minimumRemainingBudgetMs: 800,
        },
      },
    });
  });

  test("a custom endpoint never inherits an A profile from its provider label or model name", () => {
    expect(resolveStructuredOutputProfile({
      provider: "chatgpt",
      model: "gpt-5.6",
      transport: "openai",
      endpointKind: "custom",
    })).toMatchObject({
      id: "prompt-json-fallback",
      tier: "D",
      mode: "prompt_json",
      allowCapabilityPromotion: false,
      requestHints: { sendJsonObject: false, reasoningSplit: false },
    });
  });

  test.each([
    ["https://api.openai.com/v1/", "official"],
    ["https://proxy.example.com/v1", "custom"],
    ["http://127.0.0.1:11434/v1", "local"],
  ] as const)("classifies %s as %s", (configuredBaseUrl, endpointKind) => {
    expect(classifyStructuredOutputEndpoint({
      providerId: "chatgpt",
      configuredBaseUrl,
      officialBaseUrl: "https://api.openai.com/v1",
    })).toBe(endpointKind);
  });
});
