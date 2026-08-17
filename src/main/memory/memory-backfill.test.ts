import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dataDir: "",
  ragReady: true,
  embeddingProviderAvailable: true,
  judgeRecentTurns: vi.fn(),
  entries: [] as Array<{ id: string; embedding: number[]; metadata: Record<string, unknown> }>,
  cosine: 0,
  recordL2RecallsBatch: vi.fn(async () => 1),
}));

vi.mock("../runtime/runtime-paths", () => ({
  getUserDataDir: () => mocks.dataDir,
}));
vi.mock("../rag", () => ({
  getEntriesBySource: () => mocks.entries,
  isUserMemoryVectorStoreReady: () => mocks.ragReady,
}));
vi.mock("../rag/vectorstore", () => ({
  cosineSimilarity: () => mocks.cosine,
}));
vi.mock("../rag/embedding", () => ({
  getEmbeddingProvider: () => mocks.embeddingProviderAvailable ? { embed: vi.fn(async () => [1]) } : null,
}));
vi.mock("./memory-judge", () => ({
  memoryJudge: { judgeRecentTurns: mocks.judgeRecentTurns },
}));
vi.mock("./memory-manager", () => ({
  memoryManager: { writeMemory: vi.fn(async () => undefined) },
}));
vi.mock("./memory-store", () => ({
  memoryStore: { recordL2RecallsBatch: mocks.recordL2RecallsBatch },
}));

import { backfillL2FromChatLogs } from "./memory-backfill";

function writeChatIndex(sessionIds: string[]): void {
  const chatDir = path.join(mocks.dataDir, "cyrene-chats");
  fs.mkdirSync(path.join(chatDir, "sessions"), { recursive: true });
  fs.writeFileSync(
    path.join(chatDir, "index.json"),
    JSON.stringify(sessionIds.map((id) => ({ id }))),
    "utf8",
  );
}

