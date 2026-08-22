import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dataDir: "",
  ragReady: true,
  embeddingProviderAvailable: true,
  judgeRecentTurns: vi.fn(),
  entries: [] as Array<{ id: string; text: string; embedding: number[]; metadata: Record<string, unknown> }>,
  recordL2RecallsBatch: vi.fn(async () => 1),
  writeMemory: vi.fn(async () => undefined),
}));

vi.mock("../runtime/runtime-paths", () => ({
  getUserDataDir: () => mocks.dataDir,
}));
vi.mock("../rag", () => ({
  getEntriesBySource: () => mocks.entries,
  isUserMemoryVectorStoreReady: () => mocks.ragReady,
}));
vi.mock("../rag/embedding", () => ({
  getEmbeddingProvider: () => mocks.embeddingProviderAvailable ? { embed: vi.fn(async () => [1]) } : null,
}));
vi.mock("./memory-judge", () => ({
  memoryJudge: { judgeRecentTurns: mocks.judgeRecentTurns },
}));
vi.mock("./memory-manager", () => ({
  memoryManager: { writeMemory: mocks.writeMemory },
}));
vi.mock("./memory-store", () => ({
  memoryStore: { recordL2RecallsBatch: mocks.recordL2RecallsBatch },
}));

import { backfillL2FromChatLogs } from "./memory-backfill";

