import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  userDataDir: "",
  status: "ready",
  sessions: [] as Array<{ id: string }>,
  entries: [] as Array<{ metadata: Record<string, unknown> }>,
  deleteHistory: vi.fn(),
  deleteImages: vi.fn(),
}));

vi.mock("../runtime/runtime-paths", () => ({ getUserDataDir: () => state.userDataDir }));
vi.mock("./chats-store", () => ({
  getStorageStatus: () => ({ status: state.status }),
  listSessions: () => state.sessions,
}));
vi.mock("../rag", () => ({
  getEntriesBySource: () => state.entries,
  deleteHistoryEntriesBySessionId: state.deleteHistory,
  deleteChatImagesBySessionId: state.deleteImages,
}));

import { auditUnlinkedDesktopHistory, queueSessionHistoryDeletion, retrySessionHistoryDeletions } from "./history-deletion-retry";

const id = "8b0cc213-baba-4128-9195-7293ae026201";
const queueFile = () => path.join(state.userDataDir, "cyrene-chats", "pending-history-deletions.json");

describe("pending chat-history deletion", () => {
  beforeEach(() => {
    state.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-history-delete-"));
    state.status = "ready";
    state.sessions = [];
    state.entries = [];
    state.deleteHistory.mockReset();
    state.deleteImages.mockReset();
  });

  afterEach(() => fs.rmSync(state.userDataDir, { recursive: true, force: true }));

  it("persists intent and skips a session still present in chats", () => {
    queueSessionHistoryDeletion(id);
    state.sessions = [{ id }];
    state.entries = [{ metadata: { sessionId: id } }];
    retrySessionHistoryDeletions();
    expect(state.deleteHistory).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(queueFile(), "utf8"))).toEqual([id]);
  });

  it("retries after RAG failure and clears intent only after a later loaded snapshot is clean", () => {
    queueSessionHistoryDeletion(id);
    state.entries = [{ metadata: { sessionId: id } }];
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    state.deleteHistory.mockImplementationOnce(() => { throw new Error("RAG unavailable"); });
    retrySessionHistoryDeletions();
    expect(JSON.parse(fs.readFileSync(queueFile(), "utf8"))).toEqual([id]);
    retrySessionHistoryDeletions();
    expect(state.deleteHistory).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fs.readFileSync(queueFile(), "utf8"))).toEqual([id]);
    state.entries = [];
    retrySessionHistoryDeletions();
    expect(JSON.parse(fs.readFileSync(queueFile(), "utf8"))).toEqual([]);
    warning.mockRestore();
  });

  it("does not treat channel history as an unlinked desktop chat", () => {
    state.entries = [
      { metadata: { sessionId: id } },
      { metadata: { sessionId: "channel:wechat:example" } },
    ];
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    auditUnlinkedDesktopHistory();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("1 个"));
    expect(state.deleteHistory).not.toHaveBeenCalled();
    warning.mockRestore();
  });
});
