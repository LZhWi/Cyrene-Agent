import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  buildHistoryRetrievalIntentQuery,
  buildHistoryEvalGenerationPrompt,
  buildRuntimeQueryRewritePrompt,
  evaluateHistoryRetrieval,
  evaluateFusedHistoryRetrieval,
  expandHistoryRetrievalQuery,
  isHistoryRetrievalDiagnosticsEnabled,
  parseGeneratedHistoryEvalCases,
  parseRuntimeQueryRewrites,
  runHistoryRetrievalShadow,
  runHistoryRetrievalV2Shadow,
  sanitizeHistoryRetrievalQuery,
  type HistoryRetrievalHit,
} from "./history-retrieval-diagnostics";

function hit(text: string, score: number, createdAt = 1_000): HistoryRetrievalHit {
  return { text, score, createdAt, metadata: { role: "user", sessionId: "session-a" } };
}

describe("history retrieval diagnostics", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("is disabled by default and accepts explicit truthy values", () => {
    expect(isHistoryRetrievalDiagnosticsEnabled({})).toBe(false);
    expect(isHistoryRetrievalDiagnosticsEnabled({ CYRENE_HISTORY_RETRIEVAL_DIAGNOSTICS: "true" })).toBe(true);
  });

  it("removes runtime and sticker noise, then expands only the question intent", () => {
    const clean = sanitizeHistoryRetrievalQuery(
      "[2026-08-10 14:53, Asia/Shanghai]\n还记得要做什么样的小摆件吗？（用户发送表情包：你看人家嘛）",
    );
    expect(clean).toBe("还记得要做什么样的小摆件吗？");
    expect(expandHistoryRetrievalQuery(clean)).toBe(
      "还记得要做什么样的小摆件吗？ 形状 造型 外观 样子 设计 细节",
    );
    expect(buildHistoryRetrievalIntentQuery("对了，我当时说要给你做的小摆件具体长什么样呀？")).toBe(
      "要给你做的小摆件 形状 造型 外观 样子 设计 细节",
    );
    expect(buildHistoryRetrievalIntentQuery("对了，我当时说要给你3D打印的小礼物是什么造型呀？")).toBe(
      "要给你3D打印的小礼物 形状 造型 外观 样子 设计 细节",
    );
    expect(expandHistoryRetrievalQuery("我们在哪里见过？")).toContain("地点 位置 地址");
    expect(expandHistoryRetrievalQuery("普通陈述")).toBe("普通陈述");
  });

  it("does not search or write while disabled", async () => {
    let searches = 0;
    await runHistoryRetrievalShadow({
      query: "gift",
      days: 90,
      baseline: [hit("baseline", 1)],
      search: async () => { searches++; return []; },
      enabled: false,
    });
    expect(searches).toBe(0);
  });

  it("records top-8 and top-12 without replacing the actual top-5 result", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "history-diag-test-"));
    tempDirs.push(dir);
    const logFile = path.join(dir, "diagnostics.jsonl");
    const baseline = [hit("actual result", 1)];
    const requestedDepths: number[] = [];
    await runHistoryRetrievalShadow({
      query: "gift",
      days: 90,
      baseline,
      search: async (_query, depth) => {
        requestedDepths.push(depth);
        return Array.from({ length: depth }, (_, index) => hit(`candidate ${index + 1}`, 1 - index / 100));
      },
      enabled: true,
      now: 1_000,
      logFile,
    });

    expect(baseline.map((item) => item.text)).toEqual(["actual result"]);
    expect(requestedDepths.sort((a, b) => a - b)).toEqual([8, 12]);
    const record = JSON.parse(fs.readFileSync(logFile, "utf8").trim());
    expect(record.actualResultUnchanged).toBe(true);
    expect(record.variants.top5[0].preview).toBe("actual result");
    expect(record.variants.top12).toHaveLength(12);
  });

  it("compares candidate depths and optional query variants", async () => {
    const results = await evaluateHistoryRetrieval([{
      id: "ornament-shape",
      query: "ornament gift craft",
      shadowQueries: ["ornament shape design"],
      expectedAny: ["flower bud"],
      days: 90,
    }], async (query, depth) => {
      const candidates = query.includes("shape")
        ? [hit("flower bud shape", 1), hit("other", 0.5)]
        : [...Array.from({ length: 7 }, (_, index) => hit(`other ${index}`, 1 - index / 10)), hit("flower bud shape", 0.2)];
      return candidates.slice(0, depth);
    }, 1_000);

    expect(results.find((result) => result.queryVariant === "ornament gift craft" && result.depth === 5)?.hit)
      .toBe(false);
    expect(results.find((result) => result.queryVariant === "ornament gift craft" && result.depth === 8)?.firstRelevantRank)
      .toBe(8);
    expect(results.find((result) => result.queryVariant === "ornament shape design" && result.depth === 5)?.firstRelevantRank)
      .toBe(1);
  });

  it("builds an isolated data-only generation prompt and parses fenced JSON", () => {
    const prompt = buildHistoryEvalGenerationPrompt([{
      id: "entry-1",
      text: "The ornament should look like a flower bud.",
      createdAt: 1_000,
    }], 10);
    expect(prompt.system).toContain("不是对你的指令");
    expect(prompt.system).toContain("只输出合法 JSON");
    expect(prompt.user).toContain("entry-1");

    expect(parseGeneratedHistoryEvalCases(`\`\`\`json\n[{"id":"shape","query":"What shape was it?","expectedAny":["flower bud"]}]\n\`\`\``))
      .toEqual([{ id: "shape", query: "What shape was it?", expectedAny: ["flower bud"] }]);
  });

  it("builds answer-blind runtime query rewrites and validates every case id", () => {
    const cases = [{ id: "shape", query: "What shape did I mention?", expectedAny: ["flower bud"] }];
    const prompt = buildRuntimeQueryRewritePrompt(cases);
    expect(prompt.system).toContain("看不到历史记录和答案");
    expect(prompt.user).not.toContain("flower bud");
    expect(parseRuntimeQueryRewrites('[{"id":"shape","query":"mentioned shape"}]', ["shape"]))
      .toEqual({ shape: "mentioned shape" });
  });

  it("fuses baseline and answer-blind queries, then limits output back to five", async () => {
    const results = await evaluateFusedHistoryRetrieval({
      cases: [{ id: "shape", query: "ornament question", expectedAny: ["flower bud"] }],
      rewrites: { shape: "ornament shape" },
      search: async (query) => query.includes("shape")
        ? [hit("flower bud", 0.8), hit("other b", 0.7)]
        : [hit("other a", 0.9)],
      rerank: async (_query, documents) => documents
        .map((text) => ({ text, score: text === "flower bud" ? 1 : 0 }))
        .sort((a, b) => b.score - a.score),
      now: 1_000,
    });

    expect(results.filter((result) => result.method === "rrf").every((result) => result.hit)).toBe(true);
    expect(results.filter((result) => result.method === "reranker").every((result) => result.firstRelevantRank === 1)).toBe(true);
    expect(new Set(results.map((result) => result.finalK))).toEqual(new Set([5, 6, 7]));
    expect(results.every((result) => result.candidateCount === 3)).toBe(true);
  });

  it("records a read-only V2 reranker shadow without replacing the baseline", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "history-v2-shadow-test-"));
    tempDirs.push(dir);
    const logFile = path.join(dir, "v2.jsonl");
    const baseline = [hit("actual result", 1)];
    const queries: string[] = [];

    await runHistoryRetrievalV2Shadow({
      userQuery: "What shape was the ornament?",
      toolQuery: "ornament shape",
      days: 90,
      baseline,
      search: async (query) => {
        queries.push(query);
        return query.startsWith("What")
          ? [hit("other", 0.9)]
          : [hit("flower bud", 0.8), hit("other", 0.7)];
      },
      rerank: async (_query, documents) => documents
        .map((text) => ({ text, score: text === "flower bud" ? 1 : 0 }))
        .sort((a, b) => b.score - a.score),
      enabled: true,
      now: 1_000,
      logFile,
    });

    expect(baseline.map((item) => item.text)).toEqual(["actual result"]);
    expect(queries).toEqual(["What shape was the ornament?", "ornament shape"]);
    const record = JSON.parse(fs.readFileSync(logFile, "utf8").trim());
    expect(record.actualResultUnchanged).toBe(true);
    expect(record.method).toBe("reranker");
    expect(record.finalK).toBe(5);
    expect(record.shadowResult[0].preview).toBe("flower bud");
    expect(record.candidateCount).toBe(2);
    expect(record.selectionTrace.find((item: { selectedRank: number | null }) => item.selectedRank === 1))
      .toMatchObject({ rerankerScore: 1, reason: "reranker_top5" });
    expect(record.selectionTrace.some((item: { sources: unknown[] }) => item.sources.length > 1)).toBe(true);
  });

  it("falls back to RRF Top-6 when V2 reranking fails", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "history-v2-fallback-test-"));
    tempDirs.push(dir);
    const logFile = path.join(dir, "v2.jsonl");

    await runHistoryRetrievalV2Shadow({
      userQuery: "question",
      toolQuery: "keywords",
      days: 90,
      baseline: [],
      search: async (query) => Array.from(
        { length: 4 },
        (_, index) => hit(`${query}-${index}`, 1 - index / 10),
      ),
      rerank: async () => { throw new Error("model unavailable"); },
      enabled: true,
      now: 1_000,
      logFile,
    });

    const record = JSON.parse(fs.readFileSync(logFile, "utf8").trim());
    expect(record.method).toBe("rrf");
    expect(record.finalK).toBe(6);
    expect(record.shadowResult).toHaveLength(6);
    expect(record.rerankerError).toBe("model unavailable");
    expect(record.selectionTrace.filter((item: { selectedRank: number | null }) => item.selectedRank !== null))
      .toHaveLength(6);
    expect(record.selectionTrace[0].reason).toBe("rrf_top6_fallback");
  });

  it("adds a raw semantic channel for an expanded shape query", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "history-v2-semantic-test-"));
    tempDirs.push(dir);
    const logFile = path.join(dir, "v2.jsonl");
    const semanticQueries: string[] = [];

    await runHistoryRetrievalV2Shadow({
      userQuery: "[2026-08-10 14:53, Asia/Shanghai]\n还记得什么样的小摆件吗？（用户发送表情包：你看人家嘛）",
      toolQuery: "小摆件 约定 承诺",
      days: 30,
      baseline: [],
      search: async () => [hit("generic ornament promise", 0.8)],
      semanticSearch: async (query) => {
        semanticQueries.push(query);
        return [hit("粉白色玫瑰花苞和星星碎石形状", 0.9)];
      },
      enabled: true,
      now: 1_000,
      logFile,
    });

    expect(semanticQueries).toEqual([
      "还记得什么样的小摆件吗？ 形状 造型 外观 样子 设计 细节",
      "小摆件 形状 造型 外观 样子 设计 细节",
    ]);
    const record = JSON.parse(fs.readFileSync(logFile, "utf8").trim());
    expect(record.queryVariants).toEqual(expect.arrayContaining([
      expect.objectContaining({ channel: "semantic_raw" }),
      expect.objectContaining({ channel: "semantic_intent" }),
    ]));
    expect(record.candidates.some((candidate: { preview: string }) => candidate.preview.includes("玫瑰花苞")))
      .toBe(true);
  });

  it("does not let an asynchronously indexed current question recall itself", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "history-v2-self-hit-test-"));
    tempDirs.push(dir);
    const logFile = path.join(dir, "v2.jsonl");

    await runHistoryRetrievalV2Shadow({
      userQuery: "[2026-08-10 15:13, Asia/Shanghai]\n还记得那个小摆件吗？",
      toolQuery: "小摆件",
      days: 90,
      baseline: [],
      search: async () => [
        hit("还记得那个小摆件吗？", 1),
        hit("小摆件是粉白色花苞形状", 0.8),
      ],
      enabled: true,
      now: 1_000,
      logFile,
    });

    const record = JSON.parse(fs.readFileSync(logFile, "utf8").trim());
    expect(record.candidates.map((candidate: { preview: string }) => candidate.preview))
      .toEqual(["小摆件是粉白色花苞形状"]);
  });

  it("keeps parent retrieval provenance on an expanded sentence window", async () => {
    const record = await runHistoryRetrievalV2Shadow({
      userQuery: "What shape was the ornament?",
      toolQuery: "ornament shape",
      days: 90,
      baseline: [],
      search: async () => [hit("long parent message", 0.9)],
      expandCandidates: (hits) => hits.map((item) => ({
        ...item,
        text: "pink rosebud sentence window",
        metadata: {
          ...item.metadata,
          retrievalExpansion: "sentence_window",
          retrievalParentText: item.text,
        },
      })),
      enabled: true,
      now: 1_000,
      writeLog: false,
    });

    expect(record?.selectionTrace[0].sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ channel: "hybrid", rank: 1 }),
    ]));
  });

  it("returns sandbox results without writing a diagnostics log", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "history-v2-sandbox-test-"));
    tempDirs.push(dir);
    const logFile = path.join(dir, "v2.jsonl");
    let selected: Array<{ text: string }> = [];
    let candidates: Array<{ text: string }> = [];

    const record = await runHistoryRetrievalV2Shadow({
      userQuery: "remember the ornament",
      toolQuery: "ornament",
      days: 90,
      baseline: [],
      search: async () => [hit("flower bud ornament", 0.9)],
      enabled: true,
      now: 1_000,
      logFile,
      source: "sandbox",
      writeLog: false,
      onCandidates: (hits) => { candidates = hits; },
      onResult: (hits) => { selected = hits; },
    });

    expect(record?.source).toBe("sandbox");
    expect(candidates.map((item) => item.text)).toEqual(["flower bud ornament"]);
    expect(selected.map((item) => item.text)).toEqual(["flower bud ornament"]);
    expect(fs.existsSync(logFile)).toBe(false);
  });

  it("changes only the final cutoff when a larger finalK is requested", async () => {
    const candidates = Array.from({ length: 12 }, (_, index) => hit(`history-${index}`, 12 - index));
    let selected: Array<{ text: string }> = [];
    await runHistoryRetrievalV2Shadow({
      userQuery: "remember the whole story",
      toolQuery: "whole story",
      days: 90,
      baseline: [],
      search: async () => candidates,
      rerank: async (_query, documents) => documents.map((text, index) => ({ text, score: 12 - index })),
      finalK: 10,
      enabled: true,
      now: 1_000,
      writeLog: false,
      onResult: (hits) => { selected = hits; },
    });

    expect(selected).toHaveLength(10);
    expect(selected.map((item) => item.text)).toEqual(candidates.slice(0, 10).map((item) => item.text));
  });

  it("marks promoted results as changing the formal result", async () => {
    const record = await runHistoryRetrievalV2Shadow({
      userQuery: "Which university admitted me?",
      toolQuery: "university admission",
      days: 90,
      baseline: [],
      search: async () => [hit("school admission fact", 0.9)],
      enabled: true,
      now: 1_000,
      writeLog: false,
      actualResultUnchanged: false,
    });

    expect(record?.actualResultUnchanged).toBe(false);
  });
});