const REAL_CHAT_DIR = "C:/Users/ASUS/AppData/Roaming/live2d-cyrene/cyrene-chats";

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
    mocks.judgeRecentTurns.mockReset();
    mocks.recordL2RecallsBatch.mockClear();
    mocks.writeMemory.mockReset();
    mocks.writeMemory.mockResolvedValue(undefined);
  });

  afterEach(() => {
    fs.rmSync(mocks.dataDir, { recursive: true, force: true });
  });

  it("does not replay newer chat turns after the one-time backfill is complete", async () => {
    fs.writeFileSync(path.join(mocks.dataDir, ".l2-backfill-v4"), JSON.stringify({ complete: true, coveredUntilTs: 5000 }), "utf8");
    writeChatIndex(["chat-1"]);
    fs.writeFileSync(path.join(mocks.dataDir, "cyrene-chats", "sessions", "chat-1.json"), JSON.stringify({
      messages: [
        { role: "user", content: "明天考试", at: 6000 },
        { role: "model", content: "我会陪你复习", at: 7000 },
      ],
    }), "utf8");

    await expect(backfillL2FromChatLogs()).resolves.toEqual({ complete: true, reason: "already_complete" });
    expect(mocks.judgeRecentTurns).not.toHaveBeenCalled();
  });

  it("only replays turns after the watermark and advances it on success", async () => {
    fs.writeFileSync(path.join(mocks.dataDir, ".l2-backfill-v4"), JSON.stringify({ complete: false, coveredUntilTs: 1500 }), "utf8");
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
    expect(marker.coveredUntilTs).toBe(3000);
  });

  it("does not replay the same user turn after its assistant reply is appended", async () => {
    writeChatIndex(["chat-1"]);
    const sessionPath = path.join(mocks.dataDir, "cyrene-chats", "sessions", "chat-1.json");
    fs.writeFileSync(sessionPath, JSON.stringify({
      messages: [{ role: "user", content: "帮我看看 MC 三层架构", at: 1000 }],
    }), "utf8");
    mocks.judgeRecentTurns.mockResolvedValue([]);

    await expect(backfillL2FromChatLogs()).resolves.toEqual({ complete: true });
    expect(mocks.judgeRecentTurns).toHaveBeenCalledTimes(1);

    fs.writeFileSync(sessionPath, JSON.stringify({
      messages: [
        { role: "user", content: "帮我看看 MC 三层架构", at: 1000 },
        { role: "model", content: "可以从职责边界开始检查", at: 2000 },
      ],
    }), "utf8");
    mocks.judgeRecentTurns.mockClear();

    await expect(backfillL2FromChatLogs()).resolves.toEqual({ complete: true, reason: "already_complete" });
    expect(mocks.judgeRecentTurns).not.toHaveBeenCalled();
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

    await expect(backfillL2FromChatLogs()).resolves.toEqual({ complete: true, reason: "already_complete" });
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

  it("tracks progress per session so a newer successful session cannot skip an older failed one", async () => {
    writeChatIndex(["newer", "older"]);
    fs.writeFileSync(path.join(mocks.dataDir, "cyrene-chats", "sessions", "newer.json"), JSON.stringify({
      messages: [
        { role: "user", content: "较新的事实", at: 4000 },
        { role: "model", content: "较新的回复", at: 5000 },
      ],
    }), "utf8");
    fs.writeFileSync(path.join(mocks.dataDir, "cyrene-chats", "sessions", "older.json"), JSON.stringify({
      messages: [
        { role: "user", content: "较早的事实", at: 1000 },
        { role: "model", content: "较早的回复", at: 2000 },
      ],
    }), "utf8");
    mocks.judgeRecentTurns
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error("temporary failure"));

    await expect(backfillL2FromChatLogs()).resolves.toEqual({ complete: false, reason: "batch_failed" });
    const failedMarker = JSON.parse(fs.readFileSync(path.join(mocks.dataDir, ".l2-backfill-v4"), "utf8"));
    expect(failedMarker.sessionOffsets).toEqual({ newer: 4000 });

    mocks.judgeRecentTurns.mockReset();
    mocks.judgeRecentTurns.mockResolvedValue([]);
    await expect(backfillL2FromChatLogs()).resolves.toEqual({ complete: true });
    expect(mocks.judgeRecentTurns).toHaveBeenCalledTimes(1);
    expect(mocks.judgeRecentTurns.mock.calls[0][0]).toEqual([{ userInput: "较早的事实", assistantReply: "较早的回复" }]);
  });

  it("does not advance a session after an L2 write fails", async () => {
    writeChatIndex(["chat-1"]);
    fs.writeFileSync(path.join(mocks.dataDir, "cyrene-chats", "sessions", "chat-1.json"), JSON.stringify({
      messages: [
        { role: "user", content: "必须保留的事实", at: 1000 },
        { role: "model", content: "收到", at: 2000 },
      ],
    }), "utf8");
    mocks.judgeRecentTurns.mockResolvedValue([{
      layer: "L2", content: "用户有必须保留的事实", confidence: 0.9, triggerText: "必须保留的事实",
    }]);
    mocks.writeMemory.mockRejectedValueOnce(new Error("disk full"));

    await expect(backfillL2FromChatLogs()).resolves.toEqual({ complete: false, reason: "batch_failed" });
    const failedMarker = JSON.parse(fs.readFileSync(path.join(mocks.dataDir, ".l2-backfill-v4"), "utf8"));
    expect(failedMarker.sessionOffsets ?? {}).toEqual({});

    mocks.writeMemory.mockResolvedValue(undefined);
    await expect(backfillL2FromChatLogs()).resolves.toEqual({ complete: true });
    expect(mocks.writeMemory).toHaveBeenCalledTimes(2);
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
      expect(marker.coveredUntilTs).toBe(1000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("only treats an exactly repeated summary as an idempotent replay", async () => {
    writeChatIndex(["chat-1"]);
    fs.writeFileSync(path.join(mocks.dataDir, "cyrene-chats", "sessions", "chat-1.json"), JSON.stringify({
      messages: [
        { role: "user", content: "我还是喜欢跑步", at: 1000 },
        { role: "model", content: "嗯，记得的", at: 2000 },
      ],
    }), "utf8");
    mocks.entries.push({ id: "rag_old", text: "用户喜欢跑步", embedding: [1], metadata: { l2Id: "l2_old" } });
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

  it("does not drop a semantically similar summary that adds a new preference", async () => {
    writeChatIndex(["chat-1"]);
    fs.writeFileSync(path.join(mocks.dataDir, "cyrene-chats", "sessions", "chat-1.json"), JSON.stringify({
      messages: [
        { role: "user", content: "我也喜欢榛子口味", at: 1000 },
        { role: "model", content: "记下啦", at: 2000 },
      ],
    }), "utf8");
    mocks.entries.push({
      id: "rag_old",
      text: "用户表示喜欢草莓、香草口味的甜品，尤其是这些口味的冰激凌",
      embedding: [1],
      metadata: { l2Id: "l2_old" },
    });
    mocks.judgeRecentTurns.mockResolvedValue([{
      layer: "L2",
      content: "用户表示喜欢草莓、香草、榛子口味的甜品，尤其是这些口味的冰激凌",
      confidence: 0.95,
      triggerText: "我也喜欢榛子口味",
    }]);
    const { memoryManager } = await import("./memory-manager");

    await expect(backfillL2FromChatLogs()).resolves.toEqual({ complete: true });

    expect(memoryManager.writeMemory).toHaveBeenCalledWith([expect.objectContaining({
      content: "用户表示喜欢草莓、香草、榛子口味的甜品，尤其是这些口味的冰激凌",
    })]);
    expect(mocks.recordL2RecallsBatch).not.toHaveBeenCalled();
  });
});

describe.skipIf(!fs.existsSync(path.join(REAL_CHAT_DIR, "index.json")))("real chat backfill simulation (read-only copy)", () => {
  beforeEach(() => {
    mocks.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-l2-backfill-real-"));
    mocks.ragReady = true;
    mocks.embeddingProviderAvailable = true;
    mocks.entries = [];
    mocks.judgeRecentTurns.mockReset();
    mocks.writeMemory.mockReset();
    mocks.writeMemory.mockResolvedValue(undefined);
  });

  afterEach(() => {
    fs.rmSync(mocks.dataDir, { recursive: true, force: true });
  });

  it("retries the older real turn after a newer copied segment succeeds", async () => {
    const index = JSON.parse(fs.readFileSync(path.join(REAL_CHAT_DIR, "index.json"), "utf8")) as Array<{ id?: string }>;
    const sourceId = index.find((item) => item.id)?.id;
    if (!sourceId) return;
    const source = JSON.parse(fs.readFileSync(path.join(REAL_CHAT_DIR, "sessions", `${sourceId}.json`), "utf8")) as {
      messages?: Array<{ role?: string; content?: unknown; at?: unknown }>;
    };
    const pairs: Array<Array<{ role: string; content: string; at: number }>> = [];
    let pending: { role: string; content: string; at: number } | undefined;
    for (const message of source.messages ?? []) {
      if (message.role === "user" && typeof message.content === "string" && typeof message.at === "number") {
        pending = { role: "user", content: message.content, at: message.at };
      } else if (pending && (message.role === "model" || message.role === "assistant")
        && typeof message.content === "string" && typeof message.at === "number") {
        pairs.push([pending, { role: "model", content: message.content, at: message.at }]);
        pending = undefined;
      }
    }
    if (pairs.length < 2) return;
    const older = pairs[0];
    const newer = pairs[pairs.length - 1];
    writeChatIndex(["real-newer-copy", "real-older-copy"]);
    fs.writeFileSync(path.join(mocks.dataDir, "cyrene-chats", "sessions", "real-newer-copy.json"), JSON.stringify({ messages: newer }), "utf8");
    fs.writeFileSync(path.join(mocks.dataDir, "cyrene-chats", "sessions", "real-older-copy.json"), JSON.stringify({ messages: older }), "utf8");
    mocks.judgeRecentTurns.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error("simulated interruption"));

    await expect(backfillL2FromChatLogs()).resolves.toEqual({ complete: false, reason: "batch_failed" });
    mocks.judgeRecentTurns.mockReset();
    mocks.judgeRecentTurns.mockResolvedValue([]);
    await expect(backfillL2FromChatLogs()).resolves.toEqual({ complete: true });

    expect(mocks.judgeRecentTurns).toHaveBeenCalledTimes(1);
    expect(mocks.judgeRecentTurns.mock.calls[0][0][0].userInput).toBe(older[0].content);
  });
});
