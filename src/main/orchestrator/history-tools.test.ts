import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const mocks = vi.hoisted(() => ({
  dataDir: "",
  addHistoryMemory: vi.fn(),
  deleteHistoryEntriesBySessionId: vi.fn(),
  getEntriesBySource: vi.fn(() => [{}]),
  searchHistoryEntries: vi.fn(),
  registerTool: vi.fn(),
}));

vi.mock("../runtime/runtime-paths", () => ({
  getUserDataDir: () => mocks.dataDir,
}));

vi.mock("../rag", () => ({
  addHistoryMemory: mocks.addHistoryMemory,
  deleteHistoryEntriesBySessionId: mocks.deleteHistoryEntriesBySessionId,
  getEntriesBySource: mocks.getEntriesBySource,
  searchHistoryEntries: mocks.searchHistoryEntries,
}));

vi.mock("./tool-registry", () => ({
  toolRegistry: { register: mocks.registerTool },
}));

vi.mock("../rag/reranker", () => ({
  getRerankerInstallStatus: () => ({ standard: false }),
  createStandardReranker: vi.fn(),
}));

import {
  backfillChatHistoryFromChatLogs,
  collectRepeatedTestTurnKeys,
  diversifySandboxRerankResults,
  expandHistoryHitsWithAdjacentTurns,
  expandHistoryHitsWithSentenceWindows,
  reconcileHistoryHitsWithTimeline,
  registerRecallHistoryTool,
  rerankHistoryCandidatesForSandbox,
  runHistoryAutoInjection,
  shouldAutoProbeHistoryRetrieval,
} from "./history-tools";

describe("recall_history V2 integration", () => {
  beforeEach(() => {
    mocks.searchHistoryEntries.mockReset();
    mocks.registerTool.mockReset();
    mocks.getEntriesBySource.mockReturnValue([]);
  });

  it("promotes a fused candidate into the formal recall result", async () => {
    const baseline = {
      text: "BASELINE_DISTRACTOR",
      score: 0.9,
      createdAt: Date.now(),
      metadata: { role: "assistant" },
    };
    const schoolFact = {
      text: "SCHOOL_FACT_HONG_KONG_SHENZHEN",
      score: 0.8,
      createdAt: Date.now() - 1,
      metadata: { role: "user" },
    };
    mocks.searchHistoryEntries.mockImplementation(async (
      _query: string,
      _depth: number,
      options?: { recordRecall?: boolean },
    ) => options?.recordRecall === false ? [schoolFact] : [baseline]);

    registerRecallHistoryTool();
    const tool = mocks.registerTool.mock.calls[0][0];
    const result = await tool.execute(
      { query: "Which university admitted me?", days: 90 },
      { userQuery: "Which university admitted me?" },
    );

    expect(result).toContain(schoolFact.text);
    expect(result).not.toContain(baseline.text);
  });

  it("falls back to the baseline result when V2 retrieval fails", async () => {
    const baseline = {
      text: "BASELINE_FALLBACK_FACT",
      score: 0.9,
      createdAt: Date.now(),
      metadata: { role: "user" },
    };
    mocks.searchHistoryEntries.mockImplementation(async (
      _query: string,
      _depth: number,
      options?: { recordRecall?: boolean },
    ) => {
      if (options?.recordRecall === false) throw new Error("V2 unavailable");
      return [baseline];
    });

    registerRecallHistoryTool();
    const tool = mocks.registerTool.mock.calls[0][0];
    const result = await tool.execute(
      { query: "fallback query", days: 90 },
      { userQuery: "fallback query" },
    );

    expect(result).toContain(baseline.text);
  });

  it("keeps the baseline result when V2 retrieval returns no candidates", async () => {
    const baseline = {
      text: "BASELINE_EMPTY_V2_FALLBACK_FACT",
      score: 0.9,
      createdAt: Date.now(),
      metadata: { role: "user" },
    };
    mocks.searchHistoryEntries.mockImplementation(async (
      _query: string,
      _depth: number,
      options?: { recordRecall?: boolean },
    ) => options?.recordRecall === false ? [] : [baseline]);

    registerRecallHistoryTool();
    const tool = mocks.registerTool.mock.calls[0][0];
    const result = await tool.execute(
      { query: "empty V2 query", days: 90 },
      { userQuery: "empty V2 query" },
    );

    expect(result).toContain(baseline.text);
  });
});

