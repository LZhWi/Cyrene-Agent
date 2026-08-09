import fs from "fs";
import os from "os";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC } from "../../shared/ipc-channels";

const mocks = vi.hoisted(() => ({
  userDataDir: "",
  handlers: new Map<string, (...args: any[]) => unknown>(),
  openPath: vi.fn(async () => ""),
}));

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

  it("persists the selected Cline plan/act mode only for Code sessions", async () => {
    const { registerChatsIpc } = await import("./chats-ipc");
    registerChatsIpc();

    const create = mocks.handlers.get(IPC.CHATS_CREATE);
    const setCodeMode = mocks.handlers.get(IPC.CHATS_SET_CODE_MODE);
    if (!create || !setCodeMode) throw new Error("Code session IPC handlers were not registered");
    const event = { sender: {} };
    const code = await create(event, { mode: "code" }) as { id: string };
    const work = await create(event, { mode: "work" }) as { id: string };

    expect(await setCodeMode(event, { sessionId: code.id, clineMode: "plan" })).toEqual(
      expect.objectContaining({ ok: true, session: expect.objectContaining({
        mode: "code",
        codeSession: expect.objectContaining({ clineMode: "plan" }),
      }) }),
    );
    expect(await setCodeMode(event, { sessionId: work.id, clineMode: "plan" })).toEqual({
      ok: false,
      error: "Code session not found",
    });
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
