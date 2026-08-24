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

  it("reuses an isolated in-memory session snapshot between durable writes", async () => {
    const store = await import("./chats-store");
    store.initialize();
    const created = store.createSession({
      initialMessages: [{ id: "1", role: "user", content: "original", at: 1 }],
    });
    const readSpy = vi.spyOn(fs, "readFileSync");

    const first = store.getSession(created.id)!;
    first.messages[0].content = "external mutation";
    expect(store.getSession(created.id)?.messages[0].content).toBe("original");
    store.appendMessage(created.id, { id: "2", role: "model", content: "reply", at: 2 });
    expect(store.getSessionPage(created.id, null, 10)?.messages).toHaveLength(2);
    expect(readSpy).not.toHaveBeenCalled();
    readSpy.mockRestore();

    vi.resetModules();
    const reloaded = await import("./chats-store");
    reloaded.initialize();
    expect(reloaded.getSession(created.id)?.messages).toHaveLength(2);
  });

  it("automatically restores a damaged primary index from last-good", async () => {
    let store = await import("./chats-store");
    store.initialize();
    const created = store.createSession({
      title: "可恢复会话",
      initialMessages: [{ id: "u1", role: "user", content: "你好", at: 1 }],
    });
    const root = path.join(electronMock.userDataDir, "cyrene-chats");
    fs.writeFileSync(path.join(root, "index.json"), "{broken", "utf8");

    vi.resetModules();
    store = await import("./chats-store");
    store.initialize();

    expect(store.getStorageStatus()).toEqual({ status: "ready" });
    expect(store.listSessions().map((session) => session.id)).toContain(created.id);
    expect(() => JSON.parse(fs.readFileSync(path.join(root, "index.json"), "utf8"))).not.toThrow();
  });

  it("requires approval before rebuilding when both indexes are damaged", async () => {
    let store = await import("./chats-store");
    store.initialize();
    const created = store.createSession({
      title: "等待批准恢复",
      initialMessages: [{ id: "u1", role: "user", content: "请保留", at: 1 }],
    });
    const root = path.join(electronMock.userDataDir, "cyrene-chats");
    const primary = path.join(root, "index.json");
    const lastGood = path.join(root, "index.last-good.json");
    fs.writeFileSync(primary, "{broken-primary", "utf8");
    fs.writeFileSync(lastGood, "{broken-last-good", "utf8");

    vi.resetModules();
    store = await import("./chats-store");
    store.initialize();

    expect(store.getStorageStatus()).toEqual(expect.objectContaining({ status: "recovery_pending" }));
    expect(store.listSessions()).toEqual([]);
    expect(() => store.createSession()).toThrow(/E_CHAT_STORAGE_NOT_READY/);
    expect(fs.readFileSync(primary, "utf8")).toBe("{broken-primary");
    expect(fs.readFileSync(lastGood, "utf8")).toBe("{broken-last-good");

    const result = store.approveIndexRebuild();

    expect(result.ok).toBe(true);
    expect(result.recoveredSessions).toBe(1);
    expect(result.invalidSessions).toEqual([]);
    expect(result.backupPaths).toHaveLength(2);
    expect(store.getStorageStatus()).toEqual({ status: "ready" });
    expect(store.listSessions().map((session) => session.id)).toContain(created.id);
    expect(() => JSON.parse(fs.readFileSync(primary, "utf8"))).not.toThrow();
    expect(() => JSON.parse(fs.readFileSync(lastGood, "utf8"))).not.toThrow();
  });

  it("requires approval when both indexes are missing but session files remain", async () => {
    let store = await import("./chats-store");
    store.initialize();
    const created = store.createSession({
      initialMessages: [{ id: "u1", role: "user", content: "索引丢失但会话仍在", at: 1 }],
    });
    const root = path.join(electronMock.userDataDir, "cyrene-chats");
    fs.unlinkSync(path.join(root, "index.json"));
    fs.unlinkSync(path.join(root, "index.last-good.json"));

    vi.resetModules();
    store = await import("./chats-store");
    store.initialize();

    expect(store.getStorageStatus().status).toBe("recovery_pending");
    expect(store.listSessions()).toEqual([]);
    expect(fs.existsSync(path.join(root, "sessions", `${created.id}.json`))).toBe(true);
  });

  it("does not change damaged indexes when recovery is declined", async () => {
    let store = await import("./chats-store");
    store.initialize();
    store.createSession({ initialMessages: [{ id: "u1", role: "user", content: "保留", at: 1 }] });
    const root = path.join(electronMock.userDataDir, "cyrene-chats");
    const primary = path.join(root, "index.json");
    const lastGood = path.join(root, "index.last-good.json");
    fs.writeFileSync(primary, "bad-primary", "utf8");
    fs.writeFileSync(lastGood, "bad-last-good", "utf8");

    vi.resetModules();
    store = await import("./chats-store");
    store.initialize();
    const status = store.declineIndexRebuild();

    expect(status.status).toBe("recovery_pending");
    expect(fs.readFileSync(primary, "utf8")).toBe("bad-primary");
    expect(fs.readFileSync(lastGood, "utf8")).toBe("bad-last-good");
  });

  it("requires approval before recovering a damaged session from its latest last-good copy", async () => {
    let store = await import("./chats-store");
    store.initialize();
    const created = store.createSession({
      title: "session last-good",
      initialMessages: [{ id: "u1", role: "user", content: "真实内容", at: 1 }],
    });
    const root = path.join(electronMock.userDataDir, "cyrene-chats");
    const sessionPath = path.join(root, "sessions", `${created.id}.json`);
    fs.writeFileSync(sessionPath, "{truncated", "utf8");

    vi.resetModules();
    store = await import("./chats-store");
    store.initialize();
    expect(store.getStorageStatus()).toEqual(expect.objectContaining({
      status: "session_recovery_pending",
      sessionId: created.id,
      recoverable: true,
      recoverySource: "last_good",
    }));
    expect(store.listSessions().map((session) => session.id)).toContain(created.id);
    expect(store.getSession(created.id)).toBeNull();
    expect(fs.readFileSync(sessionPath, "utf8")).toBe("{truncated");
    expect(fs.existsSync(path.join(root, "recovery", "sessions"))).toBe(false);

    const result = store.approveSessionRecovery();
    const recovered = store.getSession(created.id);

    expect(result).toEqual(expect.objectContaining({ ok: true, action: "recovered", recoverySource: "last_good" }));
    expect(store.getStorageStatus()).toEqual({ status: "ready" });
    expect(recovered?.messages[0].content).toBe("真实内容");
    expect(store.listSessions().map((session) => session.id)).toContain(created.id);
    expect(() => JSON.parse(fs.readFileSync(sessionPath, "utf8"))).not.toThrow();
    const recoveryDir = path.join(root, "recovery", "sessions");
    expect(fs.readdirSync(recoveryDir).some((name) => name.startsWith(created.id))).toBe(true);
  });

  it("leaves every session file unchanged when session recovery is declined", async () => {
    let store = await import("./chats-store");
    store.initialize();
    const created = store.createSession({
      initialMessages: [{ id: "u1", role: "user", content: "保持原样", at: 1 }],
    });
    const sessionsDir = path.join(electronMock.userDataDir, "cyrene-chats", "sessions");
    const primary = path.join(sessionsDir, `${created.id}.json`);
    const lastGood = path.join(sessionsDir, `${created.id}.last-good.json`);
    const lastGoodBefore = fs.readFileSync(lastGood, "utf8");
    fs.writeFileSync(primary, "damaged-primary", "utf8");

    vi.resetModules();
    store = await import("./chats-store");
    store.initialize();
    const status = store.declineIndexRebuild();

    expect(status.status).toBe("session_recovery_pending");
    expect(fs.readFileSync(primary, "utf8")).toBe("damaged-primary");
    expect(fs.readFileSync(lastGood, "utf8")).toBe(lastGoodBefore);
    expect(fs.existsSync(path.join(electronMock.userDataDir, "cyrene-chats", "recovery", "sessions"))).toBe(false);
  });

  it("deletes the session and its latest last-good copy together", async () => {
    const store = await import("./chats-store");
    store.initialize();
    const created = store.createSession({
      initialMessages: [{ id: "u1", role: "user", content: "删除我", at: 1 }],
    });
    const sessionsDir = path.join(electronMock.userDataDir, "cyrene-chats", "sessions");

    expect(store.deleteSession(created.id)).toBe(true);
    expect(fs.existsSync(path.join(sessionsDir, `${created.id}.json`))).toBe(false);
    expect(fs.existsSync(path.join(sessionsDir, `${created.id}.last-good.json`))).toBe(false);
  });

  it("seeds a missing session last-good copy on the first successful read", async () => {
    let store = await import("./chats-store");
    store.initialize();
    const created = store.createSession({
      initialMessages: [{ id: "u1", role: "user", content: "旧数据", at: 1 }],
    });
    const lastGood = path.join(
      electronMock.userDataDir,
      "cyrene-chats",
      "sessions",
      `${created.id}.last-good.json`,
    );
    fs.unlinkSync(lastGood);

    vi.resetModules();
    store = await import("./chats-store");
    store.initialize();
    expect(store.getSession(created.id)?.messages[0].content).toBe("旧数据");
    expect(fs.existsSync(lastGood)).toBe(true);
  });

  it("isolates an unrecoverable session without inventing replacement content", async () => {
    let store = await import("./chats-store");
    store.initialize();
    const created = store.createSession({
      initialMessages: [{ id: "u1", role: "user", content: "不能伪造", at: 1 }],
    });
    const root = path.join(electronMock.userDataDir, "cyrene-chats");
    const primary = path.join(root, "sessions", `${created.id}.json`);
    const lastGood = path.join(root, "sessions", `${created.id}.last-good.json`);
    fs.writeFileSync(primary, "bad-primary", "utf8");
    fs.writeFileSync(lastGood, "bad-last-good", "utf8");

    vi.resetModules();
    store = await import("./chats-store");
    store.initialize();

    expect(store.getStorageStatus()).toEqual(expect.objectContaining({
      status: "session_recovery_pending",
      sessionId: created.id,
      recoverable: false,
    }));
    expect(store.getSession(created.id)).toBeNull();
    expect(store.listSessions().some((session) => session.id === created.id)).toBe(true);
    expect(fs.readFileSync(primary, "utf8")).toBe("bad-primary");
    expect(fs.readFileSync(lastGood, "utf8")).toBe("bad-last-good");

    const result = store.approveSessionRecovery();

    expect(result).toEqual(expect.objectContaining({ ok: true, action: "isolated" }));
    expect(store.getStorageStatus()).toEqual({ status: "ready" });
    expect(store.listSessions().some((session) => session.id === created.id)).toBe(false);
    expect(fs.existsSync(primary)).toBe(false);
    expect(fs.existsSync(lastGood)).toBe(false);
    const recoveryFiles = fs.readdirSync(path.join(root, "recovery", "sessions"));
    expect(recoveryFiles.filter((name) => name.startsWith(created.id))).toHaveLength(2);
  });
});
