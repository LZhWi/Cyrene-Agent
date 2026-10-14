import { beforeEach, describe, expect, it, vi } from "vitest";
import path from "path";

const testFilePath = path.join(process.cwd(), "src/main/chat/visual-history-index.test.ts");

const state = vi.hoisted(() => ({
  session: null as any,
  entries: [] as any[],
  upsert: vi.fn(),
  search: vi.fn(),
  register: vi.fn(),
}));

vi.mock("../chats/chats-store", () => ({
  getSession: () => state.session,
  listSessions: () => state.session ? [{ id: state.session.id }] : [],
}));
vi.mock("../rag", () => ({
  getEntriesBySource: () => state.entries,
  upsertChatImageVector: state.upsert,
  searchMemoryEntries: state.search,
}));
vi.mock("../orchestrator/tool-registry", () => ({ toolRegistry: { register: state.register } }));

import { backfillVisualHistoryIndex, configureVisualHistoryIndex, registerRecallImagesTool, scheduleVisualHistoryIndex } from "./visual-history-index";

const flush = async () => vi.waitFor(() => expect(state.upsert).toHaveBeenCalled());

describe("visual history index", () => {
  beforeEach(() => {
    state.session = null;
    state.entries = [];
    state.upsert.mockReset();
    state.search.mockReset();
    state.register.mockReset();
  });

  it("keeps a saved caption for retrieval but generates a genuine short summary", async () => {
    state.session = { id: "s1", messages: [{ id: "u1", role: "user", at: 100,
      attachments: [{ kind: "image", name: "a.png", filePath: testFilePath, caption: "一只红色的猫", status: "done" }] }] };
    const caption = vi.fn().mockResolvedValue("红猫卧在窗边的木桌上");
    configureVisualHistoryIndex(caption);
    backfillVisualHistoryIndex();
    await flush();
    expect(caption).toHaveBeenCalledWith(testFilePath, "summary");
    expect(state.upsert.mock.calls[0][0]).toContain("一只红色的猫");
    expect(state.upsert.mock.calls[0][1].summary).toBe("红猫卧在窗边的木桌上");
  });

  it("uses the background VLM for a direct image only once", async () => {
    state.session = { id: "s2", messages: [{ id: "u2", role: "user", at: 200,
      attachments: [{ kind: "image", name: "b.png", filePath: "C:/b.png", status: "done" }] }] };
    const caption = vi.fn().mockResolvedValue('{"summary":"窗边摆着一只蓝色花瓶","detail":"窗边的蓝色花瓶里插着白花"}');
    configureVisualHistoryIndex(caption);
    scheduleVisualHistoryIndex("s2", "u2");
    scheduleVisualHistoryIndex("s2", "u2");
    await flush();
    expect(caption).toHaveBeenCalledTimes(1);
    expect(caption).toHaveBeenCalledWith("C:/b.png", "full");
    expect(state.upsert).toHaveBeenCalledTimes(1);
  });

  it("does not turn the first 200 caption characters into a summary", async () => {
    state.session = { id: "s-invalid", messages: [{ id: "u-invalid", role: "user", at: 210,
      attachments: [{ kind: "image", name: "long.png", filePath: "C:/long.png", caption: "详细描述".repeat(100), status: "done" }] }] };
    configureVisualHistoryIndex(vi.fn().mockResolvedValue("这不是十字摘要"));
    scheduleVisualHistoryIndex("s-invalid", "u-invalid");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.upsert).not.toHaveBeenCalled();
  });

  it("pauses a backfill batch after the VLM fails and leaves later images retryable", async () => {
    state.session = { id: "s-fail", messages: [
      { id: "u-fail", role: "user", at: 220, attachments: [{ kind: "image", name: "a.png", filePath: testFilePath, status: "done" }] },
      { id: "u-later", role: "user", at: 221, attachments: [{ kind: "image", name: "b.png", filePath: testFilePath, status: "done" }] },
    ] };
    const caption = vi.fn().mockResolvedValueOnce(null)
      .mockResolvedValueOnce('{"summary":"窗边摆着一只蓝色花瓶","detail":"窗边的蓝色花瓶里插着白花"}');
    configureVisualHistoryIndex(caption);
    backfillVisualHistoryIndex();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(caption).toHaveBeenCalledTimes(1);
    scheduleVisualHistoryIndex("s-fail", "u-later");
    await flush();
    expect(caption).toHaveBeenCalledTimes(2);
  });

  it("does not save a caption after its message is deleted", async () => {
    state.session = { id: "s3", messages: [{ id: "u3", role: "user", at: 300,
      attachments: [{ kind: "image", name: "c.png", filePath: "C:/c.png", status: "done" }] }] };
    let finish!: (value: string) => void;
    configureVisualHistoryIndex(() => new Promise((resolve) => { finish = resolve; }));
    scheduleVisualHistoryIndex("s3", "u3");
    await vi.waitFor(() => expect(finish).toBeDefined());
    state.session.messages = [];
    finish('{"summary":"一张已经删除的旧照片","detail":"已删除的图片"}');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.upsert).not.toHaveBeenCalled();
  });

  it("returns short search results but allows explicit full-detail lookup", async () => {
    registerRecallImagesTool();
    const tool = state.register.mock.calls[0][0];
    state.search.mockResolvedValue([{ id: "img1", text: "x".repeat(500), createdAt: 100,
      metadata: { summary: "窗边摆着一只蓝色花瓶" } }]);
    const search = await tool.execute({ query: "猫" });
    expect(search).toContain("imageId=img1");
    expect(search).toContain("窗边摆着一只蓝色花瓶");
    expect(search).not.toContain("x".repeat(30));
    state.entries = [{ id: "img1", text: "x".repeat(500) }];
    expect(await tool.execute({ imageId: "img1" })).toContain("x".repeat(500));
  });
});
