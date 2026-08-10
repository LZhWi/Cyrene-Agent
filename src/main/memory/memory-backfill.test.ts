import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dataDir: "",
  ragReady: true,
  embeddingProviderAvailable: true,
  judgeRecentTurns: vi.fn(),
}));

vi.mock("../runtime/runtime-paths", () => ({
  getUserDataDir: () => mocks.dataDir,
}));
vi.mock("../rag", () => ({
  getEntriesBySource: () => [],
  isUserMemoryVectorStoreReady: () => mocks.ragReady,
}));
vi.mock("../rag/vectorstore", () => ({
  cosineSimilarity: () => 0,
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
    mocks.judgeRecentTurns.mockReset();
  });

  afterEach(() => {
    fs.rmSync(mocks.dataDir, { recursive: true, force: true });
  });

  it("reports an existing complete marker as complete", async () => {
    fs.writeFileSync(path.join(mocks.dataDir, ".l2-backfill-v3"), JSON.stringify({ complete: true }), "utf8");

    await expect(backfillL2FromChatLogs()).resolves.toEqual({ complete: true, reason: "already_complete" });
    expect(mocks.judgeRecentTurns).not.toHaveBeenCalled();
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
    expect(JSON.parse(fs.readFileSync(path.join(mocks.dataDir, ".l2-backfill-v3"), "utf8")).complete).toBe(false);
  });

  it("reports completion after all sessions finish", async () => {
    writeChatIndex([]);

    await expect(backfillL2FromChatLogs()).resolves.toEqual({ complete: true });
    expect(JSON.parse(fs.readFileSync(path.join(mocks.dataDir, ".l2-backfill-v3"), "utf8")).complete).toBe(true);
  });
});
