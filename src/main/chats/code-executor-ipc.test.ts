import { describe, expect, it, vi } from "vitest";
import { registerCodeExecutorIpc } from "./code-executor-ipc";
import type { IpcScope } from "../application/ipc-scope";

function setup(mode = "code") {
  let handle: (...args: any[]) => any = () => {};
  const sender = { mainFrame: {} };
  const invoke = vi.fn(async () => ({ ok: true, data: {} }));
  const getSession = vi.fn(() => ({ id: "code-1", mode, workspaceBinding: { workspaceRoot: "E:\\trusted" } }));
  registerCodeExecutorIpc({ handle: (_name, fn) => { handle = fn; } } as IpcScope, {
    getWindow: () => ({ isDestroyed: () => false, webContents: sender }) as any,
    getSession: getSession as any, invoke,
  });
  return { call: (action = "state", data?: unknown, event = { sender, senderFrame: sender.mainFrame }) => handle(event, "code-1", action, data), invoke, getSession, sender };
}
describe("Code executor IPC boundary", () => {
  it.each(["chat", "work", "learn"])("rejects %s sessions without invoking the plugin", async mode => {
    const t = setup(mode); expect(await t.call()).toMatchObject({ ok: false }); expect(t.invoke).not.toHaveBeenCalled();
  });
  it("rejects other windows and subframes", async () => {
    const t = setup();
    expect(await t.call("state", {}, { sender: { mainFrame: {} }, senderFrame: {} })).toMatchObject({ ok: false });
    expect(await t.call("state", {}, { sender: t.sender, senderFrame: {} })).toMatchObject({ ok: false });
    expect(t.invoke).not.toHaveBeenCalled();
  });
  it("uses the stored workspace and conversation instead of renderer claims", async () => {
    const t = setup(); const input = { cwd: "E:\\foreign", sessionId: "chat-1", message: "raw" };
    expect(await t.call("submit", input)).toMatchObject({ ok: true });
    expect(t.invoke).toHaveBeenCalledWith("submit", { sessionId: "code-1", cwd: "E:\\trusted", input });
  });
  it("fails visibly when the plugin is unavailable, with no fallback invocation", async () => {
    const t = setup(); t.invoke.mockRejectedValueOnce(new Error("plugin unavailable"));
    expect(await t.call()).toEqual({ ok: false, error: "plugin unavailable" }); expect(t.invoke).toHaveBeenCalledTimes(1);
    expect(await t.call("delete")).toMatchObject({ ok: false }); expect(t.invoke).toHaveBeenCalledTimes(1);
  });
});
