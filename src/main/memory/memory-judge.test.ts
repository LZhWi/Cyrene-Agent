import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  structuredOptions: undefined as { systemPrompt: string } | undefined,
}));

vi.mock("./memory-llm-client", () => ({
  getDefaultMaxOutputTokens: () => 800,
  invokeMemoryStructuredOutput: vi.fn(async (options: { systemPrompt: string }) => {
    mocks.structuredOptions = options;
    return [];
  }),
}));

vi.mock("./memory-llm-shared", () => ({
  loadMemoryModelConfig: () => ({
    source: "inherited-main",
    provider: "DeepSeek（深度求索）",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-v4-pro",
    apiKey: "sk-test",
  }),
}));

import { MemoryJudge } from "./memory-judge";

describe("MemoryJudge B-tier output contract", () => {
  beforeEach(() => {
    mocks.structuredOptions = undefined;
  });

  test("asks for a candidates object envelope instead of a top-level array", async () => {
    await new MemoryJudge().judge("你好", "你好呀", "conversation-1");

    const prompt = mocks.structuredOptions?.systemPrompt ?? "";
    expect(prompt).toContain('顶层 JSON 对象');
    expect(prompt).toContain('{"candidates":[]}');
    expect(prompt).not.toContain("输出格式为 JSON 数组");
  });
});
