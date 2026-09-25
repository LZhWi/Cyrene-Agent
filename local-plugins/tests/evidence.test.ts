import { describe, expect, it, vi } from "vitest";
import type { PluginStorage } from "@playa0v0/cyrene-plugin-sdk";
import { createMemory } from "../plugins/companion-memory/src/memory";
import { type Evidence, evidenceContext, validateEvidence } from "../plugins/companion-memory/src/evidence";
import { emptyProfiles } from "../plugins/companion-memory/src/profiles";
const record: Evidence = { id: "p1", memoryId: "a", quoteSnippet: "独立线索咖啡豆", sourceStatus: "active", createdAt: 1 };
function fixture(evidence: Evidence[] = [record]) {
  const entry = { id: "a", content: "饮品偏好", quote: "", sourceAt: 1, turnId: "t", sessionId: "s", pinned: false, status: "active" };
  let snapshot: any = { version: 2, revision: 0, turns: [], processed: [], profiles: emptyProfiles(), entries: [entry, { ...entry, id: "b", content: "另条" }], evidence };
  const storage: PluginStorage = { get: (key) => key === "memory-state" ? structuredClone(snapshot) : undefined, set: (key,v) => { if (key === "memory-state") snapshot = structuredClone(v); }, rootDir: () => "unused" };
  return { memory: createMemory(storage), storage, entry };
}
describe("独立证据关联", () => {
  it("片段可召回正确记忆，明确未核对且不填造 quote", () => {
    const { memory } = fixture();
    const result = memory.search("咖啡豆");
    expect(result).toContain("记忆 a；"); expect(result).not.toContain("记忆 b；");
    expect(result).toContain("未核对原始对话"); expect(result).not.toContain("用户原话：");
    expect(memory.view().entries[0].quote).toBe("");
  });
  it("deleted 与孤立证据不召回，archived 片段标注来源归档", () => {
    expect(fixture([{ ...record, sourceStatus: "deleted" }]).memory.search("咖啡豆")).toBe("");
    expect(fixture([{ ...record, memoryId: "unknown" }]).memory.search("咖啡豆")).toBe("");
    expect(fixture([{ ...record, sourceStatus: "archived" }]).memory.search("咖啡豆")).toContain("来源已归档");
  });
  it("有证据也不复活已归档摘要；编辑和重启保持证据不变", () => {
    const { memory, storage, entry } = fixture();
    memory.editEntry({ ...entry, status: "archived", revision: 0 });
    expect(memory.search("咖啡豆")).toBe("");
    expect(createMemory(storage).view().evidence).toEqual([record]);
  });
  it("模型仅收到选中记忆的有限片段；复核保存证据快照", async () => {
    const hidden = { ...record, id: "deleted", quoteSnippet: "不应发送秘密", sourceStatus: "deleted" as const };
    const { memory } = fixture([record, hidden]);
    const generate = vi.fn(async (_p: string) => '{"resolutionType":"uncertain","confidence":0.2,"reason":"待确认","actions":{"createResolvedMemory":false,"shouldAskUser":true,"clarificationNeeded":true}}');
    const review = await memory.reviewEntries({ leftId: "a", rightId: "b", revision: 0 }, generate, new AbortController().signal);
    expect(generate.mock.calls[0][0]).toContain(record.quoteSnippet);
    expect(generate.mock.calls[0][0]).not.toContain(hidden.quoteSnippet);
    expect(review.leftEvidence).toEqual([record]);
  });
  it("限制模型片段数量和长度，存储保留全文", () => {
    const records = Array.from({ length: 5 }, (_, i) => ({ ...record, id: `p${i}`, quoteSnippet: "x".repeat(2000) }));
    const result = evidenceContext(records, "a");
    expect(result.match(/关联证据片段/g)).toHaveLength(3);
    expect(result).not.toContain("x".repeat(1201));
    expect(records[0].quoteSnippet.length).toBe(2000);
  });
  it("证据重复ID、未知状态、错误消息引用拒绝加载", () => {
    expect(() => validateEvidence([record, record])).toThrow("损坏");
    expect(() => validateEvidence([{ ...record, sourceStatus: "unknown" }])).toThrow("损坏");
    expect(() => validateEvidence([{ ...record, messageIds: [1] }])).toThrow("引用");
  });
});
