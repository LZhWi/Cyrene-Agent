import fs from "fs";
import os from "os";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const electronMock = vi.hoisted(() => ({
  userDataDir: "",
}));

vi.mock("electron", () => ({
  app: {
    getPath: () => electronMock.userDataDir,
  },
  shell: {
    openPath: vi.fn(),
  },
}));

describe("chats store", () => {
  beforeEach(() => {
    vi.resetModules();
    electronMock.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-chats-store-"));
  });

  it("includes messageCount in paged session metadata", async () => {
    const { createSession, getSessionPage, initialize } = await import("./chats-store");
    initialize();

    const session = createSession({
      initialMessages: [
        { id: "1", role: "user", content: "one", at: 1 },
        { id: "2", role: "model", content: "two", at: 2 },
        { id: "3", role: "user", content: "three", at: 3 },
      ],
    });

    const page = getSessionPage(session.id, null, 2);

    expect(page?.messages).toHaveLength(2);
    expect(page?.session.messageCount).toBe(3);
  });

  it("includes the immutable session mode in every list item", async () => {
    const { createSession, initialize, listSessions } = await import("./chats-store");
    initialize();

    createSession({ mode: "chat" });
    createSession({ mode: "work" });
    createSession({ mode: "code" });

    expect(listSessions().map((session) => session.mode).sort()).toEqual(["chat", "code", "work"]);
  });

  it("filters session metadata by mode without changing the unfiltered result", async () => {
    const { createSession, initialize, listSessions } = await import("./chats-store");
    initialize();

    const chat = createSession({ mode: "chat" });
    const work = createSession({ mode: "work" });
    const code = createSession({ mode: "code" });

    expect(listSessions({ mode: "code" })).toEqual([
      expect.objectContaining({ id: code.id, mode: "code" }),
    ]);
    expect(new Set(listSessions().map((session) => session.id))).toEqual(
      new Set([chat.id, work.id, code.id]),
    );
  });

  it("backfills legacy index modes from the session before applying legacy defaults", async () => {
    const root = path.join(electronMock.userDataDir, "cyrene-chats");
    const sessionsDir = path.join(root, "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    const baseMeta = {
      title: "旧对话",
      identityId: null,
      createdAt: 1,
      updatedAt: 1,
      messageCount: 0,
    };
    fs.writeFileSync(path.join(root, "index.json"), JSON.stringify([
      { ...baseMeta, id: "legacy-work" },
      { ...baseMeta, id: "legacy-proactive", purpose: "proactive-chat" },
      { ...baseMeta, id: "existing-code" },
      { ...baseMeta, id: "invalid-mode" },
    ]));
    const baseSession = {
      title: "旧对话",
      identityId: null,
      messages: [],
      createdAt: 1,
      updatedAt: 1,
      schemaVersion: 1,
    };
    fs.writeFileSync(path.join(sessionsDir, "legacy-work.json"), JSON.stringify({
      ...baseSession,
      id: "legacy-work",
    }));
    fs.writeFileSync(path.join(sessionsDir, "legacy-proactive.json"), JSON.stringify({
      ...baseSession,
      id: "legacy-proactive",
      purpose: "proactive-chat",
    }));
    fs.writeFileSync(path.join(sessionsDir, "existing-code.json"), JSON.stringify({
      ...baseSession,
      id: "existing-code",
      mode: "code",
      codeSession: { clineMode: "act", tasks: [] },
    }));
    fs.writeFileSync(path.join(sessionsDir, "invalid-mode.json"), JSON.stringify({
      ...baseSession,
      id: "invalid-mode",
      mode: "invalid",
    }));

    const { initialize, listSessions } = await import("./chats-store");
    initialize();

    expect(listSessions().map(({ id, mode }) => ({ id, mode }))).toEqual([
      { id: "legacy-work", mode: "work" },
      { id: "legacy-proactive", mode: "chat" },
      { id: "existing-code", mode: "code" },
      { id: "invalid-mode", mode: "work" },
    ]);
    expect(JSON.parse(fs.readFileSync(path.join(root, "index.json"), "utf8"))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "legacy-work", mode: "work" }),
        expect.objectContaining({ id: "legacy-proactive", mode: "chat" }),
        expect.objectContaining({ id: "existing-code", mode: "code" }),
        expect.objectContaining({ id: "invalid-mode", mode: "work" }),
      ]),
    );
  });

  it("persists and indexes a session purpose", async () => {
    let store = await import("./chats-store");
    store.initialize();

    const created = store.createSession({
      title: "昔涟的主动消息",
      purpose: "proactive-chat",
    });

    expect(store.listSessions()).toContainEqual(expect.objectContaining({
      id: created.id,
      purpose: "proactive-chat",
    }));

    vi.resetModules();
    store = await import("./chats-store");
    store.initialize();

    expect(store.getSessionByPurpose("proactive-chat")?.id).toBe(created.id);
    expect(store.getSession(created.id)?.purpose).toBe("proactive-chat");
  });

  it("returns one proactive session for repeated singleton requests", async () => {
    const store = await import("./chats-store");
    store.initialize();

    const sessions = await Promise.all(Array.from({ length: 8 }, async () => (
      store.getOrCreateSessionByPurpose("proactive-chat", { title: "昔涟的主动消息" })
    )));

    expect(new Set(sessions.map((session) => session.id)).size).toBe(1);
    expect(store.listSessions().filter((session) => session.purpose === "proactive-chat")).toHaveLength(1);

    store.appendMessage(sessions[0].id, { id: "p1", role: "model", content: "主动问候", at: 1 });
    expect(store.getSession(sessions[0].id)?.title).toBe("昔涟的主动消息");
  });

  it("recreates the proactive singleton after it is deleted", async () => {
    const store = await import("./chats-store");
    store.initialize();

    const first = store.getOrCreateSessionByPurpose("proactive-chat", { title: "昔涟的主动消息" });
    expect(store.deleteSession(first.id)).toBe(true);

    const second = store.getOrCreateSessionByPurpose("proactive-chat", { title: "昔涟的主动消息" });
    expect(second.id).not.toBe(first.id);
    expect(store.getSessionByPurpose("proactive-chat")?.id).toBe(second.id);
  });
});
