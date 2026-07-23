import { describe, expect, it, vi } from "vitest";
import { CyreneAgent } from "./cyrene-agent";
import { runTwoPhaseFcLoop } from "./two-phase-fc-loop";

vi.mock("./vendors", () => ({
  getAdapterForConfig: vi.fn(() => ({ id: "fake-adapter" })),
}));

vi.mock("./tool-registry", () => ({
  toolRegistry: {
    getEnabledTools: vi.fn(() => []),
    getById: vi.fn(),
  },
}));

vi.mock("../permission", () => ({
  checkPermission: vi.fn(),
}));

vi.mock("./two-phase-fc-loop", () => ({
  runTwoPhaseFcLoop: vi.fn(async () => ({
    reply: "done",
    toolResults: [],
    soulPhaseReason: "no_tool",
  })),
}));

describe("CyreneAgent", () => {
  it("passes CyreneRunOptions.soulSampling through to runTwoPhaseFcLoop", async () => {
    const agent = new CyreneAgent({ threadId: "test-thread" });
    const soulSampling = { temperature: 0.9, frequencyPenalty: 0.2 };

    await new Promise<void>((resolve, reject) => {
      agent.runWithEvents({
        settings: {
          provider: "test",
          baseUrl: "https://test",
          model: "m",
          apiKey: "k",
        },
        messages: [{ role: "user", content: "hi" }],
        timeoutMs: 1000,
        tools: [],
        toolSystemContent: "TOOL",
        soulSystemBaseContent: "SOUL",
        soulSampling,
        executionMode: "work",
        agentRuntime: "legacy",
      }).subscribe({
        complete: resolve,
        error: reject,
      });
    });

    expect(runTwoPhaseFcLoop).toHaveBeenCalledWith(expect.objectContaining({
      soulSampling,
    }));
  });
});
