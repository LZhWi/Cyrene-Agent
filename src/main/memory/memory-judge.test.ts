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

function validL2Raw(sourceQuote?: string): string {
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
});
