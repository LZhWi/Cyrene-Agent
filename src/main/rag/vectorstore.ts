import * as fs from "fs";
import * as path from "path";
import { getEmbeddingProvider, EmbeddingProvider } from "./embedding";

// ── 类型 ──
export interface MemoryEntry {
  id: string;
  text: string;
  embedding: number[];
  source: string;       // "user_memory" | "worldbook" | "imported_doc"
  weight: number;       // 1.0 初始，每次召回 +0.1，24h 未提 ×0.95
  createdAt: number;    // timestamp
  lastRecalledAt: number;
  metadata?: Record<string, unknown>;
}

export interface ChatHistoryOccurrence {
  sessionId: string;
  role: "user" | "assistant";
  ts: number;
  turnId?: string;
}

export interface SearchResult {
  entry: MemoryEntry;
  score: number;        // 加权后的综合分数（余弦 × weight × 衰减）
}

export interface VectorSearchOptions {
  importIds?: string[];
  allowedEntryIds?: string[];
  /** 得分 = 纯余弦相似度，不乘权重/时间衰减。供"判同"场景（如 add 去重）使用。 */
  rawScore?: boolean;
}

// ── 余弦相似度（嵌入已归一化，等价于点积） ──
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

export function normalizeChatHistoryText(text: string): string {
  return text.normalize("NFC").replace(/\r\n?/g, "\n").trim();
}

function occurrenceFromMetadata(entry: MemoryEntry): ChatHistoryOccurrence | null {
  const metadata = entry.metadata;
  const sessionId = typeof metadata?.sessionId === "string" ? metadata.sessionId : "";
  const role = metadata?.role === "user" || metadata?.role === "assistant" ? metadata.role : null;
  const ts = typeof metadata?.ts === "number" && Number.isFinite(metadata.ts) ? metadata.ts : entry.createdAt;
  if (!sessionId || !role) return null;
  return {
    sessionId,
    role,
    ts,
    ...(typeof metadata?.turnId === "string" && metadata.turnId ? { turnId: metadata.turnId } : {}),
  };
}

function occurrencesFromEntry(entry: MemoryEntry): ChatHistoryOccurrence[] {
  const raw = entry.metadata?.occurrences;
  if (Array.isArray(raw)) {
    const occurrences = raw.flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const item = value as Record<string, unknown>;
      if (typeof item.sessionId !== "string" || !item.sessionId) return [];
      if (item.role !== "user" && item.role !== "assistant") return [];
      if (typeof item.ts !== "number" || !Number.isFinite(item.ts)) return [];
      return [{
        sessionId: item.sessionId,
        role: item.role,
        ts: item.ts,
        ...(typeof item.turnId === "string" && item.turnId ? { turnId: item.turnId } : {}),
      } satisfies ChatHistoryOccurrence];
    });
    if (occurrences.length > 0) return occurrences;
  }
  const legacy = occurrenceFromMetadata(entry);
  return legacy ? [legacy] : [];
}

function sameOccurrence(a: ChatHistoryOccurrence, b: ChatHistoryOccurrence): boolean {
  if (a.turnId && b.turnId) return a.turnId === b.turnId;
  return a.sessionId === b.sessionId && a.role === b.role && a.ts === b.ts;
}

function metadataWithOccurrences(
  metadata: Record<string, unknown> | undefined,
  occurrences: ChatHistoryOccurrence[],
): Record<string, unknown> {
  const latest = occurrences.reduce((best, item) => item.ts >= best.ts ? item : best);
  const { turnId: _legacyTurnId, ...rest } = metadata ?? {};
  return {
    ...rest,
    sessionId: latest.sessionId,
    role: latest.role,
    ts: latest.ts,
    occurrences,
  };
}

// ── IVF 倒排文件索引 ──
// 用 k-means 把向量聚成 K 个簇，搜索时只查最近的 nprobe 个簇，
// 将 O(n) 变为 O(n / K * nprobe) ≈ O(√n)。
interface IvfIndex {
  /** 簇中心向量（已归一化） */
  centroids: number[][];
  /** 每个簇中的条目 index（指向 this.entries） */
  clusters: number[][];
  /** 建索引时的条目数，用于判定是否需要重建 */
  entryCount: number;
}