describe("backfillL2FromChatLogs completion state", () => {
  beforeEach(() => {
    mocks.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-l2-backfill-"));
    mocks.ragReady = true;
    mocks.embeddingProviderAvailable = true;
    mocks.entries = [];
    mocks.cosine = 0;
    mocks.judgeRecentTurns.mockReset();
    mocks.recordL2RecallsBatch.mockClear();
  });

  afterEach(() => {
    fs.rmSync(mocks.dataDir, { recursive: true, force: true });
  });

  it("reports already_complete when the watermark covers every turn", async () => {
    fs.writeFileSync(path.join(mocks.dataDir, ".l2-backfill-v4"), JSON.stringify({ complete: true, coveredUntilTs: 5000 }), "utf8");
    writeChatIndex(["chat-1"]);
    fs.writeFileSync(path.join(mocks.dataDir, "cyrene-chats", "sessions", "chat-1.json"), JSON.stringify({
      messages: [
        { role: "user", content: "明天考试", at: 1000 },
        { role: "model", content: "我会陪你复习", at: 2000 },
      ],
    }), "utf8");

    await expect(backfillL2FromChatLogs()).resolves.toEqual({ complete: true, reason: "already_complete" });
    expect(mocks.judgeRecentTurns).not.toHaveBeenCalled();
  });

  it("only replays turns after the watermark and advances it on success", async () => {
    fs.writeFileSync(path.join(mocks.dataDir, ".l2-backfill-v4"), JSON.stringify({ complete: true, coveredUntilTs: 1500 }), "utf8");
    writeChatIndex(["chat-1"]);
    fs.writeFileSync(path.join(mocks.dataDir, "cyrene-chats", "sessions", "chat-1.json"), JSON.stringify({
      messages: [
        { role: "user", content: "旧话题", at: 1000 },
        { role: "model", content: "旧回复", at: 1200 },
        { role: "user", content: "新话题", at: 3000 },
        { role: "model", content: "新回复", at: 4000 },
      ],
    }), "utf8");
    mocks.judgeRecentTurns.mockResolvedValue([]);

    await expect(backfillL2FromChatLogs()).resolves.toEqual({ complete: true });
    expect(mocks.judgeRecentTurns).toHaveBeenCalledTimes(1);
    expect(mocks.judgeRecentTurns.mock.calls[0][0]).toEqual([{ userInput: "新话题", assistantReply: "新回复" }]);
    const marker = JSON.parse(fs.readFileSync(path.join(mocks.dataDir, ".l2-backfill-v4"), "utf8"));
    expect(marker.complete).toBe(true);
    expect(marker.coveredUntilTs).toBe(4000);
  });

  it("inherits the v3 completion time as the initial watermark", async () => {
    fs.writeFileSync(path.join(mocks.dataDir, ".l2-backfill-v3"), JSON.stringify({ complete: true, at: 5000 }), "utf8");
    writeChatIndex(["chat-1"]);
    fs.writeFileSync(path.join(mocks.dataDir, "cyrene-chats", "sessions", "chat-1.json"), JSON.stringify({
      messages: [
        { role: "user", content: "明天考试", at: 1000 },
        { role: "model", content: "我会陪你复习", at: 2000 },
      ],
    }), "utf8");

    await expect(backfillL2FromChatLogs()).resolves.toEqual({ complete: true });
    expect(mocks.judgeRecentTurns).not.toHaveBeenCalled();
    const marker = JSON.parse(fs.readFileSync(path.join(mocks.dataDir, ".l2-backfill-v4"), "utf8"));
    expect(marker.coveredUntilTs).toBe(5000);
  });

  it("does not report completion while RAG is unavailable", async () => {
    writeChatIndex([]);
    mocks.ragReady = false;

    await expect(backfillL2FromChatLogs()).resolves.toEqual({ complete: false, reason: "rag_unavailable" });
  });

  it("keeps a failed batch incomplete so catch-up is not eligible", async () => {
    writeChatIndex(["chat-1"]);
    fs.writeFileSync(path.join(mocks.dataDir, "cyrene-chats", "sessions", "chat-1.json"), JSON.stringify({
      messages: [
        { role: "user", content: "明天考试", at: 1000 },
        { role: "model", content: "我会陪你复习", at: 2000 },
      ],
    }), "utf8");
    mocks.judgeRecentTurns.mockRejectedValueOnce(new Error("temporary failure"));

    await expect(backfillL2FromChatLogs()).resolves.toEqual({ complete: false, reason: "batch_failed" });
    const marker = JSON.parse(fs.readFileSync(path.join(mocks.dataDir, ".l2-backfill-v4"), "utf8"));
    expect(marker.complete).toBe(false);
    expect(marker.coveredUntilTs).toBe(0);
  });

  it("reports completion after all sessions finish", async () => {
    writeChatIndex([]);

    await expect(backfillL2FromChatLogs()).resolves.toEqual({ complete: true });
    expect(JSON.parse(fs.readFileSync(path.join(mocks.dataDir, ".l2-backfill-v4"), "utf8")).complete).toBe(true);
  });

  it("routes batches through the LLM queue and retries once on rate limit", async () => {
    // 真实场景：回填与聊天并发打同一 key 撞 RPM 限流。批次须走 llm-queue，
    // 获得"限流 → 5s 退避 → 重试一次"的保护，而非直接失败整段回填。
    vi.useFakeTimers();
    try {
      writeChatIndex(["chat-1"]);
      fs.writeFileSync(path.join(mocks.dataDir, "cyrene-chats", "sessions", "chat-1.json"), JSON.stringify({
        messages: [
          { role: "user", content: "明天考试", at: 1000 },
          { role: "model", content: "我会陪你复习", at: 2000 },
        ],
      }), "utf8");
      mocks.judgeRecentTurns
        .mockRejectedValueOnce(new Error("429 rate limit exceeded"))
        .mockResolvedValueOnce([]);

      const resultPromise = backfillL2FromChatLogs();
      // 快进退避等待（llm-queue RETRY_DELAY_MS = 5s）
      await vi.advanceTimersByTimeAsync(6000);
      await expect(resultPromise).resolves.toEqual({ complete: true });
      expect(mocks.judgeRecentTurns).toHaveBeenCalledTimes(2);
      const marker = JSON.parse(fs.readFileSync(path.join(mocks.dataDir, ".l2-backfill-v4"), "utf8"));
      expect(marker.complete).toBe(true);
      expect(marker.coveredUntilTs).toBe(2000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats a dedup hit as a recall and refreshes the matched memory's stats", async () => {
    // 真实场景：旧事实在历史轮次里被重述，候选与既有（可能是 aging）条目判重命中。
    // 不能只吞掉候选——重述本身就是召回信号，应刷新既有条目统计，防其卡在降级态。
    writeChatIndex(["chat-1"]);
    fs.writeFileSync(path.join(mocks.dataDir, "cyrene-chats", "sessions", "chat-1.json"), JSON.stringify({
      messages: [
        { role: "user", content: "我还是喜欢跑步", at: 1000 },
        { role: "model", content: "嗯，记得的", at: 2000 },
      ],
    }), "utf8");
    mocks.entries.push({ id: "rag_old", embedding: [1], metadata: { l2Id: "l2_old" } });
    mocks.cosine = 0.95;
    mocks.judgeRecentTurns.mockResolvedValue([{
      layer: "L2",
      content: "用户喜欢跑步",
      confidence: 0.9,
      triggerText: "我还是喜欢跑步",
    }]);
    const { memoryManager } = await import("./memory-manager");

    await expect(backfillL2FromChatLogs()).resolves.toEqual({ complete: true });

    expect(memoryManager.writeMemory).not.toHaveBeenCalled(); // 重复候选不写入
    expect(mocks.recordL2RecallsBatch).toHaveBeenCalledWith(["l2_old"]); // 但刷了既有条目
  });
});
