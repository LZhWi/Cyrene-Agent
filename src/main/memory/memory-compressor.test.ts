import { beforeEach, describe, expect, it, vi } from "vitest";
import type { L2Memory } from "./memory-types";

const mocks = vi.hoisted(() => ({ memories: [] as L2Memory[], generate: vi.fn(), commit: vi.fn() }));
vi.mock("./memory-store", () => ({ memoryStore: {
  getAllL2: async () => mocks.memories, getL0: async () => ({}), getL1: async () => ({}),
  appendReflectionLog: vi.fn(),
} }));
vi.mock("../rag/index", () => ({
  getEntriesBySource: () => mocks.memories.map(m => ({ id: m.ragId, embedding: [1, 0] })),
  addL2MemoryVector: vi.fn(), deleteUserMemoryVectors: vi.fn(),
}));
vi.mock("./memory-llm-client", () => ({ invokeMemoryLlm: mocks.generate,
  invokeMemoryStructuredOutput: async () => [], getDefaultMaxOutputTokens: () => 1024 }));
vi.mock("./memory-manager", () => ({ resolveL1Field: vi.fn() }));
vi.mock("./memory-compression-transaction", () => ({ commitMemoryCompression: mocks.commit }));
import { runMemoryCompression } from "./memory-compressor";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.memories = [100, 200, 50].map((createdAt, i) => ({ id: `m${i}`, content: `系列事实 ${i}`, triggerText: "原话",
    sourceConversationId: "s", createdAt, lastAccessedAt: createdAt, accessCount: 0, weight: 0, isPinned: false,
    status: "active", ragId: `rag${i}`, ...(i === 0 ? { sourceAt: 80, sourceEndAt: 500 } : {}) }));
});

describe("原生压缩的事件关系准入", () => {
  it.each(["unrelated", "uncertain", "similar_topic", "invalid"])("%s 不请求摘要或写记忆", async relation => {
    mocks.generate.mockResolvedValue({ text: relation === "invalid" ? "格式错误" : JSON.stringify({ relation, reason: "关系不明确" }) });
    await runMemoryCompression();
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    expect(mocks.commit).not.toHaveBeenCalled();
  });

  it.each(["same_event", "same_series"])("确认 %s 后才合并并保留来源时间范围", async relation => {
    mocks.generate.mockResolvedValueOnce({ text: JSON.stringify({ relation, reason: "同一具体系列" }) })
      .mockResolvedValueOnce({ text: "同一系列的完整总结。" });
    await runMemoryCompression();
    expect(mocks.generate).toHaveBeenCalledTimes(2);
    expect(mocks.commit).toHaveBeenCalledWith(expect.objectContaining({ sourceAt: 50, sourceEndAt: 500 }), expect.anything());
  });
});