function kmeansPlusPlusInit(
  vectors: number[][],
  K: number,
  dim: number,
): number[][] {
  const centroids: number[][] = [];
  // 1. 随机选第一个中心
  const firstIdx = Math.floor(Math.random() * vectors.length);
  centroids.push(vectors[firstIdx].slice());

  // 2. 按距离平方加权选剩下的
  for (let c = 1; c < K; c++) {
    const dists = vectors.map((v) => {
      let minDist = Infinity;
      for (const cent of centroids) {
        const sim = cosineSimilarity(v, cent);
        const d = 1 - sim; // 余弦距离 = 1 - cos
        if (d < minDist) minDist = d;
      }
      return minDist * minDist;
    });
    const totalDist = dists.reduce((a, b) => a + b, 0);
    if (totalDist <= 0) {
      while (centroids.length < K) {
        centroids.push(vectors[centroids.length % vectors.length].slice());
      }
      break;
    }
    let r = Math.random() * totalDist;
    for (let i = 0; i < dists.length; i++) {
      r -= dists[i];
      if (r <= 0) {
        centroids.push(vectors[i].slice());
        break;
      }
    }
  }
  return centroids;
}

function buildIvfIndex(
  entries: MemoryEntry[],
  K: number,
  maxIter = 20,
): IvfIndex {
  const vectors = entries.map((e) => e.embedding);
  const dim = vectors[0]?.length ?? 0;
  if (dim === 0 || vectors.length === 0) {
    return { centroids: [], clusters: [], entryCount: entries.length };
  }

  const effectiveK = Math.min(K, vectors.length);
  const clusters: number[][] = Array.from({ length: effectiveK }, () => []);

  // k-means++ 初始化
  let centroids = kmeansPlusPlusInit(vectors, effectiveK, dim);

  for (let iter = 0; iter < maxIter; iter++) {
    // 分配
    for (let i = 0; i < effectiveK; i++) clusters[i] = [];
    let changed = false;

    for (let i = 0; i < vectors.length; i++) {
      let bestIdx = 0;
      let bestSim = -Infinity;
      for (let c = 0; c < effectiveK; c++) {
        const sim = cosineSimilarity(vectors[i], centroids[c]);
        if (sim > bestSim) {
          bestSim = sim;
          bestIdx = c;
        }
      }
      clusters[bestIdx].push(i);
    }

    // 更新中心
    const newCentroids: number[][] = [];
    for (let c = 0; c < effectiveK; c++) {
      const members = clusters[c];
      if (members.length === 0) {
        // 空簇保留原中心
        newCentroids.push(centroids[c].slice());
        continue;
      }
      const sum = new Array(dim).fill(0);
      for (const idx of members) {
        const v = vectors[idx];
        for (let d = 0; d < dim; d++) sum[d] += v[d];
      }
      // 归一化新中心
      let norm = 0;
      for (let d = 0; d < dim; d++) norm += sum[d] * sum[d];
      norm = Math.sqrt(norm);
      if (norm > 0) {
        for (let d = 0; d < dim; d++) sum[d] /= norm;
      }
      newCentroids.push(sum);
    }

    // 检查收敛
    for (let c = 0; c < effectiveK; c++) {
      const sim = cosineSimilarity(newCentroids[c], centroids[c]);
      if (sim < 0.999) { changed = true; break; }
    }
    centroids = newCentroids;
    if (!changed) break;
  }

  return { centroids, clusters, entryCount: entries.length };
}

// ── JSON 向量存储 ──
export class JsonVectorStore {
  private filePath: string;
  private entries: MemoryEntry[] = [];
  private dirty = false;

  /** IVF 索引，null = 未构建或需要重建 */
  private ivf: IvfIndex | null = null;
  /** 搜索次数计数，达到阈值时惰性重建索引 */
  private searchCount = 0;

