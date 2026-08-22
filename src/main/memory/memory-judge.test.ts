// MemoryJudge sourceQuote 真实场景测试：
// - prompt 必须要求 L2 候选输出 sourceQuote（接线检查）
// - 模型输出的 sourceQuote 被保留、截 500 字；缺失时为 undefined 不崩
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dataDir: "",
  llmText: "[]",
  capturedMessages: [] as Array<{ role: string; content: string }>,
}));

vi.mock("../runtime/runtime-paths", () => ({
  getUserDataDir: () => mocks.dataDir,
}));
vi.mock("../token-usage-store", () => ({
  recordUsage: vi.fn(),
}));
vi.mock("../orchestrator/vendors", () => ({
  getAdapterForConfig: () => ({
    buildRequest: (req: { messages: Array<{ role: string; content: string }> }) => {
      mocks.capturedMessages = req.messages;
      return { url: "http://mock.local/chat", headers: {}, body: "{}" };
    },
    parseResponse: () => ({ text: mocks.llmText }),
  }),
}));

import { memoryJudge } from "./memory-judge";

function validL2Raw(sourceQuote?: string, facets?: Record<string, unknown>): string {
  const candidate: Record<string, unknown> = {
    layer: "L2",
    summary: "用户在做前端项目",
    importance: "medium",
    stability: "situational",
    certainty: "explicit",
    attribution: "user_explicit",
    evidenceQuotes: ["我在做前端"],
    contextSummary: "用户聊到自己的前端项目",
    shouldWrite: true,
    reason: "用户明确表达的项目信息",
    forbiddenOverclaims: [],
  };
  if (sourceQuote !== undefined) candidate.sourceQuote = sourceQuote;
  if (facets !== undefined) candidate.facets = facets;
  return JSON.stringify([candidate]);
}

describe("MemoryJudge sourceQuote", () => {
  beforeEach(() => {
    mocks.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-judge-"));
    mocks.llmText = "[]";
    mocks.capturedMessages = [];
    fs.writeFileSync(
      path.join(mocks.dataDir, "model-settings.json"),
      JSON.stringify({ provider: "mock", baseUrl: "http://mock.local", model: "mock-1", apiKey: "k1" }),
      "utf8",
    );
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({}) })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(mocks.dataDir, { recursive: true, force: true });
  });

  it("requires sourceQuote for L2 candidates in the extraction prompt", async () => {
    mocks.llmText = "[]";

    await memoryJudge.judgeRecentTurns([{ userInput: "我在做前端", assistantReply: "听起来不错" }], "chat-1");

    const systemPrompt = mocks.capturedMessages.find((m) => m.role === "system")?.content ?? "";
    expect(systemPrompt).toContain("sourceQuote");
    expect(systemPrompt).toContain("原话");
    expect(systemPrompt).toContain("facets");
    expect(systemPrompt).toContain("primaryKind");
    expect(systemPrompt).toContain("retrievalKinds");
    expect(systemPrompt).toContain("最多 3 个");
    expect(systemPrompt).toContain("commitment");
    expect(systemPrompt).toContain("wish");
    expect(systemPrompt).toContain("只有用户明确表达具体情绪");
    expect(systemPrompt).toContain("不要仅因含有「等……以后」「如果……」就返回空数组");
  });

  it("keeps the model-provided sourceQuote on the candidate", async () => {
    mocks.llmText = validL2Raw("我用 React 18.2 做的前端，部署在 vercel 上");

    const candidates = await memoryJudge.judgeRecentTurns([{ userInput: "我在做前端", assistantReply: "听起来不错" }], "chat-1");

    expect(candidates).toHaveLength(1);
    expect(candidates[0].sourceQuote).toBe("我用 React 18.2 做的前端，部署在 vercel 上");
  });

  it("truncates oversized sourceQuote to 500 chars to guard against model over-output", async () => {
    mocks.llmText = validL2Raw("长".repeat(800));

    const candidates = await memoryJudge.judgeRecentTurns([{ userInput: "我在做前端", assistantReply: "听起来不错" }], "chat-1");

    expect(candidates[0].sourceQuote).toHaveLength(500);
  });

  it("leaves sourceQuote undefined when the model omits it", async () => {
    mocks.llmText = validL2Raw();

    const candidates = await memoryJudge.judgeRecentTurns([{ userInput: "我在做前端", assistantReply: "听起来不错" }], "chat-1");

    expect(candidates[0].sourceQuote).toBeUndefined();
  });

  it("treats a missing API key as a retryable extraction failure", async () => {
    fs.writeFileSync(
      path.join(mocks.dataDir, "model-settings.json"),
      JSON.stringify({ provider: "mock", baseUrl: "http://mock.local", model: "mock-1", apiKey: "" }),
      "utf8",
    );

    await expect(memoryJudge.judgeRecentTurns([
      { userInput: "我答应以后把礼物做好", assistantReply: "好呀" },
    ], "chat-missing-key")).rejects.toThrow("missing api key");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("treats a non-empty malformed response as retryable instead of no-memory", async () => {
    mocks.llmText = "我分析过了，但这不是合法 JSON";

    await expect(memoryJudge.judgeRecentTurns([
      { userInput: "我准备明年完成这个约定", assistantReply: "我记住啦" },
    ], "chat-malformed-json")).rejects.toThrow("JSON 解析失败");
  });

  it("keeps model-classified facets on a new L2 candidate", async () => {
    mocks.llmText = validL2Raw(undefined, {
      primaryKind: "goal",
      retrievalKinds: ["goal", "commitment"],
    });

    const candidates = await memoryJudge.judgeRecentTurns([
      { userInput: "我准备继续学高等数学", assistantReply: "好呀" },
    ], "chat-1");

    expect(candidates[0].facets).toMatchObject({
      primaryKind: "goal",
      retrievalKinds: ["goal", "commitment"],
      source: "model",
      pendingClassification: false,
    });
  });

  it("classifies an old-memory batch without changing IDs", async () => {
    mocks.llmText = JSON.stringify([{
      id: "old-1",
      primaryKind: "goal",
      retrievalKinds: ["goal", "commitment"],
    }]);

    const results = await memoryJudge.classifyMemoryFacetsBatch([{
      id: "old-1",
      text: "我答应明年亲手给你做礼物",
    }]);

    const batchPrompt = mocks.capturedMessages.find((message) => message.role === "system")?.content ?? "";
    expect(batchPrompt).toContain("wish");
    expect(batchPrompt).toContain("已经完成的目标不再是 goal");
    expect(batchPrompt).toContain("不要推断隐含情绪");
    expect(batchPrompt).toContain("primaryKind");
    expect(batchPrompt).toContain("retrievalKinds");
    expect(batchPrompt).toContain("最多 3 个");
    expect(batchPrompt).not.toContain("topics");

    expect(results).toEqual([{
      id: "old-1",
      facets: {
        primaryKind: "goal",
        retrievalKinds: ["goal", "commitment"],
        source: "model",
        pendingClassification: false,
      },
    }]);
  });

  it("leaves invalid or missing batch labels for a later retry", async () => {
    mocks.llmText = JSON.stringify([{ id: "old-1", primaryKind: "invented", retrievalKinds: ["invented"] }]);
    await expect(memoryJudge.classifyMemoryFacetsBatch([
      { id: "old-1", text: "第一条" },
      { id: "old-2", text: "第二条" },
    ])).resolves.toEqual([]);
  });
});
