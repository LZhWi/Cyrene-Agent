import { describe, expect, it } from "vitest";
import {
  mergeConflictLogs,
  mergeEvidence,
  mergeHistoryEntries,
  mergeL0,
  mergeL1,
  mergeL2,
  mergeReflectionLogs,
  HISTORY_MERGE_LIMIT,
} from "./merge";
import type {
  ConflictLog,
  L0Profile,
  L1Profile,
  L2Memory,
  MemoryEvidence,
  ReflectionLog,
} from "../memory/memory-types";
import type { HistoryEntry } from "../channels/history-log";

function l2(id: string, over: Partial<L2Memory> = {}): L2Memory {
  return {
    id,
    content: `c-${id}`,
    triggerText: `t-${id}`,
    sourceConversationId: "conv",
    createdAt: 1000,
    lastAccessedAt: 1000,
    accessCount: 0,
    weight: 0,
    isPinned: false,
    status: "active",
    syncStatus: "pending_sync",
    ...over,
  };
}

function l0(over: Partial<L0Profile> = {}): L0Profile {
  return {
    nickname: "",
    preferredName: "",
    occupation: "",
    longTermInterests: "",
    language: "zh-CN",
    permanentNote: "",
    isPinned: false,
    updatedAt: 0,
    ...over,
  };
}

function l1(over: Partial<L1Profile> = {}): L1Profile {
  return {
    recentGoals: "",
    recentPreferences: "",
    currentProject: "",
    generatedAt: 0,
    roundCount: 0,
    ...over,
  };
}

function ev(id: string, over: Partial<MemoryEvidence> = {}): MemoryEvidence {
  return {
    id,
    memoryId: "m",
    quoteSnippet: `q-${id}`,
    createdAt: 1000,
    sourceStatus: "active",
    ...over,
  };
}

function ref(id: string, createdAt: number): ReflectionLog {
  return { id, createdAt, type: "compression", summary: `s-${id}` };
}

function conf(id: string, over: Partial<ConflictLog> = {}): ConflictLog {
  return {
    id,
    createdAt: 1000,
    status: "candidate",
    sourceL2Id: "a",
    targetL2Id: "b",
    reason: "r",
    confidence: 0.5,
    detector: "local",
    ...over,
  };
}

function h(at: string, role: "user" | "assistant", content: string): HistoryEntry {
  return { at, role, content };
}

