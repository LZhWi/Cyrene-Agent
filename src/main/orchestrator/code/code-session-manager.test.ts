import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatSession } from "../../../shared/chat-types";
import { clineRuntime } from "./cline-runtime-manager";
import { getOrCreateClineSession } from "./code-session-manager";

describe("CodeSessionManager runtime capabilities", () => {
  afterEach(() => vi.restoreAllMocks());

  it("passes the host Ask executor into a fresh Cline session", async () => {
    const askQuestion = vi.fn();
    const capabilities = { toolExecutors: { askQuestion } };
    vi.spyOn(clineRuntime, "start").mockResolvedValue({ sessionId: "cline-new" });
    const session = {
      id: "chat-code",
      mode: "code",
      messages: [],
      workspaceBinding: { workspaceRoot: "C:\\repo", displayName: "repo", boundAt: 1 },
      codeSession: { clineMode: "act", tasks: [] },
    } as unknown as ChatSession;

    await getOrCreateClineSession(session, "修复测试", { cwd: "C:\\repo" }, capabilities);

    expect(clineRuntime.start).toHaveBeenCalledWith(expect.objectContaining({ capabilities }));
  });
});
