# Document RAG Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make document attachment handling accurate and responsive by waiting for large-document indexing, caching completed indexes, and moving expensive work into a background queue.

**Architecture:** Keep the chat UI immediate: user messages and attachment cards render before document work finishes. Keep model answers honest: large documents gate the LLM until indexing/retrieval completes, while transient wait UI uses fixed local copy and never spends tokens. Keep RAG changes narrow: use existing metadata for `importId` filtering, add a cache beside existing `rag-data`, then add a single FIFO worker queue for expensive document indexing.

**Tech Stack:** Electron main/preload/renderer, TypeScript, Vitest, existing RAG vector store/retriever, existing chat attachment and transient status UI.

## Global Constraints

- Produce exactly three implementation commits:
  - `fix(chat): wait for document indexing before reply`
  - `perf(rag): cache document embedding results`
  - `perf(rag): index documents in a background worker queue`
- Do not push.
- Do not touch image direct-send behavior, sticker matching, WeChat media, cache branches outside document indexing, or a broad unified attachment rewrite.
- Do not use a first-8KB preview fallback for large documents.
- For large documents, do not call the LLM until document processing reaches a terminal state.
- If document processing fails, still call the model with the original user text and explicit failure context:
  `用户发送了文档 <filename>，但文档处理失败：<reason>。请诚实说明暂时无法分析该文档，不要编造文档内容。`
- Accumulate document and image context into one `modelContextParts` array before assigning `userMsg.modelContext`; never overwrite image context with document context or the reverse.
- Each task must run relevant tests, full `npm test`, `npm run build`, `git diff --stat`, and `git diff`, then wait for user confirmation before local commit.

---

## File Structure

- `src/main/rag/index.ts`: expose turn-specific import/retrieval helpers while preserving existing `importDocument(text, fileName): Promise<number>` compatibility.
- `src/main/rag/retriever.ts`: add optional `importIds` filtering to retrieval without changing stored entry shape.
- `src/main/rag/vectorstore.ts`: apply source and `importId` metadata filters during vector search.
- `src/main/rag/file-ingest.ts`: carry `importId`, `chunkCount`, and processing status from main back to renderer for documents.
- `src/main/index.ts`: keep `CHAT_PROCESS_DOCUMENTS`, then later route it through cache and worker queue without changing renderer call shape more than needed.
- `src/preload/index.ts`: only change if the IPC payload needs progress/cancel listeners in G3.
- `src/renderer/chat/main.ts`: render immediate document cards, show transient status, insert/remove a non-persisted fixed wait assistant message, combine document and image `modelContext`.
- `src/renderer/chat/types.ts`: add only small optional fields needed by G1/G3, such as transient assistant marker or document progress fields.
- `src/renderer/chat/storage.ts` or the current chat persistence module: filter transient wait messages from history if persistence is centralized there.
- `src/main/rag/document-cache.ts`: new G2 cache module for content-addressed completed document indexes.
- `src/main/rag/document-cache.test.ts`: new G2 cache tests.
- `src/main/rag/document-index-worker.ts`: new G3 worker entry that reads/chunks/embeds and reports progress.
- `src/main/rag/document-index-queue.ts`: new G3 main-process FIFO queue and cancellation coordinator.
- `src/main/rag/document-index-queue.test.ts`: new G3 queue tests.

---

### Task 1: G1 Accurate Wait Flow

**Commit:** `fix(chat): wait for document indexing before reply`

**Files:**
- Modify: `src/main/rag/index.ts`
- Modify: `src/main/rag/retriever.ts`
- Modify: `src/main/rag/vectorstore.ts`
- Modify: `src/main/rag/file-ingest.ts`
- Modify: `src/main/index.ts`
- Modify: `src/renderer/chat/main.ts`
- Modify: `src/renderer/chat/types.ts`
- Test: `src/main/rag/retriever.test.ts` or the existing retriever/vector store test file
- Test: `src/main/rag/file-ingest.test.ts`
- Test: `src/renderer/chat/main.test.ts` or the existing chat send-flow test file

**Interfaces:**
- Produces in `src/main/rag/index.ts`:
  ```ts
  export type ImportedDocumentResult = {
    importId: string;
    chunkCount: number;
  };

  export type ImportedDocumentChunk = {
    text: string;
    score: number;
    fileName?: string;
    chunkIndex?: number;
    importId?: string;
  };

  export async function importDocumentForTurn(
    text: string,
    fileName: string,
  ): Promise<ImportedDocumentResult>;

  export async function searchImportedDocumentChunksForImportIds(
    query: string,
    importIds: string[],
    topK?: number,
  ): Promise<ImportedDocumentChunk[]>;
  ```