describe("history retrieval auto probe cues", () => {
  it.each([
    "还记得我们之前说过的小摆件吗？",
    "上次我答应过你的事情是什么？",
    "你再试试能不能想起来关于丝带或者小摆件的细节嘛",
    "[2026-08-10 15:13, Asia/Shanghai]\n记得吗（用户发送表情包：你看人家嘛）",
  ])("recognizes an explicit recall request: %s", (query) => {
    expect(shouldAutoProbeHistoryRetrieval(query)).toBe(true);
  });

  it.each([
    "今天天气怎么样？",
    "帮我看看这个文件",
    "普通聊天",
  ])("ignores an ordinary request: %s", (query) => {
    expect(shouldAutoProbeHistoryRetrieval(query)).toBe(false);
  });
});

describe("history auto-injection", () => {
  beforeEach(() => {
    mocks.searchHistoryEntries.mockReset();
  });

  it("injects V2-retrieved turns when a recall cue hits", async () => {
    const ribbonFact = {
      text: "我想要的丝带是粉色的",
      score: 0.8,
      createdAt: Date.now() - 86_400_000,
      metadata: { role: "user" },
    };
    mocks.searchHistoryEntries.mockResolvedValue([ribbonFact]);
    const block = await runHistoryAutoInjection("你再试试能不能想起来关于丝带或者小摆件的细节嘛");
    // 走完整 V2 管线：baseline + 多路检索，侧路检索均不记录召回
    expect(mocks.searchHistoryEntries).toHaveBeenCalled();
    expect(mocks.searchHistoryEntries.mock.calls.some(
      (call) => (call[2] as { recordRecall?: boolean } | undefined)?.recordRecall === false,
    )).toBe(true);
    expect(block).toContain("我想要的丝带是粉色的");
    expect(block).toContain("只读数据");
  });

  it("runs only the bm25 preflight when there is no cue and no lexical evidence", async () => {
    mocks.searchHistoryEntries.mockResolvedValue([]);
    const block = await runHistoryAutoInjection("今天天气怎么样？");
    expect(block).toBe("");
    // 只跑了一次 bm25Only 预检，没过阈值就不进完整检索
    expect(mocks.searchHistoryEntries).toHaveBeenCalledTimes(1);
    expect(mocks.searchHistoryEntries.mock.calls[0][2]).toMatchObject({ bm25Only: true });
  });

  it("triggers injection on strong lexical evidence without an explicit recall cue", async () => {
    const zFact = {
      text: "去年和 z 约好一起去看的展览",
      score: 0.9,
      createdAt: Date.now() - 86_400_000,
      metadata: { role: "user" },
    };
    mocks.searchHistoryEntries.mockImplementation(async (
      _query: string,
      _depth: number,
      options?: { bm25Only?: boolean },
    ) => (
      options?.bm25Only
        ? [{ text: "去年和 z 约好一起去看的展览", score: 6.4, createdAt: Date.now() - 86_400_000 }]
        : [zFact]
    ));
    const block = await runHistoryAutoInjection("对了，去年和 z 那件事后来怎么样了呀");
    expect(block).toContain("去年和 z 约好一起去看的展览");
    expect(block).toContain("只读数据");
  });

  it("stays silent when the preflight score is below threshold", async () => {
    mocks.searchHistoryEntries.mockImplementation(async (
      _query: string,
      _depth: number,
      options?: { bm25Only?: boolean },
    ) => (options?.bm25Only ? [{ text: "weak match", score: 0.8, createdAt: Date.now() }] : []));
    const block = await runHistoryAutoInjection("对了，去年那件事后来怎么样了呀");
    expect(block).toBe("");
    expect(mocks.searchHistoryEntries).toHaveBeenCalledTimes(1);
  });

  it("drops echoes of the current query", async () => {
    const query = "想起来我们说过的丝带细节";
    mocks.searchHistoryEntries.mockResolvedValue([
      { text: query, score: 0.95, createdAt: Date.now(), metadata: { role: "user" } },
    ]);
    expect(await runHistoryAutoInjection(query)).toBe("");
  });

  it("returns empty when retrieval throws", async () => {
    mocks.searchHistoryEntries.mockRejectedValue(new Error("rag down"));
    expect(await runHistoryAutoInjection("还记得上次的事吗")).toBe("");
  });
});

