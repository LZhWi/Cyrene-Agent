import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { describe, expect, it } from "vitest";
import type { L2Memory } from "./memory-types";
import { selectMemoryFacetBackfillTargets } from "./memory-facet-backfill";

const enabled = process.env.CYRENE_REAL_MEMORY_FACET_BACKFILL_EVAL === "1";
const userDataDir = process.env.CYRENE_REAL_USER_DATA_DIR ?? "";

function digest(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

describe.skipIf(!enabled)("real-data isolated memory facet backfill", () => {
  it("selects only pending entries after completion and notices a newly pending L2", () => {
    const memoryPath = path.join(userDataDir, "memory.json");
    const before = digest(memoryPath);
    const store = JSON.parse(fs.readFileSync(memoryPath, "utf8")) as { l2?: L2Memory[] };
    const realL2 = store.l2 ?? [];
    expect(realL2.length).toBeGreaterThan(10);
    const exemplar = realL2[0];
    const syntheticPending: L2Memory = {
      ...exemplar,
      id: "isolated-new-pending",
      facets: { primaryKind: "other", retrievalKinds: ["other"], source: "pending", pendingClassification: true },
    };

    const targets = selectMemoryFacetBackfillTargets([...realL2, syntheticPending], true, realL2.map((item) => item.id));
    const expectedRealPending = realL2.filter((item) => (
      !item.facets || item.facets.pendingClassification || item.facets.source === "pending"
    ));

    expect(targets.map((item) => item.id)).toEqual([...expectedRealPending.map((item) => item.id), syntheticPending.id]);
    expect(targets.some((item) => item.facets?.source === "model" && !item.facets.pendingClassification)).toBe(false);
    expect(digest(memoryPath)).toBe(before);
  });
});
