import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  updateCodeSession: vi.fn(),
  stop: vi.fn(),
}));

vi.mock("../../chats/chats-store", () => ({
  getSession: mocks.getSession,
  updateCodeSession: mocks.updateCodeSession,
}));

vi.mock("./cline-runtime-manager", () => ({
  clineRuntime: { stop: mocks.stop },
}));

describe("Code command router task controls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSession.mockReturnValue({
      id: "chat-code",
      mode: "code",
      codeSession: {
        activeClineSessionId: "cline-old",
        clineMode: "act",
        tasks: [{ clineSessionId: "cline-old", createdAt: 1 }],
      },
    });
    mocks.updateCodeSession.mockReturnValue({ id: "chat-code", mode: "code" });
  });

  it("ends the active Cline task and preserves it in task history", async () => {
    const { beginNewCodeTask } = await import("./code-command-router");

    await expect(beginNewCodeTask("chat-code")).resolves.toEqual({ ok: true });
    expect(mocks.stop).toHaveBeenCalledWith("cline-old");
    expect(mocks.updateCodeSession).toHaveBeenCalledWith("chat-code", expect.objectContaining({
      activeClineSessionId: undefined,
      tasks: [expect.objectContaining({ clineSessionId: "cline-old", closedAt: expect.any(Number) })],
    }));
  });
});
