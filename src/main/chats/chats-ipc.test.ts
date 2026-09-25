import fs from "fs";
import os from "os";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC } from "../../shared/ipc-channels";

const mocks = vi.hoisted(() => ({
  userDataDir: "",
  handlers: new Map<string, (...args: any[]) => unknown>(),
  openPath: vi.fn(async () => ""),
  scheduleVisual: vi.fn(),
}));

vi.mock("../chat/visual-history-caption", () => ({ scheduleVisualHistoryCaption: mocks.scheduleVisual }));

vi.mock("electron", () => ({
  app: {
    getPath: () => mocks.userDataDir,
  },
  shell: {
    openPath: mocks.openPath,
  },
  BrowserWindow: {
    getAllWindows: () => [],
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: any[]) => unknown) => {
      mocks.handlers.set(channel, handler);
    }),
  },
  dialog: {
    showOpenDialog: vi.fn(),
  },
}));

describe("chats IPC mode filtering", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.handlers.clear();
    mocks.openPath.mockClear();
    mocks.scheduleVisual.mockClear();
    mocks.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-chats-ipc-"));
  });

  it("returns only Code sessions for CHATS_LIST({ mode: \"code\" })", async () => {
    const { registerChatsIpc } = await import("./chats-ipc");
    registerChatsIpc();

    const create = mocks.handlers.get(IPC.CHATS_CREATE);
    const list = mocks.handlers.get(IPC.CHATS_LIST);
    if (!create || !list) throw new Error("chat IPC handlers were not registered");
    const event = { sender: {} };

    await create(event, { mode: "chat" });
    await create(event, { mode: "work" });
    const code = await create(event, { mode: "code" }) as { id: string };

    expect(await list(event, { mode: "code" })).toEqual([
      expect.objectContaining({ id: code.id, mode: "code" }),
    ]);
  });

  it("validates and forwards CHATS_UPSERT for run checkpoints", async () => {
    const { registerChatsIpc } = await import("./chats-ipc");
    registerChatsIpc();

    const create = mocks.handlers.get(IPC.CHATS_CREATE);
    const upsert = mocks.handlers.get(IPC.CHATS_UPSERT);
    if (!create || !upsert) throw new Error("checkpoint IPC handlers were not registered");
    const event = { sender: {} };
    const session = await create(event, { mode: "work" }) as { id: string };

    expect(await upsert(event, null)).toBeNull();
    expect(await upsert(event, { id: session.id })).toBeNull();
    expect(await upsert(event, {
      id: session.id,
      message: { id: "assistant-1", role: "model", content: "checkpoint", at: 1 },
    })).toEqual(expect.objectContaining({
      messages: [expect.objectContaining({ id: "assistant-1", content: "checkpoint" })],
    }));
  });

  it("does not resend unchanged historical images for background captioning", async () => {
    const { registerChatsIpc } = await import("./chats-ipc");
    registerChatsIpc();
    const event = { sender: {} };
    const create = mocks.handlers.get(IPC.CHATS_CREATE)!;
    const append = mocks.handlers.get(IPC.CHATS_APPEND)!;
    const replace = mocks.handlers.get(IPC.CHATS_REPLACE_MESSAGES)!;
    const session = await create(event, { mode: "chat" }) as { id: string };
    const message = { id: "photo-1", role: "user", content: "看这张图", at: 1,
      attachments: [{ kind: "image", name: "photo.png", filePath: "C:/photo.png", status: "done" }] };
    await append(event, { id: session.id, message });
    expect(mocks.scheduleVisual).toHaveBeenCalledTimes(1);
    await replace(event, { id: session.id, messages: [message] });
    expect(mocks.scheduleVisual).toHaveBeenCalledTimes(1);
  });

  it("publishes one ignore event only for the latest pending message of a running plugin", async () => {
    const { registerChatsIpc } = await import("./chats-ipc");
    const store = await import("./chats-store");
    const publish = vi.fn(async () => undefined);
    registerChatsIpc(undefined, {
      isPluginRunning: (pluginId) => pluginId === "companion-chat",
      publishPluginAssistantFeedback: publish,
    });
    const proactive = store.createSession({ purpose: "proactive-chat" });
    store.appendMessage(proactive.id, {
      id: "message-1",
      role: "model",
      content: "主动问候",
      at: 1,
      pluginDelivery: { pluginId: "companion-chat", ignoreFeedback: "pending" },
    });
    const ignore = mocks.handlers.get(IPC.CHATS_IGNORE_PLUGIN_MESSAGE);
    if (!ignore) throw new Error("plugin message feedback handler was not registered");

    expect(await ignore({ sender: {} }, { conversationId: proactive.id, messageId: "wrong" })).toEqual({ ok: false });
    expect(publish).not.toHaveBeenCalled();
    expect(await ignore({ sender: {} }, { conversationId: proactive.id, messageId: "message-1" })).toEqual({ ok: true });
    expect(publish).toHaveBeenCalledWith({
      pluginId: "companion-chat",
      conversationId: proactive.id,
      messageId: "message-1",
      action: "ignore",
    });
    expect(store.getSession(proactive.id)?.messages.at(-1)?.pluginDelivery?.ignoreFeedback).toBe("ignored");
    expect(await ignore({ sender: {} }, { conversationId: proactive.id, messageId: "message-1" })).toEqual({ ok: false });
    expect(publish).toHaveBeenCalledOnce();
  });

  it("publishes persisted message invalidation for round and conversation deletion", async () => {
    const { registerChatsIpc } = await import("./chats-ipc");
    const publish = vi.fn(async () => undefined);
    registerChatsIpc(undefined, { publishConversationChanged: publish });
    const create = mocks.handlers.get(IPC.CHATS_CREATE);
    const append = mocks.handlers.get(IPC.CHATS_APPEND);
    const deleteMessage = mocks.handlers.get(IPC.CHATS_DELETE_MESSAGE);
    const deleteConversation = mocks.handlers.get(IPC.CHATS_DELETE);
    if (!create || !append || !deleteMessage || !deleteConversation) throw new Error("chat mutation handlers were not registered");
    const event = { sender: {} };
    const session = await create(event, { mode: "chat" }) as { id: string };
    await append(event, { id: session.id, message: { id: "user-1", role: "user", content: "原文", at: 1 } });
    await append(event, { id: session.id, message: { id: "model-1", role: "model", content: "回复", at: 2 } });
    await deleteMessage(event, { id: session.id, messageId: "user-1" });
    expect(publish).toHaveBeenNthCalledWith(1, {
      conversationId: session.id,
      reason: "message-round-deleted",
      allMessages: false,
      invalidatedMessageIds: ["user-1", "model-1"],
    });
    await deleteConversation(event, session.id);
    expect(publish).toHaveBeenNthCalledWith(2, {
      conversationId: session.id,
      reason: "conversation-deleted",
      allMessages: true,
      invalidatedMessageIds: [],
    });
  });

  it("does not register the removed Cline plan/act IPC", async () => {
    const { registerChatsIpc } = await import("./chats-ipc");
    registerChatsIpc();

    const setCodeMode = mocks.handlers.get("chats:set-code-mode");
    expect(setCodeMode).toBeUndefined();
  });

  it("removes only the deleted conversation's persisted tool results", async () => {
    const { registerChatsIpc } = await import("./chats-ipc");
    const { FileToolOutputStore } = await import("../orchestrator/harness/tool-output/file-tool-output-store");
    registerChatsIpc();
    const create = mocks.handlers.get(IPC.CHATS_CREATE);
    const remove = mocks.handlers.get(IPC.CHATS_DELETE);
    if (!create || !remove) throw new Error("chat delete IPC handler was not registered");
    const event = { sender: {} };
    const first = await create(event, { mode: "work" }) as { id: string };
    const second = await create(event, { mode: "work" }) as { id: string };
    const store = new FileToolOutputStore(mocks.userDataDir);
    const firstRef = await store.put({
      conversationId: first.id, runId: "run-1", toolCallId: "call-1", toolName: "read_file",
      outcome: "success", output: "first output", truncatedForModel: false,
    });
    const secondRef = await store.put({
      conversationId: second.id, runId: "run-2", toolCallId: "call-2", toolName: "read_file",
      outcome: "success", output: "second output", truncatedForModel: false,
    });

    expect(await remove(event, first.id)).toBe(true);
    await expect(store.read({ conversationId: first.id, resultRef: firstRef.resultRef, offset: 0, length: 100 }))
      .resolves.toBeNull();
    await expect(store.read({ conversationId: second.id, resultRef: secondRef.resultRef, offset: 0, length: 100 }))
      .resolves.toMatchObject({ content: "second output" });
  });

  it("opens only a workspace already bound to a project conversation", async () => {
    const { registerChatsIpc } = await import("./chats-ipc");
    registerChatsIpc();

    const create = mocks.handlers.get(IPC.CHATS_CREATE);
    const setWorkspace = mocks.handlers.get(IPC.CHATS_SET_WORKSPACE);
    const openWorkspace = mocks.handlers.get(IPC.CHATS_OPEN_WORKSPACE);
    if (!create || !setWorkspace || !openWorkspace) {
      throw new Error("workspace IPC handlers were not registered");
    }

    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-workspace-"));
    const unrelatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-unrelated-"));
    const event = { sender: {} };
    const session = await create(event, { mode: "work" }) as { id: string };
    await setWorkspace(event, { sessionId: session.id, workspaceRoot });

    expect(await openWorkspace(event, unrelatedRoot)).toEqual({
      ok: false,
      error: "workspace is not bound to a conversation",
    });
    expect(mocks.openPath).not.toHaveBeenCalled();

    expect(await openWorkspace(event, workspaceRoot)).toEqual({ ok: true });
    expect(mocks.openPath).toHaveBeenCalledOnce();
    expect(mocks.openPath).toHaveBeenCalledWith(fs.realpathSync(workspaceRoot));
  });
});
