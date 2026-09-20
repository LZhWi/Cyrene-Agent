import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockPluginContext } from "@playa0v0/cyrene-plugin-sdk/testing";
import type { PluginStorage } from "@playa0v0/cyrene-plugin-sdk";
import { createEmbeddingService, DEFAULT_EMBEDDING_CONFIG, embeddingEndpoint } from "../plugins/companion-memory/src/embedding";
import { createVectorIndex, defaultLegacyVectorPath, previewLegacyVectorFile } from "../plugins/companion-memory/src/vector-index";
import { createLegacyImportPlan, defaultLegacyMemoryPath, previewLegacyMemoryFile } from "../plugins/companion-memory/src/legacy-import";

function storage() {
  const map = new Map<string, any>();
  const value: PluginStorage = { get: (key) => structuredClone(map.get(key)), set: (key, data) => { map.set(key, structuredClone(data)); }, rootDir: () => "unused" };
  return { value, map };
}
const signal = () => new AbortController().signal;
const temporaryDirectories: string[] = [];
function temporaryDirectory(prefix: string): string {
  const parent = path.resolve(".test-runtime");
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(path.join(parent, prefix));
  temporaryDirectories.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("独立 Embedding Provider", () => {
  it("默认关闭，不发请求；只接受 HTTPS 或本机 HTTP", async () => {
    const fetcher = vi.fn(), service = createEmbeddingService(createMockPluginContext(), fetcher);
    expect(await service.view()).toMatchObject(DEFAULT_EMBEDDING_CONFIG);
    await expect(service.embed("查询", signal())).rejects.toThrow("尚未启用"); expect(fetcher).not.toHaveBeenCalled();
    expect(embeddingEndpoint("https://example.invalid/v1/")).toBe("https://example.invalid/v1/embeddings");
    expect(embeddingEndpoint("http://localhost:8080/v1")).toBe("http://localhost:8080/v1/embeddings");
    for (const url of ["http://example.com/v1", "https://u:p@example.com", "file:///tmp/model", "https://example.com?v=secret"]) expect(() => embeddingEndpoint(url)).toThrow();
  });
  it("密钥只存官方 Secrets，地址变化不复用旧密钥，错误不回显服务端正文", async () => {
    let key = "";
    const ctx = createMockPluginContext({ deps: { secrets: { get: async () => key || undefined, set: async (_k, value) => { key = value; }, delete: async () => false } } });
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ embedding: [1, 0, 0].concat(Array(61).fill(0)) }] }) });
    const service = createEmbeddingService(ctx, fetcher);
    const config = { enabled: true, baseUrl: "https://example.invalid/v1", model: "embed-test", dimensions: 64, apiKey: "fake-secret" };
    await service.save(config); await service.save({ ...config, apiKey: "" });
    expect(JSON.stringify(ctx.storage.get("embedding-config"))).not.toContain("fake-secret");
    expect(JSON.stringify(await service.view())).not.toContain("fake-secret");
    expect((await service.embed("只发送这段查询", signal())).length).toBe(64);
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBe("Bearer fake-secret");
    expect(fetcher.mock.calls[0][1].body).toContain("只发送这段查询");
    await expect(service.save({ ...config, baseUrl: "https://other.invalid/v1", apiKey: "" })).rejects.toThrow("旧密钥");
    fetcher.mockResolvedValue({ ok: false, status: 400, json: async () => ({ secret: "server-secret" }) });
    await expect(service.embed("查询", signal())).rejects.not.toThrow("server-secret");
  });
});

