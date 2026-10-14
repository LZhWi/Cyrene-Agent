import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  structuredOptions: undefined as { systemPrompt: string } | undefined,
}));

vi.mock("./memory-llm-client", () => ({
  getDefaultMaxOutputTokens: () => 800,
  invokeMemoryStructuredOutput: vi.fn(async (options: { systemPrompt: string }) => {
    mocks.structuredOptions = options;
    return { candidates: [], entities: [] };
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
import { invokeMemoryStructuredOutput } from "./memory-llm-client";

describe("MemoryJudge B-tier output contract", () => {
  test("propagates failed extraction instead of returning an empty success", async () => {
    const error = new Error("MODEL_REQUEST_TIMEOUT");
    vi.mocked(invokeMemoryStructuredOutput).mockRejectedValueOnce(error);
    await expect(new MemoryJudge().judge("我教陶艺", "好的", "test")).rejects.toBe(error);
  });
  test.each([
    ["眼前景色只是梦境", "眼前景色在梦里面", true],
    ["用户只喝茶", "用户喝茶", false],
    ["用户只喝茶", "用户只是喜欢喝茶", false],
    ["用户永远喝茶", "用户喝茶", false],
    ["用户只喝茶", "用户只喝茶", true],
  ])("checks absolute wording without rejecting explanatory 只是: %s", async (summary, quote, accepted) => {
    vi.mocked(invokeMemoryStructuredOutput).mockImplementationOnce(async options => {
      const candidate = { layer: "L2", content: summary, summary,
        confidence: 0.9, triggerText: quote, evidenceQuotes: [quote], shouldWrite: true };
      try { return options.parseSchema({candidates:[candidate],entities:[]}); }
      catch {
        expect(options.repairInstructions?.()).toContain("需要语义复核");
        return options.parseSchema({candidates:[{...candidate,reason:accepted
          ? "语义复核通过：原文与摘要表达相同范围，没有增加限制或确定性。" : "仍然不复核"}],entities:[]});
      }
    });
    const result = new MemoryJudge().judge(quote, "好的", "s");
    if (accepted) expect((await result).candidates).toHaveLength(1);
    else await expect(result).rejects.toThrow();
  });
  beforeEach(() => {
    mocks.structuredOptions = undefined;
  });

  test("asks for a candidates object envelope instead of a top-level array", async () => {
    await new MemoryJudge().judge("你好", "你好呀", "conversation-1");

    const prompt = mocks.structuredOptions?.systemPrompt ?? "";
    expect(prompt).toContain('顶层 JSON 对象');
    expect(prompt).toContain('{"candidates":[],"entities":[]}');
    expect(prompt).not.toContain("输出格式为 JSON 数组");
  });

  test("instructs LLM to emit slug for L2 candidates", async () => {
    await new MemoryJudge().judge("我喜欢香菇", "记下来了", "conversation-1");

    const prompt = mocks.structuredOptions?.systemPrompt ?? "";
    expect(prompt).toContain("L2 slug 抽取");
    expect(prompt).toContain("L2 片段必须输出 slug");
    // 校验规则要明确传给 LLM
    expect(prompt).toMatch(/≤20\s*字/);
    expect(prompt).toContain("禁止标点、引号、空格、emoji");
    // L0/L1 明确禁止 slug
    expect(prompt).toContain("L0 / L1 候选不要输出 slug 字段");
  });

  test("instructs LLM to emit sourceQuote for L2 candidates", async () => {
    await new MemoryJudge().judge("我用 React 18.2 做的前端", "记下来了", "conversation-1");

    const prompt = mocks.structuredOptions?.systemPrompt ?? "";
    expect(prompt).toContain("L2 sourceQuote 抽取");
    expect(prompt).toContain("L2 片段必须输出 sourceQuote");
    // 软上限 500 字要明确传给 LLM
    expect(prompt).toMatch(/500\s*字/);
    // 原文允许标点/空格/emoji（与 slug 严格规则不同）
    expect(prompt).toContain("允许标点、空格、emoji");
    // L0/L1 明确禁止 sourceQuote
    expect(prompt).toContain("L0 / L1 候选不要输出 sourceQuote 字段");
  });
});
