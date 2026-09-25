import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { HybridRetriever, rankDetachedMemoryCandidates } from "./retriever";
import { JsonVectorStore } from "./vectorstore";
import type { EmbeddingProvider } from "./embedding";

const provider: EmbeddingProvider = {
  name: "deterministic",
  dims: 2,
  async embed(text: string): Promise<number[]> {
    return text.includes("beta") || text.includes("deadline") ? [0, 1] : [1, 0];
  },
  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((text) => this.embed(text)));
  },
};

const tempDirs: string[] = [];

function createStore(): JsonVectorStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rag-retriever-test-"));
  tempDirs.push(dir);
  return new JsonVectorStore(dir);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("HybridRetriever", () => {
  it("ranks detached plugin memories with the native hybrid and reranker chain", async () => {
    const rerank = vi.fn(async (_query: string, documents: string[]) => documents.map((text) => ({ text, score: text.includes("beta") ? 1 : 0 })));
    const result = await rankDetachedMemoryCandidates("deadline", [
      { id: "a", text: "alpha schedule", embedding: [1, 0], weight: 1, lastRecalledAt: 1_000 },
      { id: "b", text: "beta deadline", embedding: [0, 1], weight: 1, lastRecalledAt: 1_000 },
    ], 2, { provider, reranker: { name: "test", rerank }, now: 1_000 });

    expect(result.rankedIds).toEqual(["b", "a"]);
    expect(result.vectorHitIds).toEqual(["b"]);
    expect(result.ranked).toEqual([
      { id: "b", score: 1, method: "reranker" },
      { id: "a", score: 0, method: "reranker" },
    ]);
    expect(rerank).toHaveBeenCalledWith("deadline", expect.arrayContaining(["alpha schedule", "beta deadline"]));
  });

  it("supports a raw semantic channel without weight, decay, BM25, or reranker", async () => {
    const rerank = vi.fn();
    const result = await rankDetachedMemoryCandidates("deadline", [
      { id: "a", text: "deadline lexical noise", embedding: [1, 0], weight: 5, lastRecalledAt: 1_000 },
      { id: "b", text: "semantic match", embedding: [0, 1], weight: 0.1, lastRecalledAt: 0 },
    ], 2, { provider, reranker: { name: "unused", rerank }, now: 10_000_000, mode: "semantic" });

    expect(result.rankedIds).toEqual(["b"]);
    expect(result.ranked).toEqual([{ id: "b", score: 1, method: "semantic" }]);
    expect(rerank).not.toHaveBeenCalled();
  });

  it("falls back to native BM25 when no embedding provider is configured", async () => {
    const result = await rankDetachedMemoryCandidates("蓝色丝带", [
      { id: "other", text: "今天讨论天气", embedding: [], weight: 1, lastRecalledAt: 0 },
      { id: "match", text: "蓝色丝带系在摆件上", embedding: [], weight: 1, lastRecalledAt: 0 },
    ], 2, { provider: null, reranker: null });

    expect(result.rankedIds[0]).toBe("match");
    expect(result.vectorHitIds).toEqual([]);
  });

  it("offers the local user_memory lexical rescue channel independently of vectors", async () => {
    const candidates = [
      { id: "vector", text: "unrelated", embedding: [0, 1], weight: 1, lastRecalledAt: 1_000 },
      { id: "lexical", text: "蓝色丝带系在摆件上", embedding: [1, 0], weight: 1, lastRecalledAt: 1_000 },
    ];
    const result = await rankDetachedMemoryCandidates("蓝色丝带", candidates, 2, { provider, reranker: null, mode: "lexical" });
    expect(result.rankedIds[0]).toBe("lexical");
    expect(result.vectorHitIds).toEqual([]);
  });

  it("embeds document imports in bounded batches", async () => {
    const store = createStore();
    const embedBatch = vi.fn(async (texts: string[]) => texts.map(() => [1, 0]));
    const items = Array.from({ length: 17 }, (_, index) => ({ text: `chunk-${index}`, source: "imported_doc" }));

    await store.addBatch(items, { ...provider, embedBatch });

    expect(embedBatch).toHaveBeenCalledTimes(2);
    expect(embedBatch.mock.calls.map(([texts]) => texts.length)).toEqual([16, 1]);
  });

  it("limits imported document retrieval to the current turn importIds", async () => {
    const store = createStore();
    await store.addBatch(
      [
        {
          text: "alpha contract renewal date is April",
          source: "imported_doc",
          metadata: { importId: "turn-alpha", fileName: "alpha.md", chunkIndex: 0 },
        },
        {
          text: "beta budget deadline is May",
          source: "imported_doc",
          metadata: { importId: "turn-beta", fileName: "beta.md", chunkIndex: 0 },
        },
      ],
      provider,
    );

    const retriever = new HybridRetriever(store, provider);
    const results = await retriever.retrieve("deadline", "imported_doc", 5, {
      importIds: ["turn-beta"],
    });

    expect(results.map((result) => result.entry.text)).toEqual(["beta budget deadline is May"]);
  });

  it("filters disallowed entries before scoring or recall side effects", async () => {
    const store = createStore();
    const [active, stale] = store.addPreparedBatch([
      { text: "alpha active memory", source: "user_memory", embedding: [1, 0] },
      { text: "alpha stale memory", source: "user_memory", embedding: [0.99, 0.1] },
    ]);
    const staleWeight = stale.weight;
    const staleLastRecalledAt = stale.lastRecalledAt;
    const retriever = new HybridRetriever(store, provider);

    const results = await retriever.retrieve("alpha memory", "user_memory", 5, {
      allowedEntryIds: [active.id],
    });

    expect(results.map((result) => result.entry.id)).toEqual([active.id]);
    expect(stale.weight).toBe(staleWeight);
    expect(stale.lastRecalledAt).toBe(staleLastRecalledAt);
  });

  it("retrieves distinct entries with identical embeddings without IVF failure", async () => {
    const store = createStore();
    const entries = store.addPreparedBatch([
      { text: "same memory", source: "user_memory", embedding: [1, 0] },
      { text: "same memory", source: "user_memory", embedding: [1, 0] },
    ]);
    const retriever = new HybridRetriever(store, provider);

    const results = await retriever.retrieve("same memory", "user_memory", 5, {
      allowedEntryIds: entries.map((entry) => entry.id),
    });

    expect(results.map((result) => result.entry.id).sort()).toEqual(entries.map((entry) => entry.id).sort());
  });
});
