import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { JsonVectorStore } from "./vectorstore";

describe("JsonVectorStore persistence", () => {
  it("flushes the latest debounced snapshot synchronously on shutdown", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-vectorstore-flush-"));
    try {
      const store = new JsonVectorStore(dir);
      store.addPreparedBatch([
        { text: "first", source: "imported_doc", embedding: [1, 0] },
        { text: "second", source: "imported_doc", embedding: [0, 1] },
      ]);
      store.flushSync();

      const reloaded = new JsonVectorStore(dir);
      expect(reloaded.stats).toEqual({ total: 2, sources: { imported_doc: 2 } });
      expect(fs.readdirSync(dir).some((name) => name.includes(".tmp-"))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("flushes a document import asynchronously before reporting completion", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-vectorstore-async-flush-"));
    try {
      const store = new JsonVectorStore(dir);
      store.addPreparedBatch([{ text: "document", source: "imported_doc", embedding: [1, 0] }]);
      await store.flush();
      expect(new JsonVectorStore(dir).stats.total).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not let an in-flight old write restore vectors after a dimension rebuild", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-vectorstore-rebuild-"));
    vi.useFakeTimers();
    const open = fs.promises.open.bind(fs.promises);
    let releaseOpen: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { releaseOpen = resolve; });
    const openSpy = vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
      await gate;
      return open(...args);
    });
    try {
      const store = new JsonVectorStore(dir);
      store.addPreparedBatch([{ text: "old", source: "imported_doc", embedding: [1, 0] }]);
      vi.advanceTimersByTime(1500);
      store.clearForRebuild();
      releaseOpen?.();
      await store.flush();
      expect(new JsonVectorStore(dir).stats.total).toBe(0);
    } finally {
      releaseOpen?.();
      openSpy.mockRestore();
      vi.useRealTimers();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("flushes mutations made while an older snapshot is still being written", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-vectorstore-concurrent-flush-"));
    vi.useFakeTimers();
    const open = fs.promises.open.bind(fs.promises);
    let releaseOpen: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { releaseOpen = resolve; });
    const openSpy = vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
      await gate;
      return open(...args);
    });
    try {
      const store = new JsonVectorStore(dir);
      store.addPreparedBatch([{ text: "first", source: "imported_doc", embedding: [1, 0] }]);
      vi.advanceTimersByTime(1500);
      store.addPreparedBatch([{ text: "second", source: "imported_doc", embedding: [0, 1] }]);
      releaseOpen?.();
      await store.flush();
      expect(new JsonVectorStore(dir).stats.total).toBe(2);
    } finally {
      releaseOpen?.();
      openSpy.mockRestore();
      vi.useRealTimers();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