  constructor(dbPath: string) {
    this.filePath = path.join(dbPath, "memory-store.json");
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, "utf8");
        this.entries = JSON.parse(raw) as MemoryEntry[];
      }
    } catch (err) {
      console.warn("[RAG] failed to load vector store:", err);
      this.entries = [];
    }
  }

  private save(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.entries, null, 2), "utf8");
      this.dirty = false;
    } catch (err) {
      console.warn("[RAG] failed to save vector store:", err);
    }
  }

  // ── IVF 索引管理 ──

  /** 强制重建 IVF 索引 */
  rebuildIndex(): void {
    const n = this.entries.length;
    if (n < 2) {
      this.ivf = null;
      return;
    }
    // K ≈ sqrt(n)/2，上限 512，下限 2
    const K = Math.max(2, Math.min(512, Math.round(Math.sqrt(n) / 2)));
    const t0 = Date.now();
    this.ivf = buildIvfIndex(this.entries, K);
    console.log(`[RAG] IVF index rebuilt: K=${K}, entries=${n}, took ${Date.now() - t0}ms`);
  }

  /** 检查是否需重建索引，每次数据库变化后调用 */
  private markIndexDirty(): void {
    this.ivf = null;
  }

  /** 搜索前确保索引可用（惰性重建） */
  private ensureIndex(): void {
    if (this.ivf) return;
    if (this.entries.length >= 2) {
      this.rebuildIndex();
    }
  }

  // ── CRUD ──

  // 添加记忆（自动去重）
  async add(
    text: string,
    source: string,
    provider: EmbeddingProvider,
    metadata?: Record<string, unknown>,
    opts?: { createdAt?: number }
  ): Promise<MemoryEntry> {
    // 去重检查（纯余弦：权重/衰减只影响召回排序，不参与判同——
    // 否则权重膨胀后任意新文本都会"命中"，静默吞掉写入）
    const existing = await this.search(text, source, provider, 1, 0.95, { rawScore: true });
    if (existing.length > 0) {
      // 更新权重和时间
      existing[0].entry.weight = Math.min(existing[0].entry.weight + 0.1, 5.0);
      existing[0].entry.lastRecalledAt = Date.now();
      this.dirty = true;
      this.save();
      return existing[0].entry;
    }

    const embedding = await provider.embed(text);
    const entry: MemoryEntry = {
      id: `${source}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      text,
      embedding,
      source,
      weight: 1.0,
      createdAt: opts?.createdAt ?? Date.now(),
      lastRecalledAt: Date.now(),
      metadata,
    };

    this.entries.push(entry);
    this.dirty = true;
    this.markIndexDirty();
    this.save();
    return entry;
  }

  async addUnique(
    text: string,
    source: string,
    provider: EmbeddingProvider,
    metadata?: Record<string, unknown>,
    opts?: { createdAt?: number },
  ): Promise<MemoryEntry> {
    const embedding = await provider.embed(text);
    return this.addPreparedBatch([{ text, source, embedding, metadata, createdAt: opts?.createdAt }])[0];
  }

  /** chat_history 专用写入：仅规范化文本完全相同时合并，并保留每次出现的位置。 */
  async addChatHistory(
    text: string,
    provider: EmbeddingProvider,
    occurrence: ChatHistoryOccurrence,
    opts?: { createdAt?: number },
  ): Promise<MemoryEntry> {
    const normalized = normalizeChatHistoryText(text);
    let existing = this.entries.find((entry) => (
      entry.source === "chat_history" && normalizeChatHistoryText(entry.text) === normalized
    ));
    if (!existing) {
      const embedding = await provider.embed(text);
      // The embed call yields. A live turn and startup backfill can therefore both
      // observe a missing exact-text entry. Re-check before inserting so they share
      // one vector and keep their positions as separate occurrences.
      existing = this.entries.find((entry) => (
        entry.source === "chat_history" && normalizeChatHistoryText(entry.text) === normalized
      ));
      if (!existing) {
        return this.addPreparedBatch([{
          text,
          source: "chat_history",
          embedding,
          metadata: metadataWithOccurrences(undefined, [occurrence]),
          createdAt: opts?.createdAt,
        }])[0];
      }
    }

    const occurrences = occurrencesFromEntry(existing);
    const matchedIndex = occurrences.findIndex((item) => sameOccurrence(item, occurrence));
    if (matchedIndex >= 0) {
      // 惰性迁移：回填遇到旧 metadata.turnId/无 turnId 条目时，用信息更完整的新 occurrence 替换。
      occurrences[matchedIndex] = occurrence.turnId ? occurrence : occurrences[matchedIndex];
    } else {
      occurrences.push(occurrence);
      existing.weight = Math.min(existing.weight + 0.1, 5.0);
    }
    existing.lastRecalledAt = Date.now();
    existing.metadata = metadataWithOccurrences(existing.metadata, occurrences);
    this.dirty = true;
    this.save();
    return existing;
  }

  // 批量添加（用于导入文档 chunk）
  async addBatch(
    items: Array<{ text: string; source: string; metadata?: Record<string, unknown> }>,
    provider: EmbeddingProvider,
    options?: { isCancelled?: () => boolean },
  ): Promise<MemoryEntry[]> {
    const results: MemoryEntry[] = [];
    const batchSize = 16;
    for (let start = 0; start < items.length; start += batchSize) {
      if (options?.isCancelled?.()) throw new Error("cancelled");
      const batch = items.slice(start, start + batchSize);
      const embeddings = await provider.embedBatch(batch.map((item) => item.text));
      if (options?.isCancelled?.()) throw new Error("cancelled");
      results.push(...this.addPreparedBatch(batch.map((item, index) => ({ ...item, embedding: embeddings[index] }))));
    }
    return results;
  }

  addPreparedBatch(
    items: Array<{ text: string; source: string; embedding: number[]; metadata?: Record<string, unknown>; createdAt?: number }>,
  ): MemoryEntry[] {
    const results: MemoryEntry[] = [];

    for (let i = 0; i < items.length; i++) {
      const entry: MemoryEntry = {
        id: `${items[i].source}_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 6)}`,
        text: items[i].text,
        embedding: items[i].embedding,
        source: items[i].source,
        weight: 1.0,
        createdAt: items[i].createdAt ?? Date.now(),
        lastRecalledAt: Date.now(),
        metadata: items[i].metadata,
      };
      this.entries.push(entry);
      results.push(entry);
    }

    this.dirty = true;
    this.markIndexDirty();
    this.save();
    return results;
  }

  // 搜索（使用 IVF 索引加速）
  async search(
    query: string,
    source?: string,
    provider?: EmbeddingProvider,
    topK = 5,
    minScore = 0.3,
    options: VectorSearchOptions = {},
  ): Promise<SearchResult[]> {
    if (this.entries.length === 0) return [];

    const embeddingProvider = provider ?? getEmbeddingProvider();
    if (!embeddingProvider) return [];

    const queryEmbedding = await embeddingProvider.embed(query);

    // 确保索引已构建
    this.ensureIndex();

    const now = Date.now();
    const results: SearchResult[] = [];
    const allowedImportIds = new Set(options.importIds ?? []);
    const allowedEntryIds = options.allowedEntryIds ? new Set(options.allowedEntryIds) : null;
    const shouldKeep = (entry: MemoryEntry) =>
      (!allowedImportIds.size || allowedImportIds.has(String(entry.metadata?.importId ?? ""))) &&
      (!allowedEntryIds || allowedEntryIds.has(entry.id));

    if (this.ivf && !source) {
      // ── IVF 加速路径（无 source 过滤时） ──
      const K = this.ivf.centroids.length;
      // nprobe：搜索约 1/8 的簇（至少 2 个）
      const nprobe = Math.max(2, Math.round(K / 8));

      // 找最近的 nprobe 个簇
      const clusterDists: Array<{ idx: number; dist: number }> = [];
      for (let c = 0; c < K; c++) {
        const sim = cosineSimilarity(queryEmbedding, this.ivf.centroids[c]);
        clusterDists.push({ idx: c, dist: 1 - sim });
      }
      clusterDists.sort((a, b) => a.dist - b.dist);
      const probeClusters = new Set(clusterDists.slice(0, nprobe).map((c) => c.idx));

      // 只在选中簇内搜索
      for (const clusterIdx of probeClusters) {
        for (const entryIdx of this.ivf.clusters[clusterIdx]) {
          const entry = this.entries[entryIdx];
          if (!shouldKeep(entry)) continue;
          const sim = cosineSimilarity(queryEmbedding, entry.embedding);
          const hoursSinceRecall = (now - entry.lastRecalledAt) / (1000 * 60 * 60);
          const decayFactor = Math.pow(0.95, hoursSinceRecall / 24);
          const weightedScore = options.rawScore ? sim : sim * entry.weight * decayFactor;

          if (weightedScore >= minScore) {
            results.push({ entry, score: weightedScore });
          }
        }
      }
    } else {
      // ── 全量搜索路径（有 source 过滤时，或索引未就绪） ──
      for (const entry of this.entries) {
        if (source && entry.source !== source) continue;
        if (!shouldKeep(entry)) continue;

        const sim = cosineSimilarity(queryEmbedding, entry.embedding);
        // 时间衰减：24h 未提及权重 ×0.95
        const hoursSinceRecall = (now - entry.lastRecalledAt) / (1000 * 60 * 60);
        const decayFactor = Math.pow(0.95, hoursSinceRecall / 24);
        const weightedScore = options.rawScore ? sim : sim * entry.weight * decayFactor;

        if (weightedScore >= minScore) {
          results.push({ entry, score: weightedScore });
        }
      }
    }

    // 排序并取 topK
    results.sort((a, b) => b.score - a.score);
    const top = results.slice(0, topK);

    // 更新召回时间（仅对 topK 结果）
    for (const r of top) {
      r.entry.lastRecalledAt = now;
      r.entry.weight = Math.min(r.entry.weight + 0.05, 5.0);
    }
    if (top.length > 0) {
      this.dirty = true;
      this.save();
    }

    return top;
  }

  // 清理低权重记忆
  prune(minWeight = 0.1): number {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.weight >= minWeight);
    this.dirty = true;
    this.markIndexDirty();
    this.save();
    return before - this.entries.length;
  }

  deleteEntriesByIds(ids: string[], source?: string): number {
    const idSet = new Set(ids);
    if (idSet.size === 0) return 0;
    const before = this.entries.length;
    this.entries = this.entries.filter((entry) => !idSet.has(entry.id) || (source !== undefined && entry.source !== source));
    const deleted = before - this.entries.length;
    if (deleted > 0) {
      this.dirty = true;
      this.markIndexDirty();
      this.save();
    }
    return deleted;
  }

  /** 删除指定聊天轮次的 occurrence；只有最后一次出现也被删除时才移除向量。 */
  deleteChatHistoryOccurrencesByTurnIds(turnIds: string[]): number {
    const ids = new Set(turnIds.filter(Boolean));
    if (ids.size === 0) return 0;
    let removedOccurrences = 0;
    let deletedEntry = false;
    const nextEntries: MemoryEntry[] = [];

    for (const entry of this.entries) {
      if (entry.source !== "chat_history") {
        nextEntries.push(entry);
        continue;
      }
      const occurrences = occurrencesFromEntry(entry);
      const kept = occurrences.filter((item) => !item.turnId || !ids.has(item.turnId));
      const removed = occurrences.length - kept.length;
      if (removed === 0) {
        nextEntries.push(entry);
        continue;
      }
      removedOccurrences += removed;
      if (kept.length === 0) {
        deletedEntry = true;
        continue;
      }
      entry.metadata = metadataWithOccurrences(entry.metadata, kept);
      nextEntries.push(entry);
    }

    if (removedOccurrences > 0) {
      this.entries = nextEntries;
      this.dirty = true;
      if (deletedEntry) this.markIndexDirty();
      this.save();
    }
    return removedOccurrences;
  }

  /** Remove every chat-history occurrence owned by a deleted chat session. */
  deleteChatHistoryOccurrencesBySessionId(sessionId: string): number {
    if (!sessionId) return 0;
    let removedOccurrences = 0;
    let deletedEntry = false;
    const nextEntries: MemoryEntry[] = [];

    for (const entry of this.entries) {
      if (entry.source !== "chat_history") {
        nextEntries.push(entry);
        continue;
      }
      const occurrences = occurrencesFromEntry(entry);
      const kept = occurrences.filter((item) => item.sessionId !== sessionId);
      const removed = occurrences.length - kept.length;
      if (removed === 0) {
        nextEntries.push(entry);
        continue;
      }
      removedOccurrences += removed;
      if (kept.length === 0) {
        deletedEntry = true;
        continue;
      }
      entry.metadata = metadataWithOccurrences(entry.metadata, kept);
      nextEntries.push(entry);
    }

    if (removedOccurrences > 0) {
      this.entries = nextEntries;
      this.dirty = true;
      if (deletedEntry) this.markIndexDirty();
      this.save();
    }
    return removedOccurrences;
  }

  // 删除导入文档
  deleteImportedDoc(importId: string, fileName?: string): number {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => {
      if (e.source !== "imported_doc") return true;
      // 新数据：按 importId 精确匹配
      if (e.metadata?.importId) {
        return e.metadata.importId !== importId;
      }
      // 旧数据：按 fileName 匹配
      if (fileName && e.metadata?.fileName === fileName) {
        return false;
      }
      return true;
    });
    const deleted = before - this.entries.length;
    if (deleted > 0) {
      this.dirty = true;
      this.markIndexDirty();
      this.save();
    }
    return deleted;
  }

  hasImportedDocumentChunks(importId: string): boolean {
    return this.entries.some(
      (entry) => entry.source === "imported_doc" && String(entry.metadata?.importId ?? "") === importId,
    );
  }

  // 统计
  get stats() {
    const sources: Record<string, number> = {};
    for (const e of this.entries) {
      sources[e.source] = (sources[e.source] || 0) + 1;
    }
    return { total: this.entries.length, sources };
  }
}
