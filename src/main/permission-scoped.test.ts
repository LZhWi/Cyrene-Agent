import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const electronMock = vi.hoisted(() => ({ userDataDir: "" }));

vi.mock("electron", () => ({
  app: { getPath: () => electronMock.userDataDir },
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));

describe("legacy scoped permission fails closed without configured roots", () => {
  beforeEach(() => {
    vi.resetModules();
    electronMock.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-permission-scoped-"));
  });

  it.each([
    ["read_file", "fs-read"],
    ["list_dir", "fs-read"],
    ["write_file", "fs-write"],
  ] as const)("denies %s before notification or approval", async (toolId, risk) => {
    const permission = await import("./permission");
    permission.setCurrentLevel("scoped");

    await expect(permission.checkPermission({
      toolId,
      toolName: toolId,
      toolDescription: toolId,
      args: { path: path.join(electronMock.userDataDir, "file.txt") },
      risk,
    })).resolves.toEqual({
      allowed: false,
      reason: "指定目录档尚未配置授权目录，已拒绝此次文件访问。",
    });
  });
});
