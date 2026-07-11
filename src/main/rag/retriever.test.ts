import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { HybridRetriever } from "./retriever";
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
});