describe("旧 user_memory 向量只读迁移", () => {
  it("只接受匹配 L2 的 user_memory，不复制 chat_history 或正文", () => {
    const dir = temporaryDirectory("vectors-");
    const file = path.join(dir, "memory-store.json"), vectorA = [1, ...Array(63).fill(0)], vectorB = [0, 1, ...Array(62).fill(0)];
    const source = [
      { id: "chat", text: "不应复制的聊天正文", source: "chat_history", embedding: vectorA, metadata: { sessionId: "s" } },
      { id: "v1", text: "也不进入插件索引", source: "user_memory", embedding: vectorA, metadata: { l2Id: "m1" } },
      { id: "v2", text: "未匹配", source: "user_memory", embedding: vectorB, metadata: { l2Id: "missing" } },
    ];
    writeFileSync(file, JSON.stringify(source)); const before = readFileSync(file);
    const preview = previewLegacyVectorFile(file, ["m1"]);
    expect(preview).toMatchObject({ total: 3, userMemory: 2, usable: 1, unmatchedL2Ids: 1, dimensions: [64], canImport: true });
    expect(JSON.stringify(preview)).not.toContain("聊天正文"); expect(readFileSync(file).equals(before)).toBe(true);
    const data = storage(), index = createVectorIndex(data.value), result = index.importLegacy(file, preview.sourceHash, ["m1"]);
    expect(result).toMatchObject({ imported: true, entries: 1, dimensions: 64 });
    expect(index.search(vectorA, ["m1"])).toEqual(["m1"]);
    const saved = JSON.stringify(data.map.get("vector-index"));
    expect(saved).not.toContain("不应复制"); expect(saved).not.toContain("也不进入"); expect(saved).not.toContain("chat_history");
    expect(data.map.get("vector-index-pre-legacy-import-backup")).toEqual({ version: 1, entries: [] });
    expect(() => index.importLegacy(file, preview.sourceHash, ["m1"])).toThrow("拒绝覆盖");
  });
  it("哈希变化、重复 L2、混合维度或损坏向量关闭门禁", () => {
    const dir = temporaryDirectory("vectors-invalid-"), file = path.join(dir, "memory-store.json");
    writeFileSync(file, JSON.stringify([
      { source: "user_memory", embedding: Array(64).fill(1), metadata: { l2Id: "m1" } },
      { source: "user_memory", embedding: Array(65).fill(1), metadata: { l2Id: "m1" } },
      { source: "user_memory", embedding: [NaN], metadata: { l2Id: "m2" } },
    ]));
    const preview = previewLegacyVectorFile(file, ["m1", "m2"]);
    expect(preview).toMatchObject({ invalid: 1, duplicateL2Ids: 1, dimensions: [64, 65], canImport: false });
  });
  it("已有新摘要向量时仍可导入同维旧索引，并保留当前摘要版本", () => {
    const dir = temporaryDirectory("vectors-mixed-"), file = path.join(dir, "memory-store.json");
    const legacy = [0, 1, ...Array(62).fill(0)], generated = [1, ...Array(63).fill(0)];
    writeFileSync(file, JSON.stringify([
      { source: "user_memory", embedding: legacy, metadata: { l2Id: "m1" } },
      { source: "user_memory", embedding: legacy, metadata: { l2Id: "m2" } },
    ]));
    const data = storage(), index = createVectorIndex(data.value);
    index.upsertGenerated([{ l2Id: "m1", embedding: generated, contentHash: "a".repeat(64) }], 64);
    const preview = previewLegacyVectorFile(file, ["m1", "m2"]);
    expect(index.importLegacy(file, preview.sourceHash, ["m1", "m2"])).toMatchObject({ imported: true, entries: 2, legacyEntries: 1, generatedEntries: 1 });
    expect(index.search(generated, ["m1", "m2"])[0]).toBe("m1");
    expect(data.map.get("vector-index-pre-legacy-import-backup")).toMatchObject({ legacy: false, entries: [{ l2Id: "m1", origin: "generated" }] });
  });
  it("相似候选预检只返回允许范围内的高相似向量且不写索引", () => {
    const data = storage(), index = createVectorIndex(data.value);
    const a = [1, ...Array(63).fill(0)], b = [0.99, 0.1, ...Array(62).fill(0)], c = [0, 1, ...Array(62).fill(0)];
    index.upsertGenerated([
      { l2Id: "a", embedding: a, contentHash: "a".repeat(64) },
      { l2Id: "b", embedding: b, contentHash: "b".repeat(64) },
      { l2Id: "c", embedding: c, contentHash: "c".repeat(64) },
    ], 64);
    const before = structuredClone(data.map.get("vector-index"));
    expect(index.relatedPairs(["a", "b", "c"], 0.82)).toMatchObject({ indexed: 3, considered: 3, truncated: false, pairs: [{ leftId: "a", rightId: "b" }] });
    expect(index.relatedPairs(["a", "c"], 0.82).pairs).toEqual([]);
    expect(data.map.get("vector-index")).toEqual(before);
  });
  it("撤销压缩可只移除对应生成向量，不影响旧向量", () => {
    const data = storage(), index = createVectorIndex(data.value), vector = [1, ...Array(63).fill(0)];
    index.upsertGenerated([{ l2Id: "summary", embedding: vector, contentHash: "a".repeat(64) }, { l2Id: "other", embedding: vector, contentHash: "b".repeat(64) }], 64);
    expect(index.removeGenerated("summary")).toMatchObject({ entries: 1, generatedEntries: 1 });
    expect(index.generatedHash("summary")).toBeUndefined(); expect(index.generatedHash("other")).toBe("b".repeat(64));
  });
});

it.runIf(process.env.CYRENE_READONLY_VECTOR_PREVIEW_TEST === "1")("真实向量文件只读聚合预检", () => {
  const vectorFile = defaultLegacyVectorPath(), memoryFile = defaultLegacyMemoryPath();
  const digest = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
  const beforeVector = digest(vectorFile), beforeMemory = digest(memoryFile);
  const memoryPreview = previewLegacyMemoryFile(memoryFile), memoryPlan = createLegacyImportPlan(memoryFile, memoryPreview.sourceHash);
  const preview = previewLegacyVectorFile(vectorFile, memoryPlan.entries.map((entry) => entry.id));
  expect(digest(vectorFile)).toBe(beforeVector); expect(digest(memoryFile)).toBe(beforeMemory);
  console.log("READONLY_VECTOR_PREVIEW_SUMMARY " + JSON.stringify({ total: preview.total, userMemory: preview.userMemory, usable: preview.usable, unmatchedL2Ids: preview.unmatchedL2Ids, dimensions: preview.dimensions, invalid: preview.invalid, duplicateL2Ids: preview.duplicateL2Ids, canImport: preview.canImport, sourceWrites: 0, modelRequests: 0, accessUpdates: 0, dmaeCalls: 0 }));
});
