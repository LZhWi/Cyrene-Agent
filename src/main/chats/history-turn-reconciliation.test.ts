import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  userDataDir: "",
  messages: [] as Array<{ id: string; role: "user" | "model"; content: string; at: number }>,
  entries: [] as Array<{ source: string; text: string; metadata: Record<string, unknown> }>,
  add: vi.fn(),
  deleteHistory: vi.fn(),
  deleteImages: vi.fn(),
}));

vi.mock("../runtime/runtime-paths", () => ({ getUserDataDir: () => state.userDataDir }));
vi.mock("./chats-store", () => ({
  getStorageStatus: () => ({ status: "ready" }),
  getSession: () => ({ messages: state.messages }),
}));
vi.mock("../chat/visual-history-index", () => ({ scheduleVisualHistoryIndex: vi.fn() }));
vi.mock("../rag", () => ({
  isUserMemoryVectorStoreReady: () => true,
  getEntriesBySource: (source: string) => state.entries.filter((entry) => entry.source === source),
  addHistoryMemory: state.add,
  deleteHistoryEntriesByTurnIds: state.deleteHistory,
  deleteChatImagesByTurnIds: state.deleteImages,
}));

import { queueHistoryTurnReconciliation, retryHistoryTurnReconciliations } from "./history-turn-reconciliation";

const pendingFile = () => path.join(state.userDataDir, "cyrene-chats", "pending-history-turns.json");

describe("durable history turn reconciliation", () => {
  beforeEach(() => {
    state.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-history-turns-"));
    state.messages = [];
    state.entries = [];
    state.add.mockReset();
    state.deleteHistory.mockReset().mockImplementation((ids: string[]) => {
      state.entries = state.entries.filter((entry) => entry.metadata.turnId !== ids[0]);
    });
    state.deleteImages.mockReset();
    state.add.mockImplementation(async (text: string, occurrence: { turnId: string; ts: number; role: string }) => {
      state.entries.push({ source: "chat_history", text, metadata: { turnId: occurrence.turnId, ts: occurrence.ts, role: occurrence.role } });
    });
  });
  afterEach(() => fs.rmSync(state.userDataDir, { recursive: true, force: true }));

  it("replaces an old sticker marker with its saved-message description and confirms it later", async () => {
    state.entries = [{ source: "chat_history", text: "[sticker:HI]", metadata: { turnId: "u1" } }];
    queueHistoryTurnReconciliation("chat-1", ["u1"]);
    state.messages = [{ id: "u1", role: "user", content: "[sticker:HI]", at: 100 }];
    await retryHistoryTurnReconciliations();
    expect(state.entries[0].text).toBe("（用户发送表情包：嗨，想我了吗）");
    expect(JSON.parse(fs.readFileSync(pendingFile(), "utf8"))).toEqual([{ sessionId: "chat-1", turnId: "u1" }]);
    await retryHistoryTurnReconciliations();
    expect(JSON.parse(fs.readFileSync(pendingFile(), "utf8"))).toEqual([]);
  });

  it("removes a deleted turn and keeps the retry intent until absence is confirmed", async () => {
    state.entries = [{ source: "chat_history", text: "old", metadata: { turnId: "u1" } }];
    queueHistoryTurnReconciliation("chat-1", ["u1"]);
    await retryHistoryTurnReconciliations();
    expect(state.entries).toEqual([]);
    expect(state.deleteHistory).toHaveBeenCalledWith(["u1"]);
    await retryHistoryTurnReconciliations();
    expect(JSON.parse(fs.readFileSync(pendingFile(), "utf8"))).toEqual([]);
  });
});
