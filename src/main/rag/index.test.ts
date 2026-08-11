import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { EmbeddingProvider } from "./embedding";

const provider: EmbeddingProvider = {
  name: "deterministic",
  dims: 2,
  async embed(text: string): Promise<number[]> {
    return text.includes("paragraph") || text.includes("lexical-distractor") ? [0, 1] : [1, 0];
  },
  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((text) => this.embed(text)));
  },
};

const { userDataDir, appPath } = vi.hoisted(() => ({ userDataDir: { value: "" }, appPath: { value: "" } }));
const rerankerMock = vi.hoisted(() => ({
  current: null as null | { rerank: ReturnType<typeof vi.fn> },
  ensureInitialized: vi.fn(),
}));

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
  getReranker: () => rerankerMock.current,
  ensureRerankerInitialized: rerankerMock.ensureInitialized,
}));

import {
  addHistoryMemory,
  addL2MemoryVector,
  addMemory,
  deleteHistoryEntriesByTurnIds,
  deleteHistoryEntriesBySessionId,
  deleteUserMemoryVectors,
  flushVectorStoreSync,
  getEntriesBySource,
  hasImportedDocumentChunks,
  importDocumentForTurn,
  initRAG,
  isUserMemoryVectorStoreReady,
  resetRAG,
  searchHistoryEntries,
  searchMemoryEntries,
  searchImportedDocumentChunksForImportIds,
} from "./index";

let tmpDir = "";

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rag-index-test-"));
  userDataDir.value = tmpDir;
  appPath.value = tmpDir;
  rerankerMock.current = null;
  rerankerMock.ensureInitialized.mockReset();
  rerankerMock.ensureInitialized.mockImplementation(async () => rerankerMock.current);
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

  it("reports whether an importId still has stored document chunks", async () => {
    expect(hasImportedDocumentChunks("import-missing")).toBe(false);

    const result = await importDocumentForTurn("one paragraph", "turn-doc.md");

    expect(hasImportedDocumentChunks(result.importId)).toBe(true);
  });
});

