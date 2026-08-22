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

describe("legacy scoped permission migration", () => {
  beforeEach(() => {
    vi.resetModules();
    electronMock.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-permission-scoped-"));
  });

  it("normalizes a runtime scoped selection to per-action", async () => {
    const permission = await import("./permission");
    permission.setCurrentLevel("scoped");
    expect(permission.getCurrentLevel()).toBe("per-action");
  });

  it("migrates a persisted scoped level to per-action", async () => {
    fs.writeFileSync(
      path.join(electronMock.userDataDir, "agent-permission.json"),
      JSON.stringify({ level: "scoped" }),
      "utf8",
    );
    const permission = await import("./permission");
    permission.initPermissionFromDisk();

    expect(permission.getCurrentLevel()).toBe("per-action");
    expect(JSON.parse(fs.readFileSync(
      path.join(electronMock.userDataDir, "agent-permission.json"),
      "utf8",
    ))).toEqual({ level: "per-action" });
  });
});
