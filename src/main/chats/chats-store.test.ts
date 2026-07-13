import fs from "fs";
import os from "os";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const electronMock = vi.hoisted(() => ({
  userDataDir: "",
}));

vi.mock("electron", () => ({
  app: {
    getPath: () => electronMock.userDataDir,
  },
  shell: {
    openPath: vi.fn(),
  },
}));

describe("chats store", () => {
  beforeEach(() => {
    vi.resetModules();
    electronMock.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-chats-store-"));
  });

  it("includes messageCount in paged session metadata", async () => {
    const { createSession, getSessionPage, initialize } = await import("./chats-store");
    initialize();

    const session = createSession({
      initialMessages: [
        { id: "1", role: "user", content: "one", at: 1 },
        { id: "2", role: "model", content: "two", at: 2 },
        { id: "3", role: "user", content: "three", at: 3 },
      ],
    });

    const page = getSessionPage(session.id, null, 2);

    expect(page?.messages).toHaveLength(2);
    expect(page?.session.messageCount).toBe(3);
  });
});
