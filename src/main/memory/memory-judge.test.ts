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
  llmTexts: [] as string[],
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
    parseResponse: () => ({ text: mocks.llmTexts.shift() ?? mocks.llmText }),
  }),
}));

import { memoryJudge } from "./memory-judge";

function validL2Raw(sourceQuote?: string, facets?: Record<string, unknown>, evidenceTurnRefs?: string[]): string {
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
  if (evidenceTurnRefs !== undefined) candidate.evidenceTurnRefs = evidenceTurnRefs;
  return JSON.stringify([candidate]);
}

describe("MemoryJudge sourceQuote", () => {
  it.each([
    ["眼前景色只是梦境", "眼前景色在梦里面", true],
    ["用户只喝茶", "用户喝茶", false],
    ["用户只喝茶", "用户只是喜欢喝茶", false],
    ["用户永远喝茶", "用户喝茶", false],
    ["用户只喝茶", "用户只喝茶", true],
  ])("reviews risky wording within two calls: %s", async (summary, quote, accepted) => {
    const [raw] = JSON.parse(validL2Raw());
    mocks.llmText = JSON.stringify([{ ...raw, summary, evidenceQuotes: [quote] }]);
    if (accepted) {
      mocks.llmTexts = [mocks.llmText, JSON.stringify([{...raw,summary,evidenceQuotes:[quote],
        reason:"语义复核通过：原文与摘要表达相同范围，没有增加限制或确定性。"}])];
      const candidates = await memoryJudge.judgeRecentTurns([{ userInput: quote, assistantReply: "好的" }], "s");
      expect(candidates).toHaveLength(1);
    } else {
      await expect(memoryJudge.judgeRecentTurns([{ userInput: quote, assistantReply: "好的" }], "s")).rejects.toThrow("需要语义复核");
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(mocks.capturedMessages[1].content).toContain(quote);
      expect(mocks.capturedMessages[1].content).toContain("不要为通过检查机械删除词语");
    }
  });
  it("includes the persisted user and assistant timestamps for every turn", async () => {
    mocks.llmText = "[]"

    await memoryJudge.judgeRecentTurns([{
      userInput: "带时间的消息",
      assistantReply: "带时间的回复",
      userAt: Date.parse("2026-08-27T01:02:03.000Z"),
      assistantAt: Date.parse("2026-08-27T01:02:05.000Z"),
    }], "chat-1")

    expect(mocks.capturedMessages[1].content).toContain("用户时间：2026-08-27T01:02:03.000Z")
    expect(mocks.capturedMessages[1].content).toContain("AI时间：2026-08-27T01:02:05.000Z")
  })

  beforeEach(() => {
    mocks.llmTexts = [];
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

  it("retries an invalid temporary-index summary once and binds repaired evidence to IDs", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      const row = JSON.parse(validL2Raw())[0];
      row.summary = ++calls === 1 ? "用户于T1开始项目" : "用户在做前端项目";
      mocks.llmText = JSON.stringify([row]);
      return { ok: true, json: async () => ({}) };
    }));
    const candidates = await memoryJudge.judgeRecentTurns([
      { conversationId: "chat", userMessageId: "u1", userInput: "我在做前端", assistantReply: "嗯" },
    ], "chat", { priorTurnCount: 0, previousMemories: [] });
    expect(calls).toBe(2);
    expect(candidates[0].sourceMessageIds).toEqual(["u1"]);
    expect(candidates[0].sourceQuote).toBe("我在做前端");
    expect(mocks.capturedMessages[1].content).toContain("上次结果未通过写入校验");
  });

  it("rejects unmatched evidence after one repair rather than reporting an empty success", async () => {
    mocks.llmText = validL2Raw();
    await expect(memoryJudge.judgeRecentTurns([
      { conversationId: "chat", userMessageId: "u1", userInput: "不同原文", assistantReply: "我在做前端" },
    ], "chat", { priorTurnCount: 0, previousMemories: [] })).rejects.toThrow("证据");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("reviews old memories and emits a delta with the local target version", async () => {
    const row = JSON.parse(validL2Raw())[0];
    mocks.llmText = JSON.stringify([{ ...row, memoryAction: "supplement", targetMemoryId: "m1", targetVersion: "invented" }]);
    const candidates = await memoryJudge.judgeRecentTurns([
      { conversationId: "chat", userMessageId: "u1", userInput: "我在做前端", assistantReply: "嗯" },
    ], "chat", { priorTurnCount: 0, previousMemories: [{ id: "m1", content: "用户的旧项目", version: "local-version", sourceMessageIds: ["old"] }] });
    expect(candidates[0]).toMatchObject({ memoryAction: "supplement", targetMemoryId: "m1", targetVersion: "local-version", content: row.summary });
    expect(mocks.capturedMessages[0].content).toContain("summary 只写新增事实");
    expect(mocks.capturedMessages[1].content).not.toContain("local-version");
  });

  it("does not consume a truncated incremental array as a successful partial batch", async () => {
    mocks.llmText = validL2Raw().slice(0, -1);
    await expect(memoryJudge.judgeRecentTurns([
      { conversationId: "chat", userMessageId: "u1", userInput: "我在做前端", assistantReply: "嗯" },
    ], "chat", { priorTurnCount: 0, previousMemories: [] })).rejects.toThrow("完整数组");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("requires sourceQuote for L2 candidates in the extraction prompt", async () => {
    mocks.llmText = "[]";

    await memoryJudge.judgeRecentTurns([{ userInput: "我在做前端", assistantReply: "听起来不错" }], "chat-1");

    const systemPrompt = mocks.capturedMessages.find((m) => m.role === "system")?.content ?? "";
    expect(systemPrompt).toContain("sourceQuote");
    expect(systemPrompt).toContain("evidenceTurnRefs");
    expect(systemPrompt).toContain("T1～T8");
    expect(systemPrompt).toContain("原话");
    expect(systemPrompt).toContain("facets");
    expect(systemPrompt).toContain("primaryKind");
    expect(systemPrompt).toContain("retrievalKinds");
    expect(systemPrompt).toContain("最多 3 个");
    expect(systemPrompt).toContain("commitment");
    expect(systemPrompt).toContain("wish");
    expect(systemPrompt).toContain("只有用户明确表达具体情绪");
    expect(systemPrompt).toContain("不要仅因含有「等……以后」「如果……」就返回空数组");
    expect(systemPrompt).toContain("必须以 evidenceTurnRefs 所指轮次中事实所在消息的用户时间或 AI 时间为基准");
    expect(systemPrompt).toContain("MemoryJudge 当前运行或返回结果的时间不是事实时间锚点");
    expect(systemPrompt).toContain("不得把不同轮次的相对表达合并成同一个日期");
    expect(systemPrompt).toContain("无法唯一确定时保留不确定性");
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

  it("keeps only valid temporary evidence turn references", async () => {
    mocks.llmText = validL2Raw("我在做前端", undefined, ["T2", "T2", "T9", "bad"]);

    const candidates = await memoryJudge.judgeRecentTurns([
      { userInput: "上下文", assistantReply: "嗯" },
      { userInput: "我在做前端", assistantReply: "听起来不错" },
    ], "chat-1");

    expect(candidates[0].evidenceTurnRefs).toEqual(["T2"]);
    expect(mocks.capturedMessages[1].content).toContain("T2（第 2 轮）");
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