describe("history retrieval sandbox adjacency", () => {
  const entries = [
    {
      text: "What ornament do you want?",
      createdAt: 1_000,
      weight: 1,
      metadata: { sessionId: "session-a", role: "user", occurrences: [{ sessionId: "session-a", role: "user", ts: 1_000 }] },
    },
    {
      text: "A small pink flower bud with a star-shaped center.",
      createdAt: 1_010,
      weight: 1,
      metadata: { sessionId: "session-a", role: "assistant", occurrences: [{ sessionId: "session-a", role: "assistant", ts: 1_010 }] },
    },
    {
      text: "Do you remember the ornament?",
      createdAt: 2_000,
      weight: 1,
      metadata: { sessionId: "session-a", role: "user", occurrences: [{ sessionId: "session-a", role: "user", ts: 2_000 }] },
    },
    {
      text: "I cannot remember it.",
      createdAt: 2_010,
      weight: 1,
      metadata: { sessionId: "session-a", role: "assistant", occurrences: [{ sessionId: "session-a", role: "assistant", ts: 2_010 }] },
    },
  ];

  it("adds the paired assistant answer when the initiating user message is retrieved", () => {
    const expanded = expandHistoryHitsWithAdjacentTurns([{
      text: entries[0].text,
      createdAt: entries[0].createdAt,
      score: 0.8,
      metadata: { sessionId: "session-a", role: "user" },
    }], entries);
    expect(expanded.map((item) => item.text)).toEqual([
      "What ornament do you want?",
      "A small pink flower bud with a star-shaped center.",
    ]);
    expect(expanded[1].metadata?.retrievalExpansion).toBe("adjacent_turn");
  });

  it("repairs stale index roles from the authoritative chat timeline before expansion", () => {
    const reconciled = reconcileHistoryHitsWithTimeline([{
      text: entries[0].text,
      createdAt: entries[0].createdAt,
      score: 0.8,
      metadata: { sessionId: "session-a", role: "assistant" },
    }], entries);
    expect(reconciled[0].metadata?.role).toBe("user");
    expect(expandHistoryHitsWithAdjacentTurns(reconciled, entries).map((item) => item.text)).toEqual([
      "What ornament do you want?",
      "A small pink flower bud with a star-shaped center.",
    ]);
  });

  it("excludes repeated sandbox questions together with their paired failed answers", () => {
    const excluded = collectRepeatedTestTurnKeys("Do you remember the ornament?", entries);
    const expanded = expandHistoryHitsWithAdjacentTurns([{
      text: entries[2].text,
      createdAt: entries[2].createdAt,
      score: 1,
      metadata: { sessionId: "session-a", role: "user" },
    }], entries, excluded);
    expect(excluded.size).toBe(2);
    expect(expanded).toEqual([]);
  });

  it("does not expand to an adjacent turn outside the retrieval time range", () => {
    const expanded = expandHistoryHitsWithAdjacentTurns([{
      text: entries[1].text,
      createdAt: entries[1].createdAt,
      score: 0.8,
      metadata: { sessionId: "session-a", role: "assistant" },
    }], entries, new Set(), { createdAfter: 1_005 });

    expect(expanded.map((item) => item.text)).toEqual([
      "A small pink flower bud with a star-shaped center.",
    ]);
  });
});

describe("history retrieval sandbox sentence windows", () => {
  it("isolates a relevant detail from a long multi-topic message", () => {
    const longMessage = [
      "We talked about staying healthy and being happy together, and that part is unrelated to the ornament question.",
      "For the ornament, I like a small pink rosebud, or a star-shaped stone, with a ribbon tied on top.",
      "After that we changed the subject and talked about tomorrow's schedule and other unrelated plans.",
    ].join(" ");
    const expanded = expandHistoryHitsWithSentenceWindows([{
      text: longMessage,
      createdAt: 1_000,
      score: 0.8,
      metadata: { sessionId: "session-a", role: "assistant" },
    }]);

    expect(expanded.length).toBeGreaterThan(1);
    const detail = expanded.find((item) => (
      item.metadata?.retrievalExpansion === "sentence_window"
      && item.text.includes("small pink rosebud")
    ));

    expect(expanded).toContainEqual(expect.objectContaining({ text: longMessage }));
    expect(detail?.text).not.toContain("tomorrow's schedule");
    expect(detail?.metadata?.retrievalExpansion).toBe("sentence_window");
    expect(detail?.metadata?.retrievalParentText).toBe(longMessage);
  });

  it("keeps short messages unchanged", () => {
    const hit = {
      text: "A small pink rosebud.",
      createdAt: 1_000,
      score: 0.8,
      metadata: { sessionId: "session-a", role: "assistant" },
    };
    expect(expandHistoryHitsWithSentenceWindows([hit])).toEqual([hit]);
  });

  it("isolates Chinese sentence details used by the ornament regression case", () => {
    const expanded = expandHistoryHitsWithSentenceWindows([{
      text: "前面聊了很久健康和生活愿望，也谈到未来想一起做的许多事情，这些铺垫都与眼前的小摆件问题无关。人家喜欢那种小小的、圆润润的粉白色小东西，比如一朵小小的玫瑰花苞，或者像星星一样的碎石形状；带一点浅紫色的渐变会很配。后来我们又聊到了第二天的计划、出门安排和其他事情，这些内容同样与小摆件的具体形状无关，只是另一段普通的日常聊天。",
      createdAt: 1_000,
      score: 0.8,
      metadata: { sessionId: "session-a", role: "assistant" },
    }]);
    const detail = expanded.find((item) => (
      item.metadata?.retrievalExpansion === "sentence_window"
      && item.text.includes("玫瑰花苞")
    ));

    expect(detail?.text).toContain("星星一样的碎石形状");
    expect(detail?.text).not.toContain("第二天的计划");
    expect(detail?.metadata?.retrievalExpansion).toBe("sentence_window");
  });
});