- Keeps existing compatibility:
  ```ts
  export async function importDocument(text: string, fileName: string): Promise<number>;
  ```
- Produces in `src/main/rag/file-ingest.ts`:
  ```ts
  export type Attachment =
    | { kind: "text"; name: string; text: string; filePath?: string; mime?: string }
    | { kind: "indexed"; name: string; chunks: number; importId?: string; filePath?: string; mime?: string }
    | { kind: "empty"; name: string; filePath?: string; mime?: string }
    | { kind: "unsupported"; name: string; reason: string; filePath?: string; mime?: string }
    | { kind: "image"; name: string; filePath: string; mime?: string; status: "pending" }
    | { kind: "document"; name: string; filePath: string; mime?: string; status: "pending" | "done" | "error" };
  ```
- Renderer consumes `CHAT_PROCESS_DOCUMENTS` results and builds context lines with no document body in the visible bubble.

- [ ] **Step 1: Write failing importId-limited retrieval tests**

Add a test in the existing retriever/vector store test file that creates two `imported_doc` entries with different `metadata.importId` values, searches with one importId, and expects only matching chunks:

```ts
it("limits imported document retrieval to the current turn importIds", async () => {
  const provider = createDeterministicEmbeddingProvider();
  const store = createInMemoryVectorStore();
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

  expect(results.map((result) => result.text)).toEqual(["beta budget deadline is May"]);
});
```

Run: `npm test -- src/main/rag/retriever.test.ts`

Expected: FAIL because `retrieve` does not accept or apply `importIds`.

- [ ] **Step 2: Add the narrow `importIds` filter**

Update `src/main/rag/retriever.ts` so retrieval accepts options:

```ts
export type RetrieveOptions = {
  importIds?: string[];
};

export async function retrieve(
  query: string,
  source?: MemoryEntry["source"],
  topK = 5,
  options: RetrieveOptions = {},
): Promise<RetrievedMemory[]> {
  const allowedImportIds = new Set(options.importIds ?? []);
  const shouldKeep = (entry: MemoryEntry) =>
    !allowedImportIds.size || allowedImportIds.has(String(entry.metadata?.importId ?? ""));

  const vectorResults = await this.store.search(query, topK * 4, source, options);
  const bm25Results = this.bm25.search(query, topK * 4, source).filter((result) => shouldKeep(result.entry));

  return mergeAndRank(vectorResults, bm25Results, topK);
}
```

Update `src/main/rag/vectorstore.ts` search signatures to accept the same options and skip entries whose `metadata.importId` is not in the set:

```ts
export type VectorSearchOptions = {
  importIds?: string[];
};

if (options.importIds?.length) {
  const allowed = new Set(options.importIds);
  candidates = candidates.filter((entry) => allowed.has(String(entry.metadata?.importId ?? "")));
}
```

Run: `npm test -- src/main/rag/retriever.test.ts`

Expected: PASS.

- [ ] **Step 3: Write failing document import metadata test**

Add a test in `src/main/rag/index.test.ts` or the closest existing RAG facade test:

```ts
it("returns an importId and chunk count for a turn document import", async () => {
  const result = await importDocumentForTurn("one paragraph\n\ntwo paragraph", "turn-doc.md");

  expect(result.importId).toMatch(/^import-/);
  expect(result.chunkCount).toBeGreaterThan(0);

  const chunks = await searchImportedDocumentChunksForImportIds("paragraph", [result.importId], 3);
  expect(chunks.length).toBeGreaterThan(0);
  expect(chunks.every((chunk) => chunk.importId === result.importId)).toBe(true);
});
```

Run: `npm test -- src/main/rag/index.test.ts`

Expected: FAIL because `importDocumentForTurn` and `searchImportedDocumentChunksForImportIds` do not exist.

- [ ] **Step 4: Add turn import and retrieval helpers**

In `src/main/rag/index.ts`, split current `importDocument` implementation into a helper that returns metadata:

```ts
export async function importDocumentForTurn(
  text: string,
  fileName: string,
): Promise<ImportedDocumentResult> {
  const chunks = chunkDocument(text);
  const importId = `import-${Date.now()}-${crypto.randomUUID()}`;

  await store.addBatch(
    chunks.map((chunk, index) => ({
      text: chunk,
      source: "imported_doc",
      metadata: { fileName, chunkIndex: index, importId },
    })),
    embeddingProvider,
  );

  return { importId, chunkCount: chunks.length };
}

export async function importDocument(text: string, fileName: string): Promise<number> {
  const result = await importDocumentForTurn(text, fileName);
  return result.chunkCount;
}

export async function searchImportedDocumentChunksForImportIds(
  query: string,
  importIds: string[],
  topK = 6,
): Promise<ImportedDocumentChunk[]> {
  if (!query.trim() || !importIds.length) return [];
  const results = await retriever.retrieve(query, "imported_doc", topK, { importIds });
  return results.map((result) => ({
    text: result.text,
    score: result.score,
    fileName: String(result.entry.metadata?.fileName ?? ""),
    chunkIndex: Number(result.entry.metadata?.chunkIndex ?? 0),
    importId: String(result.entry.metadata?.importId ?? ""),
  }));
}
```

Run: `npm test -- src/main/rag/index.test.ts`

Expected: PASS.

- [ ] **Step 5: Write failing main document IPC result test**

Add or update the `CHAT_PROCESS_DOCUMENTS` handler test so an indexed document result includes `importId`:

```ts
it("returns importId for indexed document processing", async () => {
  const result = await processDocumentsForChat({
    filePaths: [largeMarkdownPath],
    query: "what is the deadline?",
  });

  expect(result[0]).toMatchObject({
    kind: "indexed",
    name: "large.md",
    chunks: expect.any(Number),
    importId: expect.stringMatching(/^import-/),
  });
});
```

Run: `npm test -- src/main/index.test.ts`

Expected: FAIL until the handler uses `importDocumentForTurn`.

- [ ] **Step 6: Return `importId` from document processing**

Update `src/main/index.ts` to pass `importDocumentForTurn` into document ingestion for `CHAT_PROCESS_DOCUMENTS`.

Update `src/main/rag/file-ingest.ts` so the indexed branch returns:

```ts
return {
  kind: "indexed",
  name,
  chunks: result.chunkCount,
  importId: result.importId,
  filePath,
  mime,
};
```

Run: `npm test -- src/main/rag/file-ingest.test.ts src/main/index.test.ts`

Expected: PASS.

- [ ] **Step 7: Write failing renderer wait-message tests**

Add tests for three renderer behaviors:

```ts
it("shows a deterministic assistant wait message when document processing exceeds 3500ms", async () => {
  vi.useFakeTimers();
  mockChatProcessDocuments.withPendingPromise();

  await sendComposerMessage("请总结这个文档", [pendingLargeDocument]);
  await vi.advanceTimersByTimeAsync(3500);

  expect(screen.getByText("这份文档有点大呢，我正在仔细读里面的内容……稍等我一下，等我看完重点再认真回答你～")).toBeInTheDocument();
  expect(mockAguiRun).not.toHaveBeenCalled();
});

it("removes the deterministic wait message before rendering the real assistant response", async () => {
  vi.useFakeTimers();
  const processing = mockChatProcessDocuments.withPendingPromise();

  await sendComposerMessage("请总结这个文档", [pendingLargeDocument]);
  await vi.advanceTimersByTimeAsync(3500);
  processing.resolve([{ kind: "indexed", name: "large.md", chunks: 12, importId: "import-current" }]);
  await flushPromises();

  expect(screen.queryByText("这份文档有点大呢，我正在仔细读里面的内容……稍等我一下，等我看完重点再认真回答你～")).not.toBeInTheDocument();
  expect(mockAguiRun).toHaveBeenCalledTimes(1);
});

it("combines document and image context without overwriting either one", async () => {
  mockChatProcessDocuments.resolves([{ kind: "indexed", name: "large.md", chunks: 12, importId: "import-current" }]);
  mockCaptionImage.resolves("图片里是一张流程图。");

  await sendComposerMessage("结合图片和文档说明", [pendingLargeDocument, pendingImage]);

  const modelMessages = mockAguiRun.mock.calls[0][0].messages;
  const userMessage = modelMessages.find((message) => message.role === "user");
  expect(userMessage.content).toContain("文档 large.md 已建立索引");
  expect(userMessage.content).toContain("图片里是一张流程图。");
});
```

Run: `npm test -- src/renderer/chat/main.test.ts`

Expected: FAIL because no wait assistant state exists yet.

- [ ] **Step 8: Implement wait message and context accumulation in renderer**

In `src/renderer/chat/types.ts`, add a local-only marker:

```ts
export type Message = {
  role: "user" | "assistant" | "system";
  content: string;
  thinking?: boolean;
  sticker?: StickerMessage;
  modelContext?: string;
  attachments?: MessageAttachment[];
  transient?: boolean;
};
```

In `src/renderer/chat/main.ts`, wrap document processing:

```ts
const modelContextParts: string[] = [];
let waitMessage: Message | null = null;
const waitTimer = window.setTimeout(() => {
  waitMessage = {
    role: "assistant",
    content: "这份文档有点大呢，我正在仔细读里面的内容……稍等我一下，等我看完重点再认真回答你～",
    transient: true,
  };
  messages.push(waitMessage);
  render();
}, 3500);

try {
  const documentResults = await window.chat.processDocuments(documentPaths, originalInput);
  modelContextParts.push(...buildDocumentContextLines(documentResults, originalInput));
} finally {
  window.clearTimeout(waitTimer);
  if (waitMessage) {
    messages = messages.filter((message) => message !== waitMessage);
    waitMessage = null;
    render();
  }
}

modelContextParts.push(...imageContextParts);
userMsg.modelContext = modelContextParts.join("\n\n");
```

Filter transient messages before persistence:

```ts
const persistedMessages = messages.filter((message) => !message.transient);
saveMessages(persistedMessages);
```

Run: `npm test -- src/renderer/chat/main.test.ts`

Expected: PASS.

- [ ] **Step 9: Build honest document context**

Ensure `buildDocumentContextLines` creates:

```ts
if (result.kind === "indexed") {
  lines.push(`文档 ${result.name} 已建立索引，共 ${result.chunks} 段。`);
  if (result.retrievedChunks?.length) {
    lines.push(`以下是与本轮问题相关的文档片段：\n${formatRetrievedChunks(result.retrievedChunks)}`);
  }
}

if (result.kind === "unsupported" || result.kind === "empty" || result.kind === "error") {
  lines.push(`用户发送了文档 ${result.name}，但文档处理失败：${reason}。请诚实说明暂时无法分析该文档，不要编造文档内容。`);
}
```

Run: `npm test -- src/renderer/chat/main.test.ts src/main/rag/file-ingest.test.ts`

Expected: PASS.

- [ ] **Step 10: Verify and gate commit**

Run:

```bash
npm test
npm run build
git diff --stat
git diff
```

Expected:
- Tests pass.
- Build passes.
- Diff only covers G1 files.

Stop and wait for user confirmation. After confirmation:

```bash
git add src/main/rag/index.ts src/main/rag/retriever.ts src/main/rag/vectorstore.ts src/main/rag/file-ingest.ts src/main/index.ts src/renderer/chat/main.ts src/renderer/chat/types.ts src/main/rag/*.test.ts src/renderer/chat/*.test.ts
git commit -m "fix(chat): wait for document indexing before reply"
```

---

### Task 2: G2 Persistent Document Index Cache

**Commit:** `perf(rag): cache document embedding results`

**Files:**
- Create: `src/main/rag/document-cache.ts`
- Create: `src/main/rag/document-cache.test.ts`
- Modify: `src/main/rag/file-ingest.ts`
- Modify: `src/main/index.ts`
- Modify: `src/main/rag/index.ts`
- Modify: `src/main/rag/vectorstore.ts`

**Interfaces:**
- Produces:
  ```ts
  export type DocumentCacheIdentity = {
    textSha256: string;
    embeddingProvider: string;
    embeddingModel: string;
    dimensions: number;
    chunkStrategyVersion: string;
    chunkSize: number;
    chunkOverlap: number;
  };

  export type DocumentCacheRecord = {
    key: string;
    importId: string;
    chunkCount: number;
    fileName: string;
    createdAt: string;
  };

  export async function getDocumentCacheRecord(identity: DocumentCacheIdentity): Promise<DocumentCacheRecord | null>;
  export async function putDocumentCacheRecord(record: DocumentCacheRecord): Promise<void>;
  export async function buildDocumentCacheIdentity(text: string): Promise<DocumentCacheIdentity>;
  ```
- Consumes `searchImportedDocumentChunksForImportIds(query, [importId])` from G1.

- [ ] **Step 1: Write failing cache key tests**

Create `src/main/rag/document-cache.test.ts`:

```ts
it("uses normalized text and embedding identity in the cache key", async () => {
  const first = await buildDocumentCacheIdentity("hello\r\nworld");
  const second = await buildDocumentCacheIdentity("hello\nworld");

  expect(first.textSha256).toBe(second.textSha256);
  expect(first.embeddingProvider).toBeTruthy();
  expect(first.embeddingModel).toBeTruthy();
  expect(first.chunkStrategyVersion).toBe("document-chunks-v1");
});

it("invalidates when the embedding model changes", async () => {
  const first = createDocumentCacheKey({
    textSha256: "abc",
    embeddingProvider: "local",
    embeddingModel: "Xenova/all-MiniLM-L6-v2",
    dimensions: 384,
    chunkStrategyVersion: "document-chunks-v1",
    chunkSize: 1200,
    chunkOverlap: 200,
  });
  const second = createDocumentCacheKey({
    textSha256: "abc",
    embeddingProvider: "local",
    embeddingModel: "different-model",
    dimensions: 384,
    chunkStrategyVersion: "document-chunks-v1",
    chunkSize: 1200,
    chunkOverlap: 200,
  });

  expect(first).not.toBe(second);
});
```

Run: `npm test -- src/main/rag/document-cache.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 2: Implement cache identity and file storage**

Create `src/main/rag/document-cache.ts`:

```ts
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import { getEmbeddingProviderIdentity } from "./embedding";

const CHUNK_STRATEGY_VERSION = "document-chunks-v1";

