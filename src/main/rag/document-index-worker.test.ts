import { describe, expect, it, vi } from "vitest";
import {
  createDocumentIndexWorkerRunner,
  type DocumentIndexWorkerPort,
  type PreparedDocumentIndexResult,
} from "./document-index-worker";
import type { QueuedDocumentIndexJob } from "./document-index-queue";

function createControlledWorker(): {
  worker: DocumentIndexWorkerPort;
  emit: (message: unknown) => void;
  posted: unknown[];
} {
  const posted: unknown[] = [];
  const listeners = new Map<string, Array<(...args: any[]) => void>>();
  return {
    worker: {
      postMessage: (message) => { posted.push(message); },
      on: (event, listener) => {
        const entries = listeners.get(event) ?? [];
        entries.push(listener);
        listeners.set(event, entries);
      },
      terminate: vi.fn().mockResolvedValue(0),
    },
    emit: (message) => listeners.get("message")?.forEach((listener) => listener(message)),
    posted,
  };
}

function createJob(): QueuedDocumentIndexJob & { cancel: () => void } {
  let cancellationListener: (() => void) | undefined;
  const job: QueuedDocumentIndexJob & { cancel: () => void } = {
    id: "job-1",
    input: { filePath: "large.md", query: "summarize", onProgress: vi.fn() },
    cancelled: false,
    reportProgress: vi.fn(),
    onCancel: (listener) => {
      cancellationListener = listener;
      return () => { cancellationListener = undefined; };
    },
    cancel: () => {
      job.cancelled = true;
      cancellationListener?.();
    },
  };
  return job;
}

describe("document index worker runner", () => {
  it("cancels active preparation before vector or cache persistence", async () => {
    const controlled = createControlledWorker();
    const persistPrepared = vi.fn();
    const putCache = vi.fn();
    const runner = createDocumentIndexWorkerRunner({
      createWorker: () => controlled.worker,
      getCachedImport: vi.fn().mockResolvedValue(null),
      getEmbeddingConfig: () => ({ provider: "local", modelKey: "minilm" }),
      persistPrepared,
      putCache,
    });
    const job = createJob();

    const running = runner(job);
    const prepared: PreparedDocumentIndexResult = {
      kind: "prepared-indexed",
      name: "large.md",
      text: "document text",
      chunks: [{ text: "first", index: 0 }, { text: "second", index: 1 }],
    };
    controlled.emit({ type: "prepared", result: prepared });
    await Promise.resolve();
    expect(controlled.posted).toContainEqual({ type: "embed", embedding: { provider: "local", modelKey: "minilm" } });

    controlled.emit({ type: "progress", completedChunks: 1, totalChunks: 2 });
    expect(job.reportProgress).toHaveBeenCalledWith(expect.objectContaining({
      status: "embedding",
      completedChunks: 1,
      totalChunks: 2,
    }));

    job.cancel();
    expect(controlled.posted).toContainEqual({ type: "cancel" });
    controlled.emit({ type: "cancelled" });

    await expect(running).resolves.toMatchObject({ kind: "error", reason: "cancelled" });
    expect(persistPrepared).not.toHaveBeenCalled();
    expect(putCache).not.toHaveBeenCalled();
  });
});
