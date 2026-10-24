import { JsonVectorStore, SearchResult } from "./vectorstore";
import { EmbeddingProvider, getEmbeddingProvider } from "./embedding";
import { getReranker } from "./reranker";

export { registerJiebaCustomWord, registerJiebaCustomWords } from "./text-ranking";
import { getJiebaCustomWordsVersion, rankTokenizedCandidates, tokenizeText, type SearchToken } from "./text-ranking";

export interface RetrieveOptions {
  allowedEntryIds?: string[];
}

const docTokenCache = new WeakMap<object, { version: number; tokens: SearchToken[] }>();

function getDocTokens(entry: object & { text: string }): SearchToken[] {
  const version = getJiebaCustomWordsVersion();
  const cached = docTokenCache.get(entry);
  if (cached && cached.version === version) return cached.tokens;
  const tokens = tokenizeText(entry.text);
  docTokenCache.set(entry, { version, tokens });
  return tokens;
}
// ── 混合检索器 ──
export class HybridRetriever {
  private store: JsonVectorStore;
  private provider: EmbeddingProvider | null;

  constructor(store: JsonVectorStore, provider?: EmbeddingProvider | null) {
    this.store = store;
    this.provider = provider ?? null;
  }

  async retrieve(
    query: string,
    source?: string,
    topK = 5,
    options: RetrieveOptions = {},
    vectorWeight = 0.7,
    bm25Weight = 0.3
  ): Promise<SearchResult[]> {
    const stats = this.store.stats;
    if (stats.total === 0) return [];

    // 如果没有 provider，向量检索不可用，只用 BM25
    if (!this.provider) {
      const bm25Results = this.bm25Search(query, source, topK, options);
      return bm25Results;
    }

    // 1. Vector 检索
    const vectorResults = await this.store.search(query, source, this.provider, topK * 3, 0.3, options);

    // 2. BM25 检索
    const bm25Results = this.bm25Search(query, source, topK * 3, options);

    // 3. 融合：加权求和
    const merged: Map<string, { result: SearchResult; vectorScore: number; bm25Score: number }> = new Map();

    for (const r of vectorResults) {
      merged.set(r.entry.id, { result: r, vectorScore: r.score, bm25Score: 0 });
    }

    for (const r of bm25Results) {
      const existing = merged.get(r.entry.id);
      if (existing) {
        existing.bm25Score = r.score;
      } else {
        merged.set(r.entry.id, { result: r, vectorScore: 0, bm25Score: r.score });
      }
    }

    // 归一化 + 加权
    const all = Array.from(merged.values());
    const maxV = Math.max(...all.map((m) => m.vectorScore), 1);
    const maxB = Math.max(...all.map((m) => m.bm25Score), 1);

    const scored = all.map((m) => ({
      ...m.result,
      score: (m.vectorScore / maxV) * vectorWeight + (m.bm25Score / maxB) * bm25Weight,
    }));

    scored.sort((a, b) => b.score - a.score);
    const candidates = scored.slice(0, topK);

    // ── Reranker 精排 ──
    // 如果 reranker 可用，用 cross-encoder 对候选结果做精排
    const reranker = getReranker();
    if (reranker && candidates.length > 1) {
      try {
        const docs = candidates.map((c) => c.entry.text);
        const reranked = await reranker.rerank(query, docs);
        const scoreMap = new Map(reranked.map((r) => [r.text, r.score]));

        // 用 reranker 分数重排，但保留原始 hybrid 分数作为参考
        for (const c of candidates) {
          const rerankScore = scoreMap.get(c.entry.text);
          if (rerankScore !== undefined) {
            c.score = rerankScore;
          }
        }
        candidates.sort((a, b) => b.score - a.score);
      } catch (err) {
        console.warn("[HybridRetriever] reranker failed, using hybrid scores:", err);
      }
    }

    return candidates;
  }

  /**
   * 后台预热 BM25 分词缓存：把"首次检索才付全库分词成本"挪到导入完成的时刻。
   * 分片执行（每片 50 条、片间用 setImmediate 让出事件循环），单片只占毫秒级，
   * 不会像冷检索那样一次阻塞主线程两秒。失败静默——预热只是提前填缓存，
   * 检索路径自身始终能补算，正确性不依赖本方法。
   * 返回 Promise 供需要等待预热的调用方（如基准测试）使用，生产路径可不等待。
   */
  warmupBm25Tokens(entries: Array<{ text: string }>): Promise<void> {
    return new Promise((resolve) => {
      const total = entries.length;
      if (total === 0) {
        resolve();
        return;
      }
      const BATCH = 50;
      const warm = (start: number) => {
        try {
          const end = Math.min(start + BATCH, total);
          for (let i = start; i < end; i++) {
            getDocTokens(entries[i]);
          }
        } catch (err) {
          console.warn("[HybridRetriever] BM25 warmup failed:", err);
          resolve();
          return;
        }
        if (start + BATCH < total) {
          setImmediate(() => warm(start + BATCH));
        } else {
          resolve();
        }
      };
      setImmediate(() => warm(0));
    });
  }

  private bm25Search(query: string, source?: string, topK = 15, options: RetrieveOptions = {}): SearchResult[] {
    const entries = this.store["entries"] as Array<{
      id: string; text: string; embedding: number[]; source: string;
      weight: number; createdAt: number; lastRecalledAt: number; metadata?: Record<string, unknown>;
    }>;
    const allowedEntryIds = options.allowedEntryIds ? new Set(options.allowedEntryIds) : null;
    const docs = (source ? entries.filter((entry) => entry.source === source) : entries)
      .filter((entry) => !allowedEntryIds || allowedEntryIds.has(entry.id));
    const ranked = rankTokenizedCandidates(
      tokenizeText(query),
      docs.map((item) => ({ item, tokens: getDocTokens(item) })),
      topK,
    );
    return ranked.map(({ item: entry, score }) => ({ entry, score }));
  }
}
