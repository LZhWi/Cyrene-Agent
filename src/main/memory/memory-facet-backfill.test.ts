import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  userDataDir: "",
  l2: [] as Array<Record<string, any>>,
  l2Updates: [] as Array<Array<{ id: string; facets: Record<string, unknown> }>>,
  classifier: async (_items: Array<{ id: string }>) => [] as Array<{ id: string; facets: Record<string, unknown> }>,
}));

vi.mock("../runtime/runtime-paths", () => ({ getUserDataDir: () => mocks.userDataDir }));
vi.mock("../llm-queue", () => ({ enqueueLLMTask: async (_label: string, task: () => Promise<unknown>) => task() }));
vi.mock("./memory-store", () => ({
  memoryStore: {
    getAllL2: async () => mocks.l2,
    updateL2FacetsBatch: async (updates: Array<{ id: string; facets: Record<string, unknown> }>) => {
      mocks.l2Updates.push(updates);
      return updates.length;
    },
  },
}));
vi.mock("./memory-judge", () => ({
  memoryJudge: { classifyMemoryFacetsBatch: (items: Array<{ id: string }>) => mocks.classifier(items) },
}));

import { backfillMemoryFacets } from "./memory-facet-backfill";

const pending = { primaryKind: "other", retrievalKinds: ["other"], source: "pending", pendingClassification: true };
const model = { primaryKind: "fact", retrievalKinds: ["fact"], source: "model", pendingClassification: false };

describe("memory facet backfill", () => {
  beforeEach(() => {
    mocks.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-facet-backfill-"));
    mocks.l2 = [];
    mocks.l2Updates = [];
    mocks.classifier = async (items) => items.map(({ id }) => ({ id, facets: model }));
  });

  afterEach(() => fs.rmSync(mocks.userDataDir, { recursive: true, force: true }));

  it("reclassifies every pre-v2 L2 once so legacy single labels can gain secondary labels", async () => {
    mocks.l2 = [
      { id: "pending-l2", content: "待分类", triggerText: "", facets: pending },
      { id: "model-l2", content: "已分类", triggerText: "", facets: model },
    ];
    const result = await backfillMemoryFacets();

    expect(result).toMatchObject({ complete: true, classifiedL2: 2 });
    expect(mocks.l2Updates.flat().map((item) => item.id)).toEqual(["pending-l2", "model-l2"]);
  });

  it("checkpoints successful batches and resumes the failed batch on next startup", async () => {
    mocks.l2 = Array.from({ length: 13 }, (_, index) => ({
      id: `l2-${index}`,
      content: `记忆 ${index}`,
      triggerText: "",
      facets: pending,
    }));
    let calls = 0;
    mocks.classifier = async (items) => {
      calls += 1;
      if (calls === 2) throw new Error("temporary model failure");
      return items.map(({ id }) => ({ id, facets: model }));
    };

    const first = await backfillMemoryFacets();
    expect(first).toMatchObject({ complete: false, classifiedL2: 12, reason: "batch_failed" });

    mocks.classifier = async (items) => items.map(({ id }) => ({ id, facets: model }));
    const second = await backfillMemoryFacets();
    expect(second).toMatchObject({ complete: true, classifiedL2: 1 });
    expect(mocks.l2Updates.flat().map((item) => item.id)).toEqual([
      ...Array.from({ length: 12 }, (_, index) => `l2-${index}`),
      "l2-12",
    ]);
  });

  it("self-heals a newly pending L2 even after the v2 marker was complete", async () => {
    expect(await backfillMemoryFacets()).toMatchObject({ complete: true, classifiedL2: 0 });
    mocks.l2 = [{ id: "late-pending", content: "稍后产生的待分类记忆", triggerText: "", facets: pending }];

    const result = await backfillMemoryFacets();

    expect(result).toMatchObject({ complete: true, classifiedL2: 1 });
    expect(mocks.l2Updates.flat().map((item) => item.id)).toEqual(["late-pending"]);
  });

  it("retries a previously completed ID when pending self-heal fails once", async () => {
    mocks.l2 = [{ id: "classified-before", content: "原本已分类", triggerText: "", facets: model }];
    expect(await backfillMemoryFacets()).toMatchObject({ complete: true, classifiedL2: 1 });
    mocks.l2Updates = [];
    mocks.l2[0].facets = pending;
    mocks.classifier = async () => { throw new Error("temporary classifier outage"); };

    expect(await backfillMemoryFacets()).toMatchObject({ complete: false, reason: "batch_failed" });

    mocks.classifier = async (items) => items.map(({ id }) => ({ id, facets: model }));
    expect(await backfillMemoryFacets()).toMatchObject({ complete: true, classifiedL2: 1 });
    expect(mocks.l2Updates.flat().map((item) => item.id)).toEqual(["classified-before"]);
  });
});
