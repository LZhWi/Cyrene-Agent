import { describe, expect, it, vi } from "vitest";
import { IPC } from "../../shared/ipc-channels";
import type { CodeGitChangedPayload, CodeGitDiffResult, CodeGitStatus } from "../../shared/code-git-types";
import { registerCodeGitIpc } from "./code-git-ipc";

function createHarness() {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const sent = vi.fn();
  let onChanged: ((payload: CodeGitChangedPayload) => void) | undefined;
  const service = {
    getStatusForSession: vi.fn(async (sessionId: string): Promise<CodeGitStatus> => ({
      sessionId,
      state: "ready",
      executable: { source: "system", version: "2.55.0" },
      branch: { current: "main", detached: false, branches: ["main"] },
      files: [],
      summary: { added: 0, modified: 0, deleted: 0, renamed: 0, conflicted: 0 },
      ahead: 0,
      behind: 0,
    })),
    getDiffForSession: vi.fn(async (sessionId: string, path: string): Promise<CodeGitDiffResult> => ({
      kind: "ready",
      sessionId,
      path,
      patch: "",
    })),
    onChanged: vi.fn((listener: (payload: CodeGitChangedPayload) => void) => {
      onChanged = listener;
      return () => undefined;
    }),
  };
  registerCodeGitIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    getWindows: () => [{ isDestroyed: () => false, webContents: { send: sent } }],
    service,
  });
  return { handlers, sent, service, emitChanged: (payload: CodeGitChangedPayload) => onChanged?.(payload) };
}

describe("registerCodeGitIpc", () => {
  it("passes only a session identity and repository-relative path to the Git service", async () => {
    const harness = createHarness();

    await harness.handlers.get(IPC.CODE_GIT_STATUS)?.({}, "session-1");
    await harness.handlers.get(IPC.CODE_GIT_DIFF)?.({}, { sessionId: "session-1", path: "src/a.ts" });

    expect(harness.service.getStatusForSession).toHaveBeenCalledWith("session-1");
    expect(harness.service.getDiffForSession).toHaveBeenCalledWith("session-1", "src/a.ts");
  });

  it("rejects a renderer attempt to send an absolute diff path", async () => {
    const harness = createHarness();

    const result = await harness.handlers.get(IPC.CODE_GIT_DIFF)?.({}, {
      sessionId: "session-1",
      path: "C:\\secrets.txt",
    });

    expect(result).toMatchObject({ kind: "error", message: "只能审阅当前仓库中的变更文件" });
    expect(harness.service.getDiffForSession).not.toHaveBeenCalled();
  });

  it("broadcasts only the changed session identity", () => {
    const harness = createHarness();

    harness.emitChanged({ sessionId: "session-1" });

    expect(harness.sent).toHaveBeenCalledWith(IPC.CODE_GIT_CHANGED, { sessionId: "session-1" });
  });
});