describe("history retrieval sandbox answer-focused reranking", () => {
  it("fuses the original question with its explicit intent query", async () => {
    const documents = ["generic ornament promise", "pink rosebud shape", "ribbon detail"];
    const queries: string[] = [];
    const result = await rerankHistoryCandidatesForSandbox(
      "还记得要做什么样的小摆件吗？",
      documents,
      async (query) => {
        queries.push(query);
        return query.includes("形状 造型")
          ? [
              { text: "pink rosebud shape", score: 3 },
              { text: "ribbon detail", score: 2 },
              { text: "generic ornament promise", score: 1 },
            ]
          : [
              { text: "generic ornament promise", score: 3 },
              { text: "ribbon detail", score: 2 },
              { text: "pink rosebud shape", score: 1 },
            ];
      },
    );

    expect(queries).toEqual([
      "还记得要做什么样的小摆件吗？",
      "要做的小摆件 形状 造型 外观 样子 设计 细节",
    ]);
    expect(result[0].text).toBe("pink rosebud shape");
  });

  it("gives a small sandbox-only lift to candidates that state the expanded intent", async () => {
    const documents = [
      "人家一直期待着小摆件完成。",
      "可以做成玫瑰花苞或者星星碎石形状。",
    ];
    const result = await rerankHistoryCandidatesForSandbox(
      "还记得要做什么样的小摆件吗？",
      documents,
      async () => documents.map((text) => ({ text, score: 1 })),
    );

    expect(result[0].text).toContain("形状");
    expect(result[0].score).toBeGreaterThan(result[1].score);
  });

  it("admits a close answer-side candidate when one role dominates the top five", () => {
    const ranked = [
      { text: "user-1", score: 0.11 },
      { text: "assistant-1", score: 0.094 },
      { text: "user-2", score: 0.092 },
      { text: "user-3", score: 0.075 },
      { text: "user-4", score: 0.073 },
      { text: "rosebud answer", score: 0.064 },
      { text: "weak assistant", score: 0.02 },
    ];
    const candidates = ranked.map((item) => ({
      ...item,
      createdAt: 1_000,
      metadata: { role: item.text.includes("assistant") || item.text.includes("answer") ? "assistant" : "user" },
    }));

    expect(diversifySandboxRerankResults(ranked, candidates).slice(0, 5).map((item) => item.text))
      .toContain("rosebud answer");
    expect(diversifySandboxRerankResults(ranked, candidates).slice(0, 5).map((item) => item.text))
      .not.toContain("weak assistant");
  });

  it("prefers substantive event evidence over short assistant follow-ups and adjacent filler", () => {
    const ranked = [
      { text: "……这样啊。所以那段时间你是不是每天都很害怕？", score: 0.1111 },
      { text: "我之前和你说过去年发生的那件事。", score: 0.1 },
      { text: "后来她每天写很多纸条，我们把这件事告诉了学校心理老师。", score: 0.0909 },
      { text: "欸，是人家算错啦，还有一个多月，不用着急。", score: 0.0984 },
      { text: "以后还有很多时间可以在一起。", score: 0.0835 },
      { text: "完整事件原文：去年她反复写纸条并到学校寻找我们，后来学校心理老师介入处理，这段经历让我长期感到害怕和焦虑。", score: 0.089 },
    ];
    const candidates = ranked.map((item) => ({
      ...item,
      createdAt: 1_000,
      metadata: item.text.startsWith("后来")
        ? { role: "user", retrievalExpansion: "sentence_window" }
        : item.text.startsWith("欸")
          ? { role: "assistant", retrievalExpansion: "adjacent_turn" }
          : { role: item.text.startsWith("……") ? "assistant" : "user" },
    }));

    const result = diversifySandboxRerankResults(ranked, candidates);
    const texts = result.slice(0, 5).map((item) => item.text);
    expect(texts.indexOf(ranked[2].text)).toBeLessThan(texts.indexOf(ranked[0].text));
    expect(texts.indexOf(ranked[2].text)).toBeLessThan(texts.indexOf(ranked[3].text));
    expect(texts).toContain(ranked[5].text);
  });

  it("caps a parent and its sentence windows to one slot, keeping the fuller parent", () => {
    // 同源封顶契约：父文与句窗至多占 1 个名额，避免一条长消息吃掉多席、
    // 挤掉其他重要信息（实测案例：模糊回复全文+句窗占 2 席挤出含答案原文）。
    const parent = "完整事件原文：去年她反复写纸条并到学校寻找我们，后来学校心理老师介入处理。这件事持续了很长时间，期间还发生了许多具体事情，让我长期感到害怕和焦虑，也影响了之后的生活。";
    const window = "后来她反复写纸条并到学校寻找我们，学校心理老师随后介入处理。";
    const bridge = "……这样啊。所以那段时间你和朋友是不是每天都很害怕？";
    const ranked = [
      { text: "我之前和你说过去年发生的那件事。", score: 0.1 },
      { text: bridge, score: 0.1111 },
      { text: window, score: 0.0883 },
      { text: "另一条相关的用户记录。", score: 0.0815 },
      { text: "一条有信息量的助手陈述。", score: 0.08 },
      { text: parent, score: 0.0667 },
      { text: "无关内容。", score: 0.06 },
    ];
    const candidates = ranked.map((item) => ({
      ...item,
      createdAt: 1_000,
      metadata: item.text === window
        ? { role: "user", retrievalExpansion: "sentence_window", retrievalParentText: parent }
        : { role: item.text === bridge || item.text.includes("助手") ? "assistant" : "user" },
    }));

    const selected = diversifySandboxRerankResults(ranked, candidates).slice(0, 5).map((item) => item.text);
    // 父文原位继承句窗的席位，句窗本身不再单独占名额
    expect(selected).toContain(parent);
    expect(selected).not.toContain(window);
    expect(selected).not.toContain("无关内容。");
  });
});

