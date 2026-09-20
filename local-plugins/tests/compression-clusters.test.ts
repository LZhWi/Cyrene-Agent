import { describe, expect, it } from "vitest";
import { findCompressionClusters } from "../plugins/companion-memory/src/compression-clusters";

const make = (id: string, patch: Record<string, unknown> = {}) => ({ id, content: `记忆${id}`, quote: id, sourceAt: 1, turnId: id, sessionId: "s", pinned: false, status: "aging" as const, ...patch });

describe("aging 压缩聚类只读候选", () => {
  it("只用种子相似边形成 3 至 5 条分组并返回最低分", () => {
    const entries = ["a", "b", "c", "d", "e", "f"].map((id) => make(id));
    const pairs = [
      { leftId: "a", rightId: "b", score: 0.95 }, { leftId: "a", rightId: "c", score: 0.9 }, { leftId: "a", rightId: "d", score: 0.85 },
      { leftId: "a", rightId: "e", score: 0.84 }, { leftId: "a", rightId: "f", score: 0.83 },
    ];
    expect(findCompressionClusters(entries, pairs)).toEqual([{ entryIds: ["a", "b", "c", "d", "e"], minimumScore: 0.84 }]);
  });

  it("排除 active、置顶、总结、过期及低阈值边，且不修改输入", () => {
    const entries = [make("a"), make("b"), make("active", { status: "active" }), make("pinned", { pinned: true }), make("summary", { isSummary: true, subEntryIds: ["a"] }), make("expired", { validTo: 0 })];
    const pairs = ["active", "pinned", "summary", "expired"].map((rightId) => ({ leftId: "a", rightId, score: 0.99 })); pairs.push({ leftId: "a", rightId: "b", score: 0.81 });
    const before = structuredClone({ entries, pairs });
    expect(findCompressionClusters(entries as any, pairs)).toEqual([]);
    expect({ entries, pairs }).toEqual(before);
  });
});
