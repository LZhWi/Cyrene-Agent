import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
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
});
