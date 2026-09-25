import { describe, expect, it, vi } from "vitest";
import { createMockPluginContext } from "@playa0v0/cyrene-plugin-sdk/testing";
import { createMemory } from "../plugins/companion-memory/src/memory";
import { createSemanticIndexer } from "../plugins/companion-memory/src/semantic-indexer";
import { createVectorIndex } from "../plugins/companion-memory/src/vector-index";
import { emptyProfiles } from "../plugins/companion-memory/src/profiles";
import { memoryCandidate } from "./support/memory-candidate";

const vector = () => [1, ...Array(63).fill(0)];
const entry = { id: "m1", content: "原始内容", quote: "原话", sourceAt: 1, turnId: "t", sessionId: "s", pinned: false, status: "active" as const };

function setup(withEntry = false) {
  const ctx = createMockPluginContext();
  if (withEntry) ctx.storage.set("memory-state", { version: 2, revision: 0, turns: [], processed: [], entries: [entry], evidence: [], profiles: emptyProfiles(), profileChanges: [], entryReviews: [] });
  const memory = createMemory(ctx.storage);
  const vectors = createVectorIndex(ctx.storage);
  const embed = vi.fn().mockResolvedValue(vector());
  const indexer = createSemanticIndexer(ctx, memory, { config: { enabled: true, dimensions: 64 }, embed }, vectors);
  return { ctx, memory, vectors, embed, indexer };
}

describe("新记忆增量语义索引", () => {
  it("默认关闭；启用后自动补齐既有可召回记忆的缺失向量", async () => {
    const { indexer, embed, vectors } = setup(true);
    expect(indexer.view()).toMatchObject({ enabled: false, pending: 0, generatedEntries: 0 });
    indexer.configure({ enabled: true });
    await indexer.whenIdle();
    expect(embed).toHaveBeenCalledWith("原始内容", expect.any(AbortSignal));
    expect(vectors.view()).toMatchObject({ entries: 1, generatedEntries: 1 });
  });

  it("启用后的新提取和手动编辑仅发送记忆摘要正文并增量替换向量", async () => {
    const { indexer, memory, embed, vectors } = setup();
    indexer.configure({ enabled: true });
    for (let i = 0; i < 10; i++) memory.ingest({ id: `t${i}`, sessionId: "s", user: `用户${i}`, assistant: "助手", userAt: i + 1, assistantAt: i + 2 });
    await memory.maintain(async () => JSON.stringify([memoryCandidate({
      layer: "L2", field: undefined, summary: "新提取摘要", sourceQuote: "用户0", evidenceQuotes: ["用户0"],
      facets: { primaryKind: "fact", retrievalKinds: ["fact"] },
    })]), new AbortController().signal);
    indexer.memoryChanged(); await indexer.whenIdle();
    expect(embed).toHaveBeenCalledWith("新提取摘要", expect.any(AbortSignal));
    expect(vectors.view()).toMatchObject({ imported: false, generatedEntries: 1, dimensions: 64 });

    const state = memory.view();
    memory.editEntry({ id: state.entries[0].id, content: "手动修改摘要", pinned: false, status: "active", revision: state.revision });
    indexer.memoryChanged(); await indexer.whenIdle();
    expect(embed).toHaveBeenLastCalledWith("手动修改摘要", expect.any(AbortSignal));
    expect(vectors.view()).toMatchObject({ entries: 1, generatedEntries: 1 });
  });

  it("请求失败不推进基线，可由用户重试", async () => {
    const { indexer, memory, embed, vectors } = setup(true);
    indexer.configure({ enabled: true });
    const state = memory.view();
    memory.editEntry({ id: "m1", content: "修改后", pinned: false, status: "active", revision: state.revision });
    embed.mockRejectedValueOnce(new Error("synthetic-secret"));
    indexer.memoryChanged(); await indexer.whenIdle();
    expect(indexer.view()).toMatchObject({ pending: 1, lastError: { kind: "request" } });
    expect(JSON.stringify(indexer.view())).not.toContain("synthetic-secret");
    expect(vectors.view().entries).toBe(0);
    indexer.retry(); await indexer.whenIdle();
    expect(indexer.view()).toMatchObject({ pending: 0, lastError: undefined });
    expect(vectors.view().generatedEntries).toBe(1);
  });

  it("关闭授权后拒绝迟到向量写入", async () => {
    let resolve!: (value: number[]) => void;
    const { indexer, embed, vectors } = setup(true);
    embed.mockImplementationOnce(() => new Promise<number[]>((done) => { resolve = done; }));
    indexer.configure({ enabled: true });
    await vi.waitFor(() => expect(embed).toHaveBeenCalled());
    indexer.configure({ enabled: false });
    resolve(vector());
    await indexer.whenIdle();
    expect(vectors.view().entries).toBe(0);
    expect(indexer.view()).toMatchObject({ enabled: false, pending: 0 });
  });

  it("自动补齐后只读预检不再报告缺失摘要", async () => {
    const { indexer, embed, vectors } = setup(true);
    indexer.configure({ enabled: true });
    await indexer.whenIdle();
    const preview = indexer.previewBackfill();
    expect(preview).toMatchObject({ eligible: 1, alreadyCurrent: 1, missing: 0, maxSelection: 100 });
    expect(preview.entries).toEqual([]);
    expect(embed).toHaveBeenCalledTimes(1);
    expect(embed).toHaveBeenCalledWith("原始内容", expect.any(AbortSignal));
    expect(vectors.view()).toMatchObject({ generatedEntries: 1 });
  });

  it("补建诊断预检后记忆发生变化会拒绝旧选择", async () => {
    const { indexer, memory, embed } = setup(true);
    embed.mockRejectedValueOnce(new Error("synthetic"));
    indexer.configure({ enabled: true });
    await indexer.whenIdle();
    const preview = indexer.previewBackfill();
    const state = memory.view();
    memory.editEntry({ id: "m1", content: "预检后变化", pinned: false, status: "active", revision: state.revision });
    expect(() => indexer.applyBackfill({ previewId: preview.id, entryIds: ["m1"] })).toThrow("记忆自预检后已变化");
    expect(embed).toHaveBeenCalledTimes(1);
  });
});