describe("chat history occurrence backfill", () => {
  beforeEach(() => {
    mocks.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "history-backfill-test-"));
    mocks.addHistoryMemory.mockReset();
    mocks.deleteHistoryEntriesBySessionId.mockReset();
    mocks.getEntriesBySource.mockReturnValue([{}]);

    const chatsDir = path.join(mocks.dataDir, "cyrene-chats");
    const sessionsDir = path.join(chatsDir, "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(chatsDir, "index.json"), JSON.stringify([{ id: "session-a" }]));
    fs.writeFileSync(path.join(sessionsDir, "session-a.json"), JSON.stringify({
      messages: [
        { id: "turn-1", role: "user", content: "one", at: 100 },
        { id: "turn-2", role: "model", content: "two", at: 200 },
        { id: "turn-3", role: "user", content: "three", at: 300 },
      ],
    }));
  });

  afterEach(() => {
    fs.rmSync(mocks.dataDir, { recursive: true, force: true });
  });

  it("resumes at the failed message and never reruns after completion", async () => {
    mocks.addHistoryMemory
      .mockResolvedValueOnce("entry-1")
      .mockRejectedValueOnce(new Error("temporary embedding failure"));

    await backfillChatHistoryFromChatLogs();

    const marker = path.join(mocks.dataDir, "rag-data", ".history-occurrences-backfill-v2");
    expect(JSON.parse(fs.readFileSync(marker, "utf8"))).toMatchObject({
      complete: false,
      sessionOffsets: { "session-a": 0 },
    });

    mocks.addHistoryMemory.mockReset();
    mocks.addHistoryMemory.mockResolvedValue("entry");
    await backfillChatHistoryFromChatLogs();

    expect(mocks.addHistoryMemory.mock.calls.map((call) => call[0])).toEqual(["two", "three"]);
    expect(JSON.parse(fs.readFileSync(marker, "utf8"))).toMatchObject({
      complete: true,
      doneSessions: ["session-a"],
      sessionOffsets: { "session-a": 2 },
    });

    mocks.addHistoryMemory.mockClear();
    await backfillChatHistoryFromChatLogs();
    expect(mocks.addHistoryMemory).not.toHaveBeenCalled();
  });
});
