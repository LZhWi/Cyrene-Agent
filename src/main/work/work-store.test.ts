import fs from "fs";
import os from "os";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const electronMock = vi.hoisted(() => ({ userDataDir: "" }));

vi.mock("electron", () => ({
  app: { getPath: () => electronMock.userDataDir },
  shell: { openPath: vi.fn() },
}));

describe("work store isolation", () => {
  beforeEach(() => {
    vi.resetModules();
    electronMock.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-work-store-"));
  });

  it("persists sessions only below cyrene-work", async () => {
    const store = await import("./work-store");
    store.initializeWorkStore();
    const session = store.createWorkSession();
    store.appendWorkMessage(session.id, {
      id: "m1",
      role: "user",
      content: "prepare a report",
      createdAt: 1,
    });

    expect(store.getWorkSession(session.id)?.messages).toHaveLength(1);
    expect(store.getWorkRootDir()).toBe(path.join(electronMock.userDataDir, "cyrene-work"));
    expect(fs.existsSync(path.join(electronMock.userDataDir, "cyrene-chats"))).toBe(false);
  });

  it("keeps plans and artifacts in the Work session", async () => {
    const store = await import("./work-store");
    const session = store.createWorkSession("report");
    const plan = {
      id: "p1",
      goal: "report",
      mode: "plan" as const,
      status: "running" as const,
      steps: [{ id: "s1", objective: "collect", status: "pending" as const, toolCallCount: 0 }],
      createdAt: 1,
      updatedAt: 1,
    };
    store.updateWorkExecutionState(session.id, {
      status: "running",
      plan,
      artifacts: [{ id: "a1", name: "r.md", path: "C:\\tmp\\r.md", createdAt: 1 }],
    });

    expect(store.getWorkSession(session.id)).toEqual(expect.objectContaining({
      status: "running",
      plan: expect.objectContaining({ id: "p1" }),
      artifacts: [expect.objectContaining({ name: "r.md" })],
    }));
  });
});
