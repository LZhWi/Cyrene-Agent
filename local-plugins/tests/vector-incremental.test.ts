import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createMockPluginContext } from "@playa0v0/cyrene-plugin-sdk/testing";
import { createVectorIndex } from "../plugins/companion-memory/src/vector-index";

describe("incremental vector import", () => {
  it("preserves existing records, is idempotent and rejects stale or mismatched sources without writes", () => {
    const ctx = createMockPluginContext();
    const vector = Array(64).fill(0); vector[0] = 1;
    const hash = createHash("sha256").update("old").digest("hex");
    const index = createVectorIndex(ctx.storage);
    index.upsertGenerated([{ l2Id: "old", embedding: vector, contentHash: hash }], 64);
    const before = structuredClone(ctx.storage.get<any>("vector-index"));
    mkdirSync(path.resolve(".test-runtime"), { recursive: true });
    const dir = mkdtempSync(path.resolve(".test-runtime/vector-incremental-"));
    const file = path.join(dir, "memory-store.json");
    const source = (text = "new", dimension = 64, duplicate = false) => {
      const row = { source: "user_memory", text, metadata: { l2Id: "new" }, embedding: Array(dimension).fill(0.1) };
      const body = JSON.stringify(duplicate ? [row, row] : [row]); writeFileSync(file, body);
      return createHash("sha256").update(body).digest("hex");
    };
    const entries = [{ id: "old", content: "old" }, { id: "new", content: "new" }];
    for (const makeSource of [() => source("wrong"), () => source("new", 65), () => source("new", 64, true)]) {
      const sourceHash = makeSource();
      expect(() => index.importLegacyIncremental(file, sourceHash, entries)).toThrow();
      expect(ctx.storage.get("vector-index")).toEqual(before);
    }
    const sourceHash = source();
    expect(() => index.importLegacyIncremental(file, "stale", entries)).toThrow();
    expect(index.importLegacyIncremental(file, sourceHash, entries).added).toBe(1);
    const after = ctx.storage.get<any>("vector-index");
    expect(after.entries[0]).toEqual(before.entries[0]);
    expect(index.importLegacyIncremental(file, sourceHash, entries).added).toBe(0);
    expect(ctx.storage.get("vector-index")).toEqual(after);
    expect(createVectorIndex(ctx.storage).generatedHash("new")).toBe(createHash("sha256").update("new").digest("hex"));
  });
});
