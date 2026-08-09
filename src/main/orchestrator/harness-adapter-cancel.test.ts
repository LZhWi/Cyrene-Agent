import { beforeEach, describe, expect, it, vi } from "vitest";

const { runHarness, permissionCheck, getById } = vi.hoisted(() => ({
  runHarness: vi.fn(),
  permissionCheck: vi.fn(),
  getById: vi.fn(),
}));

vi.mock("./harness", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./harness")>();
  return { ...actual, runCyreneHarness: runHarness };
});

vi.mock("./tool-registry", () => ({
  toolRegistry: {
    getEnabledTools: vi.fn(() => []),
    getById,
  },
}));

vi.mock("../permission", () => ({
  checkPermission: permissionCheck,
}));

vi.mock("../prompts/prompt-loader", () => ({
  loadPromptFile: vi.fn(() => "runtime policy"),
}));

import { runHarnessWithAdapter } from "./harness-adapter";
import type { HarnessInput } from "./harness";

describe("runHarnessWithAdapter cancellation context", () => {
  beforeEach(() => {
    runHarness.mockReset();
    permissionCheck.mockReset();
    getById.mockReset();
    runHarness.mockResolvedValue({
      finalAnswer: "done",
      finalState: { todoItems: [], uncertainEffects: [] },
      terminated: true,
      rounds: 1,
    });
  });

  it("threads the same run signal into tools, permission, and clarification", async () => {
    const signal = new AbortController().signal;
    const clarify = vi.fn(async () => ({ answers: [] }));
    getById.mockReturnValue({
      id: "read_file",
      name: "Read File",
      description: "reads a file",
      risk: "safe",
    });
    permissionCheck.mockResolvedValue({ allowed: true });

    await runHarnessWithAdapter({
      runId: "run-signal",
      settings: {
        provider: "test",
        baseUrl: "",
        model: "",
        apiKey: "",
        contextWindowTokens: 256_000,
      },
      messages: [{ role: "user", content: "hi" }],
      timeoutMs: 60_000,
      toolSystemContent: "",
      soulSystemBaseContent: "",
      executionMode: "work",
      requestUserClarification: clarify,
    } as never, signal, vi.fn());

    const input = runHarness.mock.calls[0]?.[0] as HarnessInput;
    expect(input.signal).toBe(signal);
    expect(input.toolContext?.signal).toBe(signal);

    await input.checkPermission?.("read_file", { path: "x" });
    expect(permissionCheck).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run-signal",
      signal,
    }));

    await input.requestUserClarification?.({ question: "continue?" });
    expect(clarify).toHaveBeenCalledWith({ question: "continue?" }, signal);
  });
});
