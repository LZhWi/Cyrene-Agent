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

  it("creates code/learn sessions with mode and bound directory", async () => {
    const store = await import("./work-store");
    store.initializeWorkStore();
    const codeSession = store.createWorkSession(undefined, "code", "E:\\projects\\demo");
    expect(codeSession.mode).toBe("code");
    expect(codeSession.boundDir).toBe("E:\\projects\\demo");
    expect(store.workSessionMode(codeSession)).toBe("code");

    const learnSession = store.createWorkSession(undefined, "learn", "D:\\vault");
    expect(store.listWorkSessions()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: learnSession.id, mode: "learn" }),
      ]),
    );
  });

  it("defaults legacy sessions without mode to work", async () => {
    const store = await import("./work-store");
    store.initializeWorkStore();
    const session = store.createWorkSession("legacy");
    expect(session.mode).toBeUndefined();
    expect(store.workSessionMode(session)).toBe("work");
    // 非法 mode 值归一化为 work 且不写 boundDir。
    const bogus = store.createWorkSession("bogus", "hack" as never, "C:\\Windows");
    expect(bogus.mode).toBeUndefined();
    expect(bogus.boundDir).toBeUndefined();
  });
});
