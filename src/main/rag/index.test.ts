import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { EmbeddingProvider } from "./embedding";

const provider: EmbeddingProvider = {
  name: "deterministic",
  dims: 2,
  cacheIdentity: { provider: "local", model: "bge-m3", dimensions: 2 },
  async embed(text: string): Promise<number[]> {
    return text.includes("paragraph") ? [0, 1] : [1, 0];
  },
  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((text) => this.embed(text)));
  },
};

const { userDataDir, appPath } = vi.hoisted(() => ({ userDataDir: { value: "" }, appPath: { value: "" } }));
const rerankerState = vi.hoisted(() => ({ current: null as null | { name: string; rerank: (query: string, documents: string[]) => Promise<Array<{ text: string; score: number }>> } }));

vi.mock("electron", () => ({
  app: {
    getPath: () => userDataDir.value,
    getAppPath: () => appPath.value,
  },
}));

vi.mock("./embedding", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./embedding")>()),
  getEmbeddingProvider: () => provider,
}));

vi.mock("./reranker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./reranker")>()),
  ensureRerankerInitialized: async () => rerankerState.current,
  getReranker: () => rerankerState.current,
}));

import {
  addL2MemoryVector,
  addMemory,
  deleteUserMemoryVectors,
  getEntriesBySource,
  hasImportedDocumentChunks,
  importDocumentForTurn,
  initRAG,
  isUserMemoryVectorStoreReady,
  resetRAG,
  searchMemoryEntries,
  searchImportedDocumentChunks,
  searchImportedDocumentChunksForImportIds,
} from "./index";

let tmpDir = "";

beforeEach(async () => {
  rerankerState.current = null;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rag-index-test-"));
  userDataDir.value = tmpDir;
  appPath.value = tmpDir;
  await initRAG();
});

afterEach(() => {
  resetRAG();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("turn document imports", () => {
  it("reports that user memory vectors are writable after RAG initialization", () => {
    expect(isUserMemoryVectorStoreReady()).toBe(true);
  });

  it("returns an importId and chunk count for a turn document import", async () => {
    const result = await importDocumentForTurn("one paragraph\n\ntwo paragraph", "turn-doc.md");

    expect(result.importId).toMatch(/^import-/);
    expect(result.chunkCount).toBeGreaterThan(0);

    const chunks = await searchImportedDocumentChunksForImportIds("paragraph", [result.importId], 3);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((chunk) => chunk.importId === result.importId)).toBe(true);
  });

  it("automatically injects only document chunks that pass the local relevance gate", async () => {
    await importDocumentForTurn("one paragraph\n\ntwo paragraph", "turn-doc.md");

    const relevant = await searchImportedDocumentChunks("paragraph", 2, { automaticInjection: true });
    const unrelated = await searchImportedDocumentChunks("totally unrelated", 2, { automaticInjection: true });

    expect(relevant.length).toBeGreaterThan(0);
    expect(relevant.every((chunk) => chunk.fileName === "turn-doc.md")).toBe(true);
    expect(unrelated).toEqual([]);
  });

  it("does not advance document vector recall state during retrieval", async () => {
    await importDocumentForTurn("one paragraph\n\ntwo paragraph", "turn-doc.md");
    const before = getEntriesBySource("imported_doc").map(({ id, weight, lastRecalledAt }) => ({ id, weight, lastRecalledAt }));

    await searchImportedDocumentChunks("paragraph", 2, { automaticInjection: true });

    expect(getEntriesBySource("imported_doc").map(({ id, weight, lastRecalledAt }) => ({ id, weight, lastRecalledAt })))
      .toEqual(before);
  });

  it("reranks document candidates once after hybrid retrieval and applies the local automatic gate", async () => {
    await importDocumentForTurn("paragraph alpha", "alpha.md");
    await importDocumentForTurn("paragraph beta", "beta.md");
    const rerank = vi.fn(async (_query: string, documents: string[]) => documents
      .map((text) => ({ text, score: text.includes("beta") ? 2 : -1 }))
      .sort((left, right) => right.score - left.score));
    rerankerState.current = { name: "test", rerank };

    const results = await searchImportedDocumentChunks("paragraph", 2, { automaticInjection: true });

    expect(rerank).toHaveBeenCalledTimes(1);
    expect(results.map((result) => result.fileName)).toEqual(["beta.md"]);
  });

  it("reports whether an importId still has stored document chunks", async () => {
    expect(hasImportedDocumentChunks("import-missing")).toBe(false);

    const result = await importDocumentForTurn("one paragraph", "turn-doc.md");

    expect(hasImportedDocumentChunks(result.importId)).toBe(true);
  });
});

describe("user memory retrieval", () => {
  it("creates a distinct vector for every L2 even when contents are identical", async () => {
    const firstId = await addL2MemoryVector("用户喜欢香菇", "l2_first", { source: "test" });
    const secondId = await addL2MemoryVector("用户喜欢香菇", "l2_second", { source: "test" });

    expect(secondId).not.toBe(firstId);
    expect(getEntriesBySource("user_memory").map((entry) => ({ id: entry.id, l2Id: entry.metadata?.l2Id })))
      .toEqual([
        { id: firstId, l2Id: "l2_first" },
        { id: secondId, l2Id: "l2_second" },
      ]);
  });

  it("deletes only the requested user memory vectors", async () => {
    const firstId = await addL2MemoryVector("第一条", "l2_first");
    const secondId = await addL2MemoryVector("第二条", "l2_second");

    expect(deleteUserMemoryVectors([firstId])).toBe(1);
    expect(getEntriesBySource("user_memory").map((entry) => entry.id)).toEqual([secondId]);
  });

  it("returns only consistently mapped, recallable L2 vectors", async () => {
    const { memoryStore } = await import("../memory/memory-store");
    const active = await memoryStore.addL2Memory({
      content: "alpha active memory",
      triggerText: "active",
      sourceConversationId: "test",
      isPinned: false,
      syncStatus: "pending_sync",
    });
    const activeRagId = await addMemory(active.content, "user_memory", { l2Id: active.id });
    await memoryStore.markL2SyncStatus(active.id, "synced", activeRagId);

    const archived = await memoryStore.addL2Memory({
      content: "paragraph archived memory",
      triggerText: "archived",
      sourceConversationId: "test",
      isPinned: false,
      syncStatus: "pending_sync",
    });
    const archivedRagId = await addMemory(archived.content, "user_memory", { l2Id: archived.id });
    await memoryStore.markL2SyncStatus(archived.id, "synced", archivedRagId);
    await memoryStore.updateL2Status([archived.id], "archived");

    const results = await searchMemoryEntries("memory", "user_memory", 5);

    expect(results.map((entry) => entry.id)).toEqual([activeRagId]);
    expect(results.some((entry) => entry.id === archivedRagId)).toBe(false);
  });
});
