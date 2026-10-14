import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import type { IpcScope } from "../application/ipc-scope";
import type { ChatSession } from "../../shared/chat-types";
import { CODE_EXECUTOR_CHANNEL } from "../../shared/code-executor";

export function registerCodeExecutorIpc(ipc: IpcScope, deps: {
  getWindow(): BrowserWindow | null;
  getSession(id: string): ChatSession | null;
  invoke(action: string, data: unknown): unknown;
}) {
  ipc.handle(CODE_EXECUTOR_CHANNEL, async (event: IpcMainInvokeEvent, sessionId: unknown, action: unknown, data: unknown) => {
    try {
      const win = deps.getWindow();
      if (!win || win.isDestroyed() || event.sender !== win.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error("仅 Code 工作区可调用 Codex");
      const session = typeof sessionId === "string" ? deps.getSession(sessionId) : null;
      if (!session || session.mode !== "code") throw new Error("Codex 执行仅支持 Code 会话");
      if (typeof action !== "string" || !["state", "connect", "submit", "answer", "cancel", "sync", "explain"].includes(action)) throw new Error("不支持的执行操作");
      const cwd = session.workspaceBinding?.workspaceRoot;
      if (!cwd) throw new Error("请先为 Code 会话选择工作目录");
      // Ignore renderer-supplied paths and conversation identifiers.
      return await deps.invoke(action, { sessionId: session.id, cwd, input: data });
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  });
}
