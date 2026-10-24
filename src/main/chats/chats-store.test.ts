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

  it("does not truncate a proactive message arriving after the retry snapshot", async () => {
    const store = await import("./chats-store");
    store.initialize();
    const session = store.createSession({ mode: "chat", initialMessages: [
      { id: "u", role: "user", content: "question", at: 1 },
      { id: "a", role: "model", content: "answer", at: 2 },
    ] });
    const expectedTailIds = session.messages.map((message) => message.id);
    store.appendMessage(session.id, { id: "p", role: "model", content: "proactive", at: 3 });
    const file = path.join(store.getRootDir(), "sessions", `${session.id}.json`);
    const before = fs.readFileSync(file, "utf8");

    expect(store.replaceMessagesTail(session.id, 0, [session.messages[0]], expectedTailIds)).toBeNull();
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(store.getSession(session.id)?.messages.map((message) => message.id)).toEqual(["u", "a", "p"]);
  });

  it("allows retry truncation only while the expected last turn is still current", async () => {
    const store = await import("./chats-store");
    store.initialize();
    const session = store.createSession({ mode: "chat", initialMessages: [
      { id: "older", role: "model", content: "older", at: 1 },
      { id: "u", role: "user", content: "question", at: 2 },
      { id: "a", role: "model", content: "answer", at: 3 },
    ] });
    const edited = { ...session.messages[1], content: "edited question" };
    const saved = store.replaceMessagesTail(session.id, 1, [edited], ["u", "a"]);
    expect(saved?.messages.map((message) => message.id)).toEqual(["older", "u"]);
    expect(saved?.messages[1].content).toBe("edited question");
    // A second renderer holding the old turn cannot repeat the truncation.
    expect(store.replaceMessagesTail(session.id, 1, [edited], ["u", "a"])).toBeNull();
  });

  it("preserves proactive messages during checkpoint and TTS cache updates", async () => {
    const store = await import("./chats-store");
    store.initialize();
    const session = store.createSession({ mode: "chat", initialMessages: [
      { id: "a", role: "model", content: "checkpoint", at: 1 },
    ] });
    store.appendMessage(session.id, { id: "p", role: "model", content: "proactive", at: 2 });
    store.upsertMessage(session.id, { ...session.messages[0], content: "finished" });
    store.setMessageTtsCacheKey(session.id, "a", `minimax-${"a".repeat(64)}`, "v1");
    expect(store.getSession(session.id)?.messages.map((message) => message.id)).toEqual(["a", "p"]);
    expect(store.getSession(session.id)?.messages[0].content).toBe("finished");
    expect(store.getSession(session.id)?.messages[0].ttsCacheKey).toBe(`minimax-${"a".repeat(64)}`);
  });

  it("blocks corrupt session reads and writes across restart until explicit recovery", async () => {
    let store = await import("./chats-store");
    store.initialize();
    const session = store.createSession({ mode: "chat", initialMessages: [{ id: "u", role: "user", content: "keep", at: 1 }] });
    const file = path.join(store.getRootDir(), "sessions", session.id + ".json");
    const backup = file.replace(/\.json$/, ".last-good.json");
    const good = fs.readFileSync(backup);
    fs.writeFileSync(file, "broken");
    vi.resetModules(); store = await import("./chats-store"); store.initialize();
    expect(() => store.listSessions()).toThrow("等待恢复确认");
    expect(() => store.createSession()).toThrow("等待恢复确认");
    expect(fs.readFileSync(file, "utf8")).toBe("broken");
    expect(fs.readFileSync(backup)).toEqual(good);
    store.approveStorageRecovery(file);
    expect(store.getSession(session.id)?.messages[0].content).toBe("keep");
    expect(store.listSessions()).toHaveLength(1);
  });

  it("reconciles a session saved before an interrupted index write without changing tie order", async () => {
    let store = await import("./chats-store"); store.initialize();
    const session = store.createSession({ mode: "chat" });
    const file = path.join(store.getRootDir(), "sessions", session.id + ".json");
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    saved.messages.push({ id: "u", role: "user", content: "saved", at: 1 });
    fs.writeFileSync(file, JSON.stringify(saved));
    vi.resetModules(); store = await import("./chats-store"); store.initialize();
    expect(store.listSessions()[0].messageCount).toBe(1);
  });

  it("isolates an unrecoverable session only after approval and keeps other sessions", async () => {
    let store = await import("./chats-store"); store.initialize();
    const lost = store.createSession({ mode: "chat" }), kept = store.createSession({ mode: "chat" });
    const file = path.join(store.getRootDir(), "sessions", lost.id + ".json");
    fs.writeFileSync(file, "broken");
    fs.writeFileSync(file.replace(/\.json$/, ".last-good.json"), "broken backup");
    vi.resetModules(); store = await import("./chats-store"); store.initialize();
    store.approveStorageRecovery(file, true);
    expect(store.listSessions().map(item => item.id)).toEqual([kept.id]);
    const recoveryDir = path.join(path.dirname(file), "recovery");
    expect(fs.readdirSync(recoveryDir).map(name => fs.readFileSync(path.join(recoveryDir, name), "utf8")).sort()).toEqual(["broken", "broken backup"]);
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

  it("deletes a selected message together with its adjacent turn partner", async () => {
    const store = await import("./chats-store");
    store.initialize();
    const session = store.createSession({
      initialMessages: [
        { id: "user-1", role: "user", content: "one", at: 1 },
        { id: "model-1", role: "model", content: "two", at: 2 },
        { id: "user-2", role: "user", content: "three", at: 3 },
        { id: "model-2", role: "model", content: "four", at: 4 },
      ],
    });

    const updated = store.deleteMessageRound(session.id, "model-1");

    expect(updated?.messages.map((message) => message.id)).toEqual(["user-2", "model-2"]);
    expect(store.getSession(session.id)?.messages.map((message) => message.id)).toEqual(["user-2", "model-2"]);
  });

  it("upserts a run checkpoint by message id without disturbing conversation order", async () => {
    const store = await import("./chats-store");
    store.initialize();
    const session = store.createSession({
      initialMessages: [
        { id: "user-1", role: "user", content: "开始", at: 1 },
        { id: "assistant-1", role: "model", content: "", at: 2 },
        { id: "user-2", role: "user", content: "排队消息", at: 3 },
      ],
    });

    store.upsertMessage(session.id, {
      id: "assistant-1",
      role: "model",
      content: "处理中",
      at: 2,
    });
    store.upsertMessage(session.id, {
      id: "assistant-2",
      role: "model",
      content: "新回复",
      at: 4,
    });

    const updated = store.getSession(session.id);
    expect(updated?.messages.map((message) => message.id)).toEqual([
      "user-1", "assistant-1", "user-2", "assistant-2",
    ]);
    expect(updated?.messages[1].content).toBe("处理中");
    expect(store.listSessions().find((item) => item.id === session.id)?.messageCount).toBe(4);
  });

  it("includes the immutable session mode in every list item", async () => {
    const { createSession, initialize, listSessions } = await import("./chats-store");
    initialize();

    createSession({ mode: "chat" });
    createSession({ mode: "work" });
    createSession({ mode: "code" });
    createSession({ mode: "learn" });

    expect(listSessions().map((session) => session.mode).sort()).toEqual([
      "chat", "code", "learn", "work",
    ]);
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

  it("migrates Daily sessions to Work without changing their project binding", async () => {
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
      { ...baseMeta, id: "daily-project", mode: "daily", workspaceRoot: "C:\\projects\\daily", workspaceDisplayName: "daily" },
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
    fs.writeFileSync(path.join(sessionsDir, "daily-project.json"), JSON.stringify({
      ...baseSession,
      id: "daily-project",
      title: "原 Daily 项目",
      mode: "daily",
      messages: [{ id: "daily-message", role: "user", content: "保留这条消息", at: 1 }],
      workspaceBinding: { workspaceRoot: "C:\\projects\\daily", displayName: "daily", boundAt: 123 },
    }));
    fs.writeFileSync(path.join(sessionsDir, "invalid-mode.json"), JSON.stringify({
      ...baseSession,
      id: "invalid-mode",
      mode: "invalid",
    }));
    fs.writeFileSync(path.join(sessionsDir, "backfilled-work.json"), JSON.stringify({
      ...baseSession,
      id: "backfilled-work",
      mode: "work",
    }));
    const index = JSON.parse(fs.readFileSync(path.join(root, "index.json"), "utf8"));
    index.push({ ...baseMeta, id: "backfilled-work", mode: "work" });
    fs.writeFileSync(path.join(root, "index.json"), JSON.stringify(index));

    const { initialize, listSessions } = await import("./chats-store");
    initialize();

    expect(listSessions().map(({ id, mode }) => ({ id, mode }))).toEqual([
      { id: "legacy-work", mode: "work" },
      { id: "legacy-proactive", mode: "chat" },
      { id: "existing-code", mode: "code" },
      { id: "daily-project", mode: "work" },
      { id: "invalid-mode", mode: "work" },
      { id: "backfilled-work", mode: "work" },
    ]);
    const migrationRoot = path.join(electronMock.userDataDir, "迁移文件夹");
    expect(fs.existsSync(migrationRoot)).toBe(true);
    expect(fs.readdirSync(migrationRoot)).toEqual([]);
    expect(JSON.parse(fs.readFileSync(path.join(sessionsDir, "legacy-work.json"), "utf8"))).toEqual(
      expect.objectContaining({
        mode: "work",
        workspaceBinding: expect.objectContaining({
          workspaceRoot: migrationRoot,
          displayName: "迁移文件夹",
        }),
      }),
    );
    expect(JSON.parse(fs.readFileSync(path.join(root, "index.json"), "utf8"))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "legacy-work", mode: "work", workspaceDisplayName: "迁移文件夹" }),
        expect.objectContaining({ id: "legacy-proactive", mode: "chat" }),
        expect.objectContaining({ id: "existing-code", mode: "code" }),
        expect.objectContaining({ id: "daily-project", mode: "work", workspaceRoot: "C:\\projects\\daily", workspaceDisplayName: "daily" }),
        expect.objectContaining({ id: "invalid-mode", mode: "work", workspaceDisplayName: "迁移文件夹" }),
      ]),
    );
    expect(JSON.parse(fs.readFileSync(path.join(sessionsDir, "daily-project.json"), "utf8"))).toEqual(
      expect.objectContaining({
        title: "原 Daily 项目",
        mode: "work",
        messages: [{ id: "daily-message", role: "user", content: "保留这条消息", at: 1 }],
        workspaceBinding: { workspaceRoot: "C:\\projects\\daily", displayName: "daily", boundAt: 123 },
      }),
    );
  });

  it("removes obsolete Cline metadata while retaining Code messages and workspace", async () => {
    const store = await import("./chats-store");
    store.initialize();
    const session = store.createSession({
      mode: "code",
      initialMessages: [{ id: "code-message", role: "user", content: "保留代码会话", at: 1 }],
    });

    const persisted = store.getSession(session.id) as unknown as Record<string, unknown>;
    expect(persisted.mode).toBe("code");
    expect(persisted.messages).toEqual([{ id: "code-message", role: "user", content: "保留代码会话", at: 1 }]);
    expect(persisted).not.toHaveProperty("codeSession");
  });

  it("keeps the legacy migration idempotent on restart", async () => {
    const root = path.join(electronMock.userDataDir, "cyrene-chats");
    const sessionsDir = path.join(root, "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    const session = {
      id: "legacy",
      title: "旧对话",
      identityId: null,
      messages: [],
      createdAt: 1,
      updatedAt: 1,
      schemaVersion: 1,
    };
    fs.writeFileSync(path.join(root, "index.json"), JSON.stringify([{
      id: "legacy", title: "旧对话", identityId: null, createdAt: 1, updatedAt: 1, messageCount: 0,
    }]));
    fs.writeFileSync(path.join(sessionsDir, "legacy.json"), JSON.stringify(session));

    let store = await import("./chats-store");
    store.initialize();
    const first = store.getSession("legacy");
    vi.resetModules();
    store = await import("./chats-store");
    store.initialize();
    const second = store.getSession("legacy");

    expect(second?.mode).toBe("work");
    expect(second?.workspaceBinding).toEqual(first?.workspaceBinding);
  });

  it("indexes workspace metadata for grouped conversation lists", async () => {
    const store = await import("./chats-store");
    store.initialize();
    const session = store.createSession({ mode: "work" });
    const workspaceRoot = path.join(electronMock.userDataDir, "project-a");
    fs.mkdirSync(workspaceRoot);

    store.setWorkspaceBinding(session.id, {
      workspaceRoot,
      displayName: "project-a",
      boundAt: 10,
    });

    expect(store.listSessions({ mode: "work" })).toContainEqual(expect.objectContaining({
      id: session.id,
      workspaceRoot,
      workspaceDisplayName: "project-a",
    }));
  });

  it("imports renderer legacy history into the Work migration project", async () => {
    const store = await import("./chats-store");
    store.initialize();

    const session = store.migrateLegacyMessages([
      { id: "old-1", role: "user", content: "以前的消息", at: 1 },
    ]);

    expect(session).toEqual(expect.objectContaining({
      mode: "work",
      workspaceBinding: expect.objectContaining({ displayName: "迁移文件夹" }),
    }));
    expect(store.listSessions({ mode: "work" })).toContainEqual(expect.objectContaining({
      id: session?.id,
      workspaceDisplayName: "迁移文件夹",
    }));
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

  it("preserves generated visual summary when the renderer replaces the same message", async () => {
    const store = await import("./chats-store");
    store.initialize();
    const image = { kind: "image" as const, name: "scene.png", filePath: "C:/scene.png",
      mime: "image/png", status: "done" as const };
    const session = store.createSession({ mode: "chat", initialMessages: [
      { id: "photo", role: "user", content: "看看", at: 1, attachments: [image] },
    ] });
    expect(store.setImageVisualIndexResult(session.id, "photo", image.filePath,
      { summary: "蓝色丝带系在小摆件上", caption: "摆件上有一条蓝色丝带" })).toBe(true);
    const indexedAt = (store.getSession(session.id)?.messages[0].attachments?.[0] as { visualIndexedAt?: number }).visualIndexedAt;
    expect(indexedAt).toBeTypeOf("number");
    store.upsertMessage(session.id, { id: "photo", role: "user", content: "看看", at: 1, attachments: [image] });
    expect(store.getSession(session.id)?.messages[0].attachments?.[0]).toMatchObject({
      visualIndexSummary: "蓝色丝带系在小摆件上", visualIndexCaption: "摆件上有一条蓝色丝带",
      visualIndexedAt: indexedAt,
    });
  });

  it("only marks the latest pending plugin proactive message ignored once", async () => {
    const store = await import("./chats-store");
    store.initialize();
    const proactive = store.createSession({ purpose: "proactive-chat" });
    store.appendMessage(proactive.id, {
      id: "plugin-message",
      role: "model",
      content: "主动问候",
      at: 1,
      pluginDelivery: { pluginId: "companion-chat", ignoreFeedback: "pending" },
    });

    expect(store.markPluginMessageIgnored(proactive.id, "plugin-message")?.pluginId).toBe("companion-chat");
    expect(store.getSession(proactive.id)?.messages.at(-1)?.pluginDelivery?.ignoreFeedback).toBe("ignored");
    expect(store.markPluginMessageIgnored(proactive.id, "plugin-message")).toBeNull();

    const ordinary = store.createSession();
    store.appendMessage(ordinary.id, {
      id: "ordinary-message",
      role: "model",
      content: "普通回复",
      at: 1,
      pluginDelivery: { pluginId: "companion-chat", ignoreFeedback: "pending" },
    });
    expect(store.markPluginMessageIgnored(ordinary.id, "ordinary-message")).toBeNull();
  });

  it("persists a valid TTS cache key only on model messages without changing updatedAt", async () => {
    const store = await import("./chats-store");
    store.initialize();
    const session = store.createSession({
      initialMessages: [
        { id: "user-1", role: "user", content: "你好", at: 1 },
        { id: "model-1", role: "model", content: "你好呀", at: 2 },
      ],
    });
    const cacheKey = `minimax-${"a".repeat(64)}`;
    const converterVersion = "markdown-v1";

    expect(store.setMessageTtsCacheKey(session.id, "model-1", cacheKey, converterVersion)?.updatedAt).toBe(session.updatedAt);
    expect(store.getSession(session.id)?.messages[1].ttsCacheKey).toBe(cacheKey);
    expect(store.getSession(session.id)?.messages[1].ttsCacheVersion).toBe(converterVersion);
    expect(store.setMessageTtsCacheKey(session.id, "user-1", cacheKey, converterVersion)).toBeNull();
    expect(store.setMessageTtsCacheKey(session.id, "model-1", "invalid-key", converterVersion)).toBeNull();
    expect(store.setMessageTtsCacheKey(session.id, "model-1", cacheKey, "invalid version!")).toBeNull();
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
