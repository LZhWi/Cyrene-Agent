import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { EmbeddingProvider } from "./embedding";

const provider: EmbeddingProvider = {
  name: "deterministic",
  dims: 2,
  async embed(text: string): Promise<number[]> {
    return text.includes("paragraph") ? [0, 1] : [1, 0];
  },
  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((text) => this.embed(text)));
  },
};

const { userDataDir, appPath } = vi.hoisted(() => ({ userDataDir: { value: "" }, appPath: { value: "" } }));

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

import {
  importDocumentForTurn,
  initRAG,
  resetRAG,
  searchImportedDocumentChunksForImportIds,
} from "./index";

let tmpDir = "";

beforeEach(async () => {
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
  it("returns an importId and chunk count for a turn document import", async () => {
    const result = await importDocumentForTurn("one paragraph\n\ntwo paragraph", "turn-doc.md");

    expect(result.importId).toMatch(/^import-/);
    expect(result.chunkCount).toBeGreaterThan(0);

    const chunks = await searchImportedDocumentChunksForImportIds("paragraph", [result.importId], 3);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((chunk) => chunk.importId === result.importId)).toBe(true);
  });
});
