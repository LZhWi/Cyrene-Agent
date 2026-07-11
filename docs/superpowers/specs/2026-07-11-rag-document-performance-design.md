# Document RAG Performance Design

## Goal

Keep document answers accurate while making large-document handling feel responsive.
Cyrene must not answer from an arbitrary leading excerpt of a document. A large
document is indexed and queried before the main model is called.

## Scope

This design applies only to text/document attachments sent from the chat
composer. Image attachments, stickers, memory scheduling, WeChat media, and
the general RAG schema are out of scope.

The work is split into three independent local commits:

1. `fix(chat): wait for document indexing before reply`
2. `perf(rag): cache document embedding results`
3. `perf(rag): index documents in a background worker queue`

No commit is pushed.

## G1: Accurate Send Flow

Small documents retain the current path: read after Send, place their text in
the turn-only `modelContext`, then call the model.

For large documents, Send immediately creates the user message and its
document card, clears the composer, and starts document processing. The
renderer shows the existing transient status, `正在分析文档...`.

The main model is gated until every large document for this turn reaches a
terminal state. After 3.5 seconds of pending processing, the renderer inserts
one deterministic assistant wait message:

`这份文档有点大呢，我正在仔细读里面的内容……稍等我一下，等我看完重点再认真回答你～`

The wait message is local, marked transient, does not call the model, spends no
tokens, and is not persisted in chat history. It is removed immediately before
the real assistant response is created, so the final conversation contains one
assistant answer rather than a stale extra message.

After indexing succeeds, the original user text is used as the query. Retrieval
is limited to the `importId` values resolved for this turn, whether newly
created or reused from a cache hit. The resulting chunks are written only to
`userMsg.modelContext`, together with the existing image context when
applicable. The user bubble and document card never show chunks or embeddings.

If a document fails, the turn still calls the model with the user text. Its
`modelContext` includes this exact failure contract for the affected file:

`用户发送了文档 <filename>，但文档处理失败：<reason>。请诚实说明暂时无法分析该文档，不要编造文档内容。`

One failed document never prevents successful documents in the same turn from
being retrieved. There is no first-8KB preview fallback. A future preview mode,
if ever added, is an explicit opt-in setting and is out of scope here.

The `importId` restriction is a narrow retriever option: it filters existing
`imported_doc` entries by their current metadata. It does not alter stored entry
formats, migrate old indexes, or change generic memory retrieval.

## G2: Persistent Content Cache

Document indexing cache entries live under the existing `userData/rag-data`
directory. A cache key contains:

- SHA-256 of normalized document text
- embedding provider/model identity and vector dimensions
- chunking strategy version and parameters

A cache record maps that key to a completed `importId` and chunk count. A cache
hit reuses the existing stored vectors, then performs the same importId-limited
retrieval for the current question. A cache record is written only after a
successful completed index, and stale/missing index entries are treated as a
cache miss. Changed text, changed embedding model, or changed chunking rules
always re-index.

This is content-addressed caching. The same content under a different path can
reuse an index; a changed file with the same name cannot.

## G3: Worker Queue and Progress

Document indexing uses one FIFO worker job at a time. A single active local
embedding pipeline prevents multiple documents from competing for CPU and RAM.
The main process owns validation, job coordination, cache metadata, and vector
store writes. The worker owns expensive read/chunk/embed work and reports
progress. It never mutates the vector store directly.

Jobs report `queued`, `reading`, `chunking`, `embedding`, `cached`, `done`,
`failed`, or `cancelled` through a focused chat IPC event. The renderer updates
the existing document card with concise status and progress; these events are
not chat messages and are not persisted as model context.

An in-progress document card exposes a cancel action. Queued jobs are removed
immediately. Active work stops between chunks, discards its uncommitted result,
and reports `cancelled`; partial vectors are never written to the store. A
cancelled document is treated as a failure for the current turn, with an honest
model-context notice if the user message is still awaiting a reply.

## Error Handling

- Missing, unsupported, or empty documents retain the existing explicit states.
- A worker crash fails only its job and starts a fresh worker for later jobs.
- Cache read/write errors degrade to an uncached index; they never cause a false
  successful result.
- Retrieval errors are reported as document-processing failures, and the model
  is told not to invent content.
- All attachment contributions are accumulated before assigning
  `userMsg.modelContext`; document and image data cannot overwrite one another.

## Verification

G1 tests cover the delayed deterministic wait message, model-call gating,
successful importId-limited recall, partial document failure, and combined
image/document context.

G2 tests cover cache hit, content/model/chunk-version invalidation, and a stale
cache record that correctly falls back to indexing.

G3 tests cover FIFO order, progress forwarding, duplicate-job coalescing,
queued cancellation, active cancellation, no partial store write, and worker
crash recovery.

Each commit runs the relevant tests, the full `npm test`, `npm run build`,
`git diff --stat`, and `git diff` before review and local commit.
