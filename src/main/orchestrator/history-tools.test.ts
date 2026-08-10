import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const mocks = vi.hoisted(() => ({
  dataDir: "",
  addHistoryMemory: vi.fn(),
  deleteHistoryEntriesBySessionId: vi.fn(),
  getEntriesBySource: vi.fn(() => [{}]),
}));

vi.mock("../runtime/runtime-paths", () => ({
  getUserDataDir: () => mocks.dataDir,
}));

vi.mock("../rag", () => ({
  addHistoryMemory: mocks.addHistoryMemory,
  deleteHistoryEntriesBySessionId: mocks.deleteHistoryEntriesBySessionId,
  getEntriesBySource: mocks.getEntriesBySource,
  searchHistoryEntries: vi.fn(),
}));

vi.mock("./tool-registry", () => ({
  toolRegistry: { register: vi.fn() },
}));

import { backfillChatHistoryFromChatLogs } from "./history-tools";

describe("chat history occurrence backfill", () => {
  beforeEach(() => {
    mocks.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "history-backfill-test-"));
    mocks.addHistoryMemory.mockReset();
    mocks.deleteHistoryEntriesBySessionId.mockReset();
    mocks.getEntriesBySource.mockReturnValue([{}]);

    const chatsDir = path.join(mocks.dataDir, "cyrene-chats");
    const sessionsDir = path.join(chatsDir, "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(chatsDir, "index.json"), JSON.stringify([{ id: "session-a" }]));
    fs.writeFileSync(path.join(sessionsDir, "session-a.json"), JSON.stringify({
      messages: [
        { id: "turn-1", role: "user", content: "one", at: 100 },
        { id: "turn-2", role: "model", content: "two", at: 200 },
        { id: "turn-3", role: "user", content: "three", at: 300 },
      ],
    }));
  });

  afterEach(() => {
    fs.rmSync(mocks.dataDir, { recursive: true, force: true });
  });

  it("resumes at the failed message and never reruns after completion", async () => {
    mocks.addHistoryMemory
      .mockResolvedValueOnce("entry-1")
      .mockRejectedValueOnce(new Error("temporary embedding failure"));

    await backfillChatHistoryFromChatLogs();

    const marker = path.join(mocks.dataDir, "rag-data", ".history-occurrences-backfill-v2");
    expect(JSON.parse(fs.readFileSync(marker, "utf8"))).toMatchObject({
      complete: false,
      sessionOffsets: { "session-a": 0 },
    });

    mocks.addHistoryMemory.mockReset();
    mocks.addHistoryMemory.mockResolvedValue("entry");
    await backfillChatHistoryFromChatLogs();

    expect(mocks.addHistoryMemory.mock.calls.map((call) => call[0])).toEqual(["two", "three"]);
    expect(JSON.parse(fs.readFileSync(marker, "utf8"))).toMatchObject({
      complete: true,
      doneSessions: ["session-a"],
      sessionOffsets: { "session-a": 2 },
    });

    mocks.addHistoryMemory.mockClear();
    await backfillChatHistoryFromChatLogs();
    expect(mocks.addHistoryMemory).not.toHaveBeenCalled();
  });
});