describe("user memory retrieval", () => {
  async function rewriteVectorState(
    patches: Array<{ id: string; lastRecalledAt?: number; weight?: number }>,
  ): Promise<void> {
    flushVectorStoreSync();
    const storeFile = path.join(tmpDir, "rag-data", "memory-store.json");
    const persisted = JSON.parse(fs.readFileSync(storeFile, "utf8")) as Array<{
      id: string;
      lastRecalledAt: number;
      weight: number;
    }>;
    const patchById = new Map(patches.map((patch) => [patch.id, patch]));
    for (const entry of persisted) {
      const patch = patchById.get(entry.id);
      if (patch) Object.assign(entry, patch);
    }
    fs.writeFileSync(storeFile, JSON.stringify(persisted), "utf8");
    resetRAG();
    await initRAG();
  }

  async function addRecallableL2(input: {
    content: string;
    triggerText: string;
    createdAt?: number;
    status?: "active" | "aging";
  }) {
    const { memoryStore } = await import("../memory/memory-store");
    const memory = await memoryStore.addL2Memory({
      content: input.content,
      triggerText: input.triggerText,
      sourceConversationId: "test",
      isPinned: false,
      syncStatus: "pending_sync",
    }, input.createdAt === undefined ? undefined : { createdAt: input.createdAt });
    const ragId = await addL2MemoryVector(memory.content, memory.id, {
      triggerText: memory.triggerText,
    }, input.createdAt === undefined ? undefined : { createdAt: input.createdAt });
    await memoryStore.markL2SyncStatus(memory.id, "synced", ragId);
    if (input.status === "aging") await memoryStore.updateL2Status([memory.id], "aging");
    return { memory, ragId };
  }

  it("lazily initializes the configured reranker before the first user-memory ranking", async () => {
    await addRecallableL2({ content: "alpha durable memory", triggerText: "alpha trigger" });
    const rerank = vi.fn(async (_query: string, documents: string[]) =>
      documents.map((text) => ({ text, score: 1 }))
    );
    rerankerMock.ensureInitialized.mockImplementationOnce(async () => {
      rerankerMock.current = { rerank };
      return rerankerMock.current;
    });

    await searchMemoryEntries("alpha", "user_memory", 5, { recordRecall: false });

    expect(rerankerMock.ensureInitialized).toHaveBeenCalledTimes(1);
    expect(rerank).toHaveBeenCalledTimes(1);
  });

  it("does not initialize the reranker for history retrieval", async () => {
    await addHistoryMemory("alpha history", {
      sessionId: "session-a", role: "user", ts: Date.now(), turnId: "turn-a",
    });

    await searchHistoryEntries("alpha", 5, { recordRecall: false });

    expect(rerankerMock.ensureInitialized).not.toHaveBeenCalled();
  });

  it("keeps hybrid user-memory results when lazy reranker initialization fails", async () => {
    const target = await addRecallableL2({ content: "alpha durable memory", triggerText: "alpha trigger" });
    rerankerMock.ensureInitialized.mockRejectedValueOnce(new Error("model load failed"));

    const results = await searchMemoryEntries("alpha", "user_memory", 5, { recordRecall: false });

    expect(results.map((entry) => entry.id)).toContain(target.ragId);
  });

  it("recalls a 90-day-old memory through a synonymous semantic query", async () => {
    const old = await addRecallableL2({
      content: "durable old preference",
      triggerText: "original wording",
      createdAt: Date.now() - 90 * 24 * 60 * 60 * 1000,
      status: "aging",
    });
    for (let index = 0; index < 20; index += 1) {
      await addRecallableL2({
        content: `synonymous reformulation lexical-distractor ${index}`,
        triggerText: `recent trigger ${index}`,
      });
    }
    await rewriteVectorState([{ id: old.ragId, lastRecalledAt: old.memory.createdAt }]);

    const results = await searchMemoryEntries("synonymous reformulation", "user_memory", 5, { recordRecall: false });

    expect(results.map((entry) => entry.id)).toContain(old.ragId);
  });

  it("finds a summary through triggerText without returning triggerText as the memory body", async () => {
    for (let index = 0; index < 20; index += 1) {
      await addRecallableL2({
        content: `paragraph unrelated distractor ${index}`,
        triggerText: `other trigger ${index}`,
      });
    }
    const target = await addRecallableL2({
      content: "用户偏好清淡饮食",
      triggerText: "paragraph deadline phrase",
    });
    const rerank = vi.fn(async (_query: string, documents: string[]) => documents
      .map((text) => ({ text, score: text.includes("deadline phrase") ? 100 : 1 }))
      .sort((a, b) => b.score - a.score));
    rerankerMock.current = { rerank };

    const results = await searchMemoryEntries("paragraph deadline", "user_memory", 5, { recordRecall: false });

    expect(rerank.mock.calls[0]?.[1]).toContain("用户偏好清淡饮食\nparagraph deadline phrase");
    expect(results[0]).toMatchObject({ id: target.ragId, text: "用户偏好清淡饮食" });
    expect(results[0]?.text).not.toContain("paragraph deadline phrase");
  });

  it("reranks an expanded candidate set and still returns only the top five", async () => {
    const memories = [];
    for (let index = 0; index < 21; index += 1) {
      memories.push(await addRecallableL2({
        content: index === 19 ? "alpha highly relevant old memory" : `alpha lexical-distractor weak recent memory ${index}`,
        triggerText: `trigger ${index}`,
        createdAt: index === 19 ? Date.now() - 90 * 24 * 60 * 60 * 1000 : undefined,
        status: index === 19 ? "aging" : "active",
      }));
    }
    await rewriteVectorState(memories.map(({ memory, ragId }) => ({
      id: ragId,
      weight: memory.content.includes("weak recent") ? 5 : 1,
      lastRecalledAt: memory.createdAt,
    })));
    const rerank = vi.fn(async (_query: string, documents: string[]) => documents
      .map((text) => ({ text, score: text.includes("highly relevant old") ? 100 : 1 }))
      .sort((a, b) => b.score - a.score));
    rerankerMock.current = { rerank };

    const results = await searchMemoryEntries("alpha memory", "user_memory", 5, { recordRecall: false });

    expect(rerank).toHaveBeenCalledTimes(1);
    expect(rerank.mock.calls[0][1]).toHaveLength(20);
    expect(results).toHaveLength(5);
    expect(results[0]?.text).toBe("alpha highly relevant old memory");
  });

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

describe("chat history occurrences", () => {
  it("supports read-only retrieval without changing recall metadata", async () => {
    const id = await addHistoryMemory("read only history", {
      sessionId: "session-a", role: "user", ts: 100, turnId: "turn-1",
    });
    flushVectorStoreSync(); // 存盘现为防抖异步；读文件断言前先 flush
    const storeFile = path.join(tmpDir, "rag-data", "memory-store.json");
    const before = fs.readFileSync(storeFile, "utf8");

    await searchHistoryEntries("read only history", 5, { recordRecall: false });

    expect(getEntriesBySource("chat_history").some((entry) => entry.id === id)).toBe(true);
    expect(fs.readFileSync(storeFile, "utf8")).toBe(before);
  });

  it("filters old history before Top-K while retaining a recently repeated occurrence", async () => {
    const now = Date.now();
    await addHistoryMemory("old only paragraph", {
      sessionId: "session-a", role: "user", ts: 100, turnId: "old-turn",
    }, { createdAt: 100 });
    await addHistoryMemory("repeated paragraph", {
      sessionId: "session-a", role: "user", ts: 200, turnId: "first-repeat",
    }, { createdAt: 200 });
    await addHistoryMemory("repeated paragraph", {
      sessionId: "session-a", role: "user", ts: now, turnId: "recent-repeat",
    }, { createdAt: now });

    const results = await searchHistoryEntries("paragraph", 5, {
      recordRecall: false,
      createdAfter: now - 1_000,
    });

    expect(results.map((entry) => entry.text)).toEqual(["repeated paragraph"]);
    expect(results[0]?.createdAt).toBe(now);
  });

  it("merges only normalized exact text and records every occurrence", async () => {
    const firstId = await addHistoryMemory("早安\r\n", {
      sessionId: "session-a", role: "user", ts: 100, turnId: "turn-1",
    });
    const secondId = await addHistoryMemory("早安\n", {
      sessionId: "session-b", role: "assistant", ts: 200, turnId: "turn-2",
    });
    const differentId = await addHistoryMemory("早安！", {
      sessionId: "session-a", role: "user", ts: 300, turnId: "turn-3",
    });

    expect(secondId).toBe(firstId);
    expect(differentId).not.toBe(firstId);
    const merged = getEntriesBySource("chat_history").find((entry) => entry.id === firstId);
    expect(merged?.metadata?.occurrences).toEqual([
      { sessionId: "session-a", role: "user", ts: 100, turnId: "turn-1" },
      { sessionId: "session-b", role: "assistant", ts: 200, turnId: "turn-2" },
    ]);
  });

  it("removes one occurrence without deleting the shared vector", async () => {
    const id = await addHistoryMemory("重复文本", {
      sessionId: "session-a", role: "user", ts: 100, turnId: "turn-1",
    });
    await addHistoryMemory("重复文本", {
      sessionId: "session-a", role: "user", ts: 200, turnId: "turn-2",
    });

    expect(deleteHistoryEntriesByTurnIds(["turn-1"])).toBe(1);
    expect(getEntriesBySource("chat_history").find((entry) => entry.id === id)?.metadata?.occurrences)
      .toEqual([{ sessionId: "session-a", role: "user", ts: 200, turnId: "turn-2" }]);

    expect(deleteHistoryEntriesByTurnIds(["turn-2"])).toBe(1);
    expect(getEntriesBySource("chat_history").some((entry) => entry.id === id)).toBe(false);
  });

  it("uses the latest remaining occurrence for recalled role and time", async () => {
    await addHistoryMemory("重复问候", {
      sessionId: "session-a", role: "user", ts: 100, turnId: "turn-1",
    });
    await addHistoryMemory("重复问候", {
      sessionId: "session-b", role: "assistant", ts: 200, turnId: "turn-2",
    });

    const beforeDelete = await searchHistoryEntries("重复问候", 1);
    expect(beforeDelete[0]).toMatchObject({ createdAt: 200, metadata: { role: "assistant", turnId: "turn-2" } });

    deleteHistoryEntriesByTurnIds(["turn-2"]);
    const afterDelete = await searchHistoryEntries("重复问候", 1);
    expect(afterDelete[0]).toMatchObject({ createdAt: 100, metadata: { role: "user", turnId: "turn-1" } });
  });

  it("lazily upgrades legacy turnId metadata without duplicating the occurrence", async () => {
    const id = await addMemory("旧历史", "chat_history", {
      sessionId: "session-a", role: "user", ts: 100, turnId: "turn-legacy",
    }, { createdAt: 100 });

    const migratedId = await addHistoryMemory("旧历史", {
      sessionId: "session-a", role: "user", ts: 100, turnId: "turn-legacy",
    }, { createdAt: 100 });

    expect(migratedId).toBe(id);
    expect(getEntriesBySource("chat_history")[0].metadata?.occurrences)
      .toEqual([{ sessionId: "session-a", role: "user", ts: 100, turnId: "turn-legacy" }]);
    expect(getEntriesBySource("chat_history")[0].metadata?.turnId).toBeUndefined();
  });

  it("keeps distinct turn IDs even when their fallback fields are identical", async () => {
    const id = await addHistoryMemory("same timestamp", {
      sessionId: "session-a", role: "user", ts: 100, turnId: "turn-1",
    });
    await addHistoryMemory("same timestamp", {
      sessionId: "session-a", role: "user", ts: 100, turnId: "turn-2",
    });

    expect(getEntriesBySource("chat_history").find((entry) => entry.id === id)?.metadata?.occurrences)
      .toHaveLength(2);
  });

  it("does not create duplicate vectors when identical first writes overlap", async () => {
    await Promise.all([
      addHistoryMemory("concurrent text", {
        sessionId: "session-a", role: "user", ts: 100, turnId: "turn-1",
      }),
      addHistoryMemory("concurrent text", {
        sessionId: "session-a", role: "assistant", ts: 101, turnId: "turn-2",
      }),
    ]);

    const entries = getEntriesBySource("chat_history").filter((entry) => entry.text === "concurrent text");
    expect(entries).toHaveLength(1);
    expect(entries[0].metadata?.occurrences).toHaveLength(2);
  });

  it("removes only the deleted session's shared occurrences", async () => {
    const id = await addHistoryMemory("shared text", {
      sessionId: "session-a", role: "user", ts: 100, turnId: "turn-1",
    });
    await addHistoryMemory("shared text", {
      sessionId: "session-b", role: "user", ts: 200, turnId: "turn-2",
    });

    expect(deleteHistoryEntriesBySessionId("session-a")).toBe(1);
    expect(getEntriesBySource("chat_history").find((entry) => entry.id === id)?.metadata?.occurrences)
      .toEqual([{ sessionId: "session-b", role: "user", ts: 200, turnId: "turn-2" }]);
    expect(deleteHistoryEntriesBySessionId("session-b")).toBe(1);
    expect(getEntriesBySource("chat_history").some((entry) => entry.id === id)).toBe(false);
  });
});