describe("sync/merge · mergeL2", () => {
  it("unions distinct ids and appends new to tail", () => {
    const base = [l2("a"), l2("b")];
    const incoming = [l2("c")];
    const { merged, added, updated } = mergeL2(base, incoming);
    expect(merged.map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(added).toBe(1);
    expect(updated).toBe(0);
  });

  it("keeps base on tie (idempotent re-push)", () => {
    const base = [l2("a", { weight: 5, lastAccessedAt: 2000, accessCount: 3 })];
    const incoming = [l2("a", { weight: 5, lastAccessedAt: 2000, accessCount: 3 })];
    const { merged, added, updated } = mergeL2(base, incoming);
    expect(merged).toHaveLength(1);
    expect(added).toBe(0);
    expect(updated).toBe(0);
  });

  it("incoming wins when lastAccessedAt is newer", () => {
    const base = [l2("a", { lastAccessedAt: 1000, weight: 1 })];
    const incoming = [l2("a", { lastAccessedAt: 5000, weight: 9 })];
    const { merged, updated } = mergeL2(base, incoming);
    expect(merged[0].weight).toBe(9);
    expect(updated).toBe(1);
  });

  it("base wins when it is newer than incoming", () => {
    const base = [l2("a", { lastAccessedAt: 5000, weight: 9 })];
    const incoming = [l2("a", { lastAccessedAt: 1000, weight: 1 })];
    const { merged, updated } = mergeL2(base, incoming);
    expect(merged[0].weight).toBe(9);
    expect(updated).toBe(0);
  });

  it("is idempotent under repeated merges", () => {
    const base = [l2("a"), l2("b")];
    const incoming = [l2("b"), l2("c")];
    const first = mergeL2(base, incoming).merged;
    const second = mergeL2(first, incoming).merged;
    expect(second.map((m) => m.id)).toEqual(["a", "b", "c"]);
  });
});

describe("sync/merge · L0/L1 LWW", () => {
  it("L0 picks greater updatedAt", () => {
    expect(mergeL0(l0({ updatedAt: 10, nickname: "old" }), l0({ updatedAt: 20, nickname: "new" })).merged.nickname).toBe("new");
    expect(mergeL0(l0({ updatedAt: 30, nickname: "keep" }), l0({ updatedAt: 20, nickname: "drop" })).merged.nickname).toBe("keep");
  });

  it("L0 tie keeps base (no change)", () => {
    const r = mergeL0(l0({ updatedAt: 10, nickname: "base" }), l0({ updatedAt: 10, nickname: "incoming" }));
    expect(r.merged.nickname).toBe("base");
    expect(r.changed).toBe(false);
  });

  it("L1 replaces by generatedAt", () => {
    expect(mergeL1(l1({ generatedAt: 1, currentProject: "old" }), l1({ generatedAt: 2, currentProject: "new" })).merged.currentProject).toBe("new");
    expect(mergeL1(l1({ generatedAt: 5, currentProject: "keep" }), l1({ generatedAt: 2 })).changed).toBe(false);
  });
});

describe("sync/merge · logs & evidence", () => {
  it("evidence unions by id, keeps base on dup", () => {
    const { merged, added } = mergeEvidence([ev("e1")], [ev("e1", { quoteSnippet: "changed" }), ev("e2")]);
    expect(merged.map((e) => e.id)).toEqual(["e1", "e2"]);
    expect(merged[0].quoteSnippet).toBe("q-e1");
    expect(added).toBe(1);
  });

  it("reflectionLogs union sorted by createdAt and capped", () => {
    const base = [ref("r1", 100)];
    const incoming = [ref("r2", 50), ref("r1", 100)];
    const { merged, added } = mergeReflectionLogs(base, incoming);
    expect(merged.map((r) => r.id)).toEqual(["r2", "r1"]);
    expect(added).toBe(1);
  });

  it("conflictLogs: incoming with later resolverFinishedAt wins", () => {
    const base = [conf("c1", { status: "candidate" })];
    const incoming = [conf("c1", { status: "resolved", resolverFinishedAt: 9000 })];
    const { merged, updated } = mergeConflictLogs(base, incoming);
    expect(merged[0].status).toBe("resolved");
    expect(updated).toBe(1);
  });
});

describe("sync/merge · mergeHistoryEntries", () => {
  it("dedupes by (at, role, content) and sorts ascending", () => {
    const base = [h("2024-01-01T00:00:02Z", "user", "b")];
    const incoming = [
      h("2024-01-01T00:00:01Z", "user", "a"),
      h("2024-01-01T00:00:02Z", "user", "b"), // dup
    ];
    const { merged, added } = mergeHistoryEntries(base, incoming);
    expect(merged.map((e) => e.content)).toEqual(["a", "b"]);
    expect(added).toBe(1);
  });

  it("keeps both when same timestamp but different content", () => {
    const base = [h("2024-01-01T00:00:01Z", "user", "x")];
    const incoming = [h("2024-01-01T00:00:01Z", "assistant", "y")];
    const { merged } = mergeHistoryEntries(base, incoming);
    expect(merged).toHaveLength(2);
  });

  it("is idempotent", () => {
    const base = [h("2024-01-01T00:00:01Z", "user", "a")];
    const incoming = [h("2024-01-01T00:00:02Z", "assistant", "b")];
    const first = mergeHistoryEntries(base, incoming).merged;
    const second = mergeHistoryEntries(first, incoming).merged;
    expect(second).toHaveLength(2);
    expect(mergeHistoryEntries(first, incoming).added).toBe(0);
  });

  it("caps to HISTORY_MERGE_LIMIT keeping the most recent", () => {
    const many: HistoryEntry[] = [];
    for (let i = 0; i < HISTORY_MERGE_LIMIT + 30; i++) {
      const at = new Date(1_700_000_000_000 + i * 1000).toISOString();
      many.push(h(at, "user", `m${i}`));
    }
    const { merged } = mergeHistoryEntries([], many);
    expect(merged).toHaveLength(HISTORY_MERGE_LIMIT);
    expect(merged[merged.length - 1].content).toBe(`m${HISTORY_MERGE_LIMIT + 29}`);
  });
});