export function normalizeDocumentTextForCache(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function sha256(input: string): string {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

export function createDocumentCacheKey(identity: DocumentCacheIdentity): string {
  return sha256(JSON.stringify(identity));
}

export async function buildDocumentCacheIdentity(text: string): Promise<DocumentCacheIdentity> {
  const provider = await getEmbeddingProviderIdentity();
  return {
    textSha256: sha256(normalizeDocumentTextForCache(text)),
    embeddingProvider: provider.provider,
    embeddingModel: provider.model,
    dimensions: provider.dimensions,
    chunkStrategyVersion: CHUNK_STRATEGY_VERSION,
    chunkSize: 1200,
    chunkOverlap: 200,
  };
}

function cachePath(): string {
  return path.join(app.getPath("userData"), "rag-data", "document-cache.json");
}
```

Add JSON read/write helpers that treat missing/corrupt files as empty and write atomically through `document-cache.json.tmp`.

Run: `npm test -- src/main/rag/document-cache.test.ts`

Expected: PASS.

- [ ] **Step 3: Write failing stale-cache validation test**

Add:

```ts
it("treats a cache record as stale when the importId has no stored chunks", async () => {
  await putDocumentCacheRecord({
    key: "cache-key",
    importId: "import-missing",
    chunkCount: 4,
    fileName: "cached.md",
    createdAt: new Date().toISOString(),
  });

  const result = await getValidDocumentCacheRecord("cache-key", vectorStoreWithoutImportId("import-missing"));

  expect(result).toBeNull();
});
```

Run: `npm test -- src/main/rag/document-cache.test.ts`

Expected: FAIL until vector store can check an importId.

- [ ] **Step 4: Add importId existence check**

In `src/main/rag/vectorstore.ts`, add:

```ts
export function hasImportedDocumentChunks(importId: string): boolean {
  return entries.some(
    (entry) => entry.source === "imported_doc" && String(entry.metadata?.importId ?? "") === importId,
  );
}
```

In `src/main/rag/document-cache.ts`, validate records:

```ts
export async function getValidDocumentCacheRecord(
  key: string,
  hasImportId: (importId: string) => boolean,
): Promise<DocumentCacheRecord | null> {
  const record = await getDocumentCacheRecordByKey(key);
  if (!record) return null;
  return hasImportId(record.importId) ? record : null;
}
```

Run: `npm test -- src/main/rag/document-cache.test.ts src/main/rag/vectorstore.test.ts`

Expected: PASS.

- [ ] **Step 5: Write failing ingest cache-hit test**

In `src/main/rag/file-ingest.test.ts`, add:

```ts
it("reuses a completed document cache record instead of embedding again", async () => {
  const importFn = vi.fn();
  const result = await ingestOneFile(largeMarkdownPath, {
    importDocument: importFn,
    getCachedImport: async () => ({ importId: "import-cached", chunkCount: 9 }),
  });

  expect(result).toMatchObject({
    kind: "indexed",
    name: "large.md",
    chunks: 9,
    importId: "import-cached",
    cached: true,
  });
  expect(importFn).not.toHaveBeenCalled();
});
```

Run: `npm test -- src/main/rag/file-ingest.test.ts`

Expected: FAIL until ingestion checks the cache.

- [ ] **Step 6: Use cache around large document import**

In `src/main/rag/file-ingest.ts`, after reading text and before `importDocumentForTurn`:

```ts
const cacheIdentity = await buildDocumentCacheIdentity(text);
const cacheKey = createDocumentCacheKey(cacheIdentity);
const cached = await getValidDocumentCacheRecord(cacheKey, hasImportedDocumentChunks);

if (cached) {
  return {
    kind: "indexed",
    name,
    chunks: cached.chunkCount,
    importId: cached.importId,
    cached: true,
    filePath,
    mime,
  };
}

const imported = await importDocumentForTurn(text, name);
await putDocumentCacheRecord({
  key: cacheKey,
  importId: imported.importId,
  chunkCount: imported.chunkCount,
  fileName: name,
  createdAt: new Date().toISOString(),
});
```

Run: `npm test -- src/main/rag/file-ingest.test.ts src/main/rag/document-cache.test.ts`

Expected: PASS.

- [ ] **Step 7: Verify and gate commit**

Run:

```bash
npm test
npm run build
git diff --stat
git diff
```

Expected:
- Tests pass.
- Build passes.
- Diff only covers cache and its direct integration.

Stop and wait for user confirmation. After confirmation:

```bash
git add src/main/rag/document-cache.ts src/main/rag/document-cache.test.ts src/main/rag/file-ingest.ts src/main/index.ts src/main/rag/index.ts src/main/rag/vectorstore.ts src/main/rag/*.test.ts
git commit -m "perf(rag): cache document embedding results"
```

---

### Task 3: G3 Background Worker Queue and Progress

**Commit:** `perf(rag): index documents in a background worker queue`

**Files:**
- Create: `src/main/rag/document-index-worker.ts`
- Create: `src/main/rag/document-index-queue.ts`
- Create: `src/main/rag/document-index-queue.test.ts`
- Modify: `src/main/rag/file-ingest.ts`
- Modify: `src/main/index.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/shared/ipc.ts` or the current IPC constants file
- Modify: `src/renderer/chat/main.ts`
- Modify: `src/renderer/chat/types.ts`

**Interfaces:**
- Produces in `src/main/rag/document-index-queue.ts`:
  ```ts
  export type DocumentIndexJobStatus =
    | "queued"
    | "reading"
    | "chunking"
    | "embedding"
    | "cached"
    | "done"
    | "failed"
    | "cancelled";

  export type DocumentIndexProgress = {
    jobId: string;
    filePath: string;
    fileName: string;
    status: DocumentIndexJobStatus;
    completedChunks?: number;
    totalChunks?: number;
    reason?: string;
  };

  export type DocumentIndexJobResult =
    | { kind: "indexed"; name: string; chunks: number; importId: string; cached?: boolean }
    | { kind: "text"; name: string; text: string }
    | { kind: "empty"; name: string }
    | { kind: "unsupported"; name: string; reason: string }
    | { kind: "error"; name: string; reason: string };

  export function enqueueDocumentIndexJob(input: {
    filePath: string;
    query: string;
    onProgress: (progress: DocumentIndexProgress) => void;
  }): Promise<DocumentIndexJobResult>;

  export function cancelDocumentIndexJob(jobId: string): boolean;
  ```
- Renderer consumes progress events and updates only document attachment cards, not chat model context.

- [ ] **Step 1: Write failing FIFO queue test**

Create `src/main/rag/document-index-queue.test.ts`:

```ts
it("runs document index jobs one at a time in FIFO order", async () => {
  const runner = createControlledDocumentRunner();
  const queue = createDocumentIndexQueue({ runner });

  const first = queue.enqueue({ filePath: "first.md", query: "first", onProgress: vi.fn() });
  const second = queue.enqueue({ filePath: "second.md", query: "second", onProgress: vi.fn() });

  expect(runner.startedJobs()).toEqual(["first.md"]);
  runner.finishCurrent({ kind: "indexed", name: "first.md", chunks: 2, importId: "import-first" });
  await first;

  expect(runner.startedJobs()).toEqual(["first.md", "second.md"]);
  runner.finishCurrent({ kind: "indexed", name: "second.md", chunks: 3, importId: "import-second" });
  await second;
});
```

Run: `npm test -- src/main/rag/document-index-queue.test.ts`

Expected: FAIL because no queue exists.

- [ ] **Step 2: Implement FIFO queue coordinator**

Create `src/main/rag/document-index-queue.ts` with an internal queue:

```ts
const pending: QueuedJob[] = [];
let active: QueuedJob | null = null;

export function enqueueDocumentIndexJob(input: EnqueueInput): Promise<DocumentIndexJobResult> {
  const job: QueuedJob = {
    id: crypto.randomUUID(),
    input,
    cancelled: false,
    resolve: () => undefined,
    reject: () => undefined,
  };
  const promise = new Promise<DocumentIndexJobResult>((resolve, reject) => {
    job.resolve = resolve;
    job.reject = reject;
  });
  pending.push(job);
  input.onProgress({ jobId: job.id, filePath: input.filePath, fileName: path.basename(input.filePath), status: "queued" });
  void pumpQueue();
  return promise;
}

async function pumpQueue(): Promise<void> {
  if (active) return;
  active = pending.shift() ?? null;
  if (!active) return;
  try {
    active.resolve(await runDocumentIndexJob(active));
  } catch (error) {
    active.resolve({ kind: "error", name: path.basename(active.input.filePath), reason: getErrorMessage(error) });
  } finally {
    active = null;
    void pumpQueue();
  }
}
```

Run: `npm test -- src/main/rag/document-index-queue.test.ts`

Expected: PASS for FIFO.

- [ ] **Step 3: Write failing cancellation tests**

Add:

```ts
it("cancels a queued job before it starts", async () => {
  const runner = createControlledDocumentRunner();
  const queue = createDocumentIndexQueue({ runner });

  const first = queue.enqueue({ filePath: "first.md", query: "first", onProgress: vi.fn() });
  const second = queue.enqueue({ filePath: "second.md", query: "second", onProgress: vi.fn() });

  expect(queue.cancel(second.jobId)).toBe(true);
  await expect(second.promise).resolves.toMatchObject({ kind: "error", reason: "cancelled" });

  runner.finishCurrent({ kind: "indexed", name: "first.md", chunks: 2, importId: "import-first" });
  await first.promise;
  expect(runner.startedJobs()).toEqual(["first.md"]);
});

it("marks an active job cancelled between chunks and writes no partial vectors", async () => {
  const runner = createControlledDocumentRunner();
  const queue = createDocumentIndexQueue({ runner });

  const job = queue.enqueue({ filePath: "large.md", query: "large", onProgress: vi.fn() });
  expect(queue.cancel(job.jobId)).toBe(true);
  runner.finishCurrent({ kind: "error", name: "large.md", reason: "cancelled" });

  await expect(job.promise).resolves.toMatchObject({ kind: "error", reason: "cancelled" });
  expect(vectorStore.addBatch).not.toHaveBeenCalled();
});
```

Run: `npm test -- src/main/rag/document-index-queue.test.ts`

Expected: FAIL until queued and active cancellation are implemented.

- [ ] **Step 4: Implement cancellation**

Track `jobId` in the returned queue handle and implement:

```ts
export function cancelDocumentIndexJob(jobId: string): boolean {
  const pendingIndex = pending.findIndex((job) => job.id === jobId);
  if (pendingIndex >= 0) {
    const [job] = pending.splice(pendingIndex, 1);
    job.input.onProgress({ jobId, filePath: job.input.filePath, fileName: path.basename(job.input.filePath), status: "cancelled" });
    job.resolve({ kind: "error", name: path.basename(job.input.filePath), reason: "cancelled" });
    return true;
  }
  if (active?.id === jobId) {
    active.cancelled = true;
    return true;
  }
  return false;
}
```

Make the active runner check `job.cancelled` between chunks and before vector-store write.

Run: `npm test -- src/main/rag/document-index-queue.test.ts`

Expected: PASS.

- [ ] **Step 5: Write failing IPC progress test**

Add an IPC handler test:

```ts
it("forwards document indexing progress to the sender webContents", async () => {
  const send = vi.fn();
  await invokeChatProcessDocuments({
    sender: { send },
    filePaths: [largeMarkdownPath],
    query: "summarize",
  });

  expect(send).toHaveBeenCalledWith("chat:document-index-progress", expect.objectContaining({
    fileName: "large.md",
    status: expect.stringMatching(/queued|reading|chunking|embedding|done/),
  }));
});
```

Run: `npm test -- src/main/index.test.ts`

Expected: FAIL until main forwards progress.

- [ ] **Step 6: Wire queue into IPC and preload**

In the shared IPC constants file, add:

```ts
CHAT_DOCUMENT_INDEX_PROGRESS: "chat:document-index-progress",
CHAT_CANCEL_DOCUMENT_INDEX: "chat:cancel-document-index",
```

In `src/main/index.ts`, route document processing through `enqueueDocumentIndexJob`:

```ts
const results = [];
for (const filePath of filePaths) {
  const result = await enqueueDocumentIndexJob({
    filePath,
    query,
    onProgress: (progress) => event.sender.send(IPC.CHAT_DOCUMENT_INDEX_PROGRESS, progress),
  });
  results.push(result);
}
return results;
```

Expose in `src/preload/index.ts`:

```ts
onDocumentIndexProgress(callback: (progress: DocumentIndexProgress) => void) {
  ipcRenderer.on(IPC.CHAT_DOCUMENT_INDEX_PROGRESS, (_event, progress) => callback(progress));
  return () => ipcRenderer.removeListener(IPC.CHAT_DOCUMENT_INDEX_PROGRESS, callback);
},
cancelDocumentIndex(jobId: string) {
  return ipcRenderer.invoke(IPC.CHAT_CANCEL_DOCUMENT_INDEX, { jobId });
},
```

Run: `npm test -- src/main/index.test.ts src/preload/index.test.ts`

Expected: PASS.

- [ ] **Step 7: Implement worker runner**

Create `src/main/rag/document-index-worker.ts` using Node worker threads if the existing build supports it. The worker message shape:

```ts
type WorkerRequest = {
  jobId: string;
  filePath: string;
  query: string;
};

type WorkerMessage =
  | { type: "progress"; progress: DocumentIndexProgress }
  | { type: "result"; result: PreparedDocumentIndexResult }
  | { type: "error"; reason: string };
```

Keep vector-store mutation in main. The worker returns prepared chunks/embeddings; main writes them only after a complete result and cache validation passes:

```ts
if (!job.cancelled && result.kind === "indexed") {
  await store.addPreparedBatch(result.entries);
  await putDocumentCacheRecord(result.cacheRecord);
}
```

Run: `npm test -- src/main/rag/document-index-queue.test.ts`

Expected: PASS.

- [ ] **Step 8: Update renderer document cards with progress and cancel**

In `src/renderer/chat/main.ts`, subscribe once:

```ts
const unsubscribeDocumentProgress = window.chat.onDocumentIndexProgress?.((progress) => {
  updateDocumentAttachmentProgress(progress);
  render();
});
```

Update document attachment status labels:

```ts
const labelByStatus = {
  queued: "等待处理",
  reading: "正在读取",
  chunking: "正在切分",
  embedding: "正在分析",
  cached: "已从缓存读取",
  done: "已处理",
  failed: "处理失败",
  cancelled: "已取消",
};
```

Render a cancel action only for `queued`, `reading`, `chunking`, and `embedding` states:

```ts
button.addEventListener("click", () => {
  if (attachment.jobId) {
    void window.chat.cancelDocumentIndex(attachment.jobId);
  }
});
```

Run: `npm test -- src/renderer/chat/main.test.ts`

Expected: PASS.

- [ ] **Step 9: Verify and gate commit**

Run:

```bash
npm test
npm run build
git diff --stat
git diff
```

Expected:
- Tests pass.
- Build passes.
- Diff only covers worker queue/progress/cancel integration.

Stop and wait for user confirmation. After confirmation:

```bash
git add src/main/rag/document-index-worker.ts src/main/rag/document-index-queue.ts src/main/rag/document-index-queue.test.ts src/main/rag/file-ingest.ts src/main/index.ts src/preload/index.ts src/shared/ipc.ts src/renderer/chat/main.ts src/renderer/chat/types.ts src/**/*.test.ts
git commit -m "perf(rag): index documents in a background worker queue"
```

---

## Self-Review

- Spec coverage: G1 covers accurate waiting, fixed deterministic wait message, no 8KB fallback, importId-limited retrieval, failure context, and image/document context accumulation. G2 covers persistent content-addressed caching with model/chunk invalidation and stale-cache miss. G3 covers FIFO background queue, progress, cancellation, main-owned store writes, and no partial vector writes.
- Placeholder scan: No `TBD`, `TODO`, or undefined future work remains. Worker implementation notes include concrete message shapes and ownership boundaries.
- Type consistency: `importId`, `chunkCount`, `chunks`, `cached`, `DocumentIndexProgress`, and `DocumentIndexJobResult` names are consistent across tasks.

