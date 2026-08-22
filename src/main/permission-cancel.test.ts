import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const electronMock = vi.hoisted(() => ({
  userDataDir: "",
  sent: [] as unknown[],
}));

vi.mock("electron", () => ({
  app: { getPath: () => electronMock.userDataDir },
  ipcMain: { handle: vi.fn() },
  BrowserWindow: {
    getAllWindows: () => [{ webContents: { id: 1, send: (_channel: string, payload: unknown) => electronMock.sent.push(payload) } }],
  },
}));

describe("permission approval cancellation", () => {
  beforeEach(() => {
    vi.resetModules();
    electronMock.sent.length = 0;
    electronMock.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-permission-cancel-"));
  });

  it("removes a pending approval and refuses execution when the run aborts", async () => {
    const permission = await import("./permission");
    permission.setCurrentLevel("per-action");
    const controller = new AbortController();
    const decision = permission.checkPermission({
      toolId: "run_shell",
      toolName: "run shell",
      toolDescription: "run shell",
      args: { command: "node" },
      risk: "shell",
      signal: controller.signal,
    });
    expect(electronMock.sent).toHaveLength(1);

    controller.abort();

    await expect(decision).resolves.toEqual({ allowed: false, reason: "用户拒绝了此次操作。" });
  });
});
