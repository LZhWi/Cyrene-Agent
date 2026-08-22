import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JsonVectorStore } from "./vectorstore";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function persist(store: JsonVectorStore): Promise<void> {
  return (store as unknown as { persist(): Promise<void> }).persist();
}

describe("JsonVectorStore persistence", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves legacy chat history metadata unchanged on store load", () => {
    const dbPath = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-vectorstore-facets-"));
    tempDirs.push(dbPath);
    fs.writeFileSync(path.join(dbPath, "memory-store.json"), JSON.stringify([{
      id: "legacy-history",
      text: "我答应以后亲手给你做礼物",
      embedding: [1, 0],
      source: "chat_history",
      weight: 1,
      createdAt: 1,
      lastRecalledAt: 1,
      metadata: { sessionId: "old", role: "user", ts: 1 },
    }]), "utf8");

    const store = new JsonVectorStore(dbPath);
    store.flushSync();
    const persisted = JSON.parse(fs.readFileSync(path.join(dbPath, "memory-store.json"), "utf8"));

    expect(persisted[0].metadata.memoryFacets).toBeUndefined();
  });

  it("isolates a replacement store from a stale instance's temp file", async () => {
    const dbPath = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-vectorstore-race-"));
    tempDirs.push(dbPath);

    const oldStore = new JsonVectorStore(dbPath);
    oldStore.addPreparedBatch([{ text: "base", source: "chat_history", embedding: [1, 0] }]);
    oldStore.flushSync();

    const oldReady = deferred();
    const newReady = deferred();
    const releaseOld = deferred();
    const releaseNew = deferred();
    const originalOpen = fs.promises.open.bind(fs.promises);
    let openCount = 0;

    vi.spyOn(fs.promises, "open").mockImplementation((async (...args: unknown[]) => {
      const handle = await (originalOpen as unknown as (...openArgs: unknown[]) => Promise<fs.promises.FileHandle>)(...args);
      const call = ++openCount;
      return {
        write: (...writeArgs: unknown[]) => (
          handle.write as unknown as (...handleArgs: unknown[]) => ReturnType<fs.promises.FileHandle["write"]>
        )(...writeArgs),
        close: async () => {
          if (call === 1) {
            oldReady.resolve();
            await releaseOld.promise;
          } else {
            newReady.resolve();
            await releaseNew.promise;
          }
          await handle.close();
        },
      } as fs.promises.FileHandle;
    }) as typeof fs.promises.open);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    oldStore.addPreparedBatch([{ text: "old-inflight", source: "chat_history", embedding: [1, 0] }]);
    const oldPersist = persist(oldStore);
    await oldReady.promise;

    // resetRAG() flushes the old store, then creates a replacement that reads this snapshot.
    oldStore.flushSync();
    const newStore = new JsonVectorStore(dbPath);
    newStore.addPreparedBatch([{ text: "new-instance", source: "chat_history", embedding: [1, 0] }]);
    const newPersist = persist(newStore);
    await newReady.promise;

    releaseOld.resolve();
    await oldPersist;
    releaseNew.resolve();
    await newPersist;

    const stored = JSON.parse(fs.readFileSync(path.join(dbPath, "memory-store.json"), "utf8")) as Array<{ text: string }>;
    expect(stored.map((entry) => entry.text)).toEqual(["base", "old-inflight", "new-instance"]);
    expect(fs.readdirSync(dbPath).filter((name) => name.includes(".tmp-"))).toEqual([]);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
