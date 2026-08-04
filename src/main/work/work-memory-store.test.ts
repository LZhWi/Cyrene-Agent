import fs from "fs";
import os from "os";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const electronMock = vi.hoisted(() => ({ userDataDir: "" }));

vi.mock("electron", () => ({ app: { getPath: () => electronMock.userDataDir } }));

describe("Work memory isolation", () => {
  beforeEach(() => {
    vi.resetModules();
    electronMock.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-work-memory-"));
  });

  it("reads and writes only the Work memory store", async () => {
    const store = await import("./work-memory-store");
    store.saveWorkMemory("Project Aurora uses TypeScript", "work-session-1");

    expect(store.searchWorkMemory("Aurora TypeScript")).toHaveLength(1);
    expect(fs.existsSync(path.join(electronMock.userDataDir, "cyrene-work", "memory", "entries.json"))).toBe(true);
    expect(fs.existsSync(path.join(electronMock.userDataDir, "memory"))).toBe(false);
    expect(fs.existsSync(path.join(electronMock.userDataDir, "cyrene-chats"))).toBe(false);
  });
});
