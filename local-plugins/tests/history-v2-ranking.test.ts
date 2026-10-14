import { describe, expect, it } from "vitest";
import { rerankHistoryV2, type HistoryV2Candidate } from "../plugins/companion-memory/src/history-v2-ranking";
import { createHistoryRetrieval } from "../plugins/companion-memory/src/history-retrieval";
import type { PluginMemoryRetrievalService } from "@playa0v0/cyrene-plugin-sdk";

const candidates = (): HistoryV2Candidate[] => Array.from({ length: 12 }, (_, i) => ({
  id: String(i), sessionId: "session", turnId: String(i), text: `evidence ${i}`,
  role: i % 2 ? "assistant" : "user", score: 1,
}));
const run = (rows: HistoryV2Candidate[], supplementK: 0 | 3 = 0, scores = new Map<string, number>()) =>
  rerankHistoryV2({ candidates: rows, cleanUserQuery: "query", expandedQuery: "query", intentQuery: "query",
    finalK: 5, supplementK,
    rerank: async (_query, documents) => documents.map(text => ({ text, score: scores.get(text) ?? 1 })),
  });

describe("History V2 bounded supplements", () => {
  it("reranks expanded candidates with the original question and keeps its correction scores", async () => {
    const query = "那个装置已经接入了吗？";
    const calls: string[] = [];
    const rows: HistoryV2Candidate[] = [
      { id: "correction", text: "还没有接入，只是测试程序。", role: "user", score: 1 },
      { id: "unrelated", text: "另一个装置的外观。", role: "assistant", score: 1 },
    ];
    const result = await rerankHistoryV2({
      candidates: rows, cleanUserQuery: query, expandedQuery: `${query} 形状 外观`,
      intentQuery: "装置 外观", finalK: 2,
      rerank: async (actualQuery, documents) => {
        calls.push(actualQuery);
        return documents.map(text => ({ text, score: actualQuery === query
          ? (text === rows[0].text ? -2 : -7)
          : (text === rows[0].text ? -10 : 2) })).sort((a, b) => b.score - a.score);
      },
    });
    expect(calls).toEqual([query]);
    expect(result?.map(row => row.id)).toEqual(["correction"]);
    expect(result?.[0].relevanceScore).toBe(-2);
  });

  it("enables extras only for ordinary automatic retrieval and retains the off switch", async () => {
    const now = Date.now(), signal = new AbortController().signal;
    const messages = Array.from({ length: 20 }, (_, i) => ({
      id: String(i), sessionId: "host", role: i % 2 ? "assistant" as const : "user" as const,
      text: `蓝色丝带事件 ${i}`, at: now - (20 - i) * 1000,
    }));
    const service: PluginMemoryRetrievalService = {
      embed: async texts => ({ vectors: texts.map(() => [1]), identity: { provider: "test", model: "test", dimensions: 1 } }),
      rank: async ({ candidates, topK }) => ({ rankedIds: candidates.slice(0, topK).map(x => x.id), vectorHitIds: [],
        ranked: candidates.slice(0, topK).map(x => ({ id: x.id, score: 1, method: "hybrid" as const })) }),
      rerankDocuments: async ({ documents }) => documents.map(text => ({ text, score: 1 })),
    };
    const create = (supplementOrdinaryHistory: boolean, rerank = service.rerankDocuments) => createHistoryRetrieval({
      turns: () => [], hostMessages: async () => messages, now: () => now,
      service: { ...service, rerankDocuments: rerank }, supplementOrdinaryHistory,
    });
    const count = (text: string) => text.split("事件 ").length - 1;
    expect(count(await create(false).searchForAuto("还记得蓝色丝带吗", signal))).toBe(5);
    const enabled = create(true);
    expect(count(await enabled.searchForAuto("还记得蓝色丝带吗", signal))).toBe(8);
    expect(await enabled.searchForTool("蓝色丝带", signal, 90, "蓝色丝带", 10)).toContain("找到 10 条");
    expect(await enabled.searchForTool("蓝色丝带", signal, 90, "蓝色丝带", 3)).toContain("找到 3 条");
    for (const [scope, expected] of [["normal", 8], ["scoped_list", 10], ["exhaustive_list", 12]] as const) {
      expect(count(await enabled.searchForAuto("还记得蓝色丝带吗", signal, 90, {
        needsExpansion: true, retrievalKinds: ["experience"], scope, confidence: 1,
      }))).toBe(expected);
    }
    expect(count(await create(true, async () => null).searchForAuto("还记得蓝色丝带吗", signal))).toBeLessThanOrEqual(5);
  });
  it("preserves baseline objects and appends at most three distinct sources", async () => {
    const rows = candidates(), base = (await run(rows))!, result = (await run(rows, 3))!;
    expect(result.slice(0, base.length)).toEqual(base);
    expect(result).toHaveLength(8);
    expect(new Set(result.map(item => `${item.sessionId}:${item.turnId}`)).size).toBe(8);
  });

  it("filters prefetched extras at -6 without refilling their slots", async () => {
    const rows = candidates(), scores = new Map([[rows[5].text, -7], [rows[6].text, -6]]);
    const result = (await run(rows, 3, scores))!;
    expect(result.map(item => item.id)).toEqual(["0", "1", "2", "3", "4", "6", "7"]);
  });

  it("does not append another representation of a selected source", async () => {
    const rows = candidates();
    rows[5].turnId = "0";
    const result = (await run(rows, 3))!;
    expect(result.map(item => item.id)).toEqual(["0", "1", "2", "3", "4", "6", "7", "8"]);
  });

  it("does not penalize assistant evidence because it ends with a question", async () => {
    const plain = candidates(), question = candidates();
    question[1].text += "，是不是？";
    const before = (await run(plain))!, after = (await run(question))!;
    expect(after.map(item => item.id)).toEqual(before.map(item => item.id));
    expect(after.find(item => item.id === "1")!.score).toBe(before.find(item => item.id === "1")!.score);
  });
});
