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

describe("legacy scoped permission compatibility", () => {
  beforeEach(() => {
    vi.resetModules();
    electronMock.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-permission-scoped-"));
  });

  it("preserves a runtime scoped selection", async () => {
    const permission = await import("./permission");
    permission.setCurrentLevel("scoped");
    expect(permission.getCurrentLevel()).toBe("scoped");
  });

  it("preserves a persisted scoped level without rewriting it", async () => {
    fs.writeFileSync(
      path.join(electronMock.userDataDir, "agent-permission.json"),
      JSON.stringify({ level: "scoped" }),
      "utf8",
    );
    const permission = await import("./permission");
    permission.initPermissionFromDisk();

    expect(permission.getCurrentLevel()).toBe("scoped");
    expect(JSON.parse(fs.readFileSync(
      path.join(electronMock.userDataDir, "agent-permission.json"),
      "utf8",
    ))).toEqual({ level: "scoped" });
  });
});
