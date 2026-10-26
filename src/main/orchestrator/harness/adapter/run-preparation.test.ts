import { beforeEach, describe, expect, it, vi } from "vitest";

const { trace, preparePlanRunContext, buildHarnessPromptLayers, materializeHarnessStartTranscript, runStore } = vi.hoisted(() => ({
  trace: [] as string[],
  preparePlanRunContext: vi.fn(),
  buildHarnessPromptLayers: vi.fn(),
  materializeHarnessStartTranscript: vi.fn(),
  runStore: { create: vi.fn(), get: vi.fn() },
}));

vi.mock("./plan-lifecycle", () => ({ preparePlanRunContext }));
vi.mock("./prompt-builder", () => ({ buildHarnessPromptLayers, materializeHarnessStartTranscript }));
vi.mock("../run-store", () => ({ getHarnessRunStore: vi.fn(() => runStore) }));
vi.mock("../run-recovery", () => ({ prepareHarnessRecovery: vi.fn() }));
vi.mock("../../tools/registry/tool-registry", () => ({
  toolRegistry: { getEnabledTools: vi.fn(() => []) },
}));
vi.mock("electron", () => ({ app: { getPath: vi.fn(() => "C:\\cyrene-preparation") } }));

import { prepareHarnessRun } from "./run-preparation";

describe("harness run preparation", () => {
  beforeEach(() => {
    trace.length = 0;
    preparePlanRunContext.mockReset();
    preparePlanRunContext.mockResolvedValue({ planState: undefined });
    buildHarnessPromptLayers.mockReset();
    buildHarnessPromptLayers.mockReturnValue({
      stablePrefix: "stable",
      runtimeContext: "runtime",
      mode: "work",
    });
    materializeHarnessStartTranscript.mockReset();
    materializeHarnessStartTranscript.mockImplementation((input) => {
      trace.push("materialize");
      return [...input.messages, { role: "user", content: "materialized" }];
    });
    runStore.create.mockReset();
    runStore.get.mockReset();
    runStore.create.mockImplementation(() => trace.push("create"));
  });

  it("isolates headless runs without changing explicit conversation scopes", async () => {
    const options = { settings: { provider: "test", model: "model" }, messages: [] };
    const first = await prepareHarnessRun({ ...options, runId: "one" } as never, new AbortController().signal);
    const second = await prepareHarnessRun({ ...options, runId: "two" } as never, new AbortController().signal);
    expect(first.threadId).toBe("harness-headless:one");
    expect(second.threadId).toBe("harness-headless:two");
    const explicit = await prepareHarnessRun({ ...options, runId: "three", conversationId: "default" } as never, new AbortController().signal);
    expect(explicit.threadId).toBe("default");
  });

  it.each(["default", "harness-headless:old"])("accepts headless recovery from %s", async (scope) => {
    runStore.get.mockReturnValue({ runId: "old", conversationId: scope });
    const result = await prepareHarnessRun({ runId: "new", resumeFromRunId: "old", settings: {}, messages: [] } as never, new AbortController().signal);
    expect(result.threadId).toBe("harness-headless:new");
    expect(runStore.create).toHaveBeenCalledWith(expect.objectContaining({ resumedFromRunId: "old" }));
  });

  it("rejects headless recovery of a visible conversation", async () => {
    runStore.get.mockReturnValue({ runId: "old", conversationId: "visible-chat" });
    await expect(prepareHarnessRun({ runId: "new", resumeFromRunId: "old", settings: {}, messages: [] } as never, new AbortController().signal)).rejects.toThrow("HARNESS_RECOVERY_NOT_FOUND");
    expect(runStore.create).not.toHaveBeenCalled();
  });

  it("materializes the startup transcript before creating the run store", async () => {
    const prepared = await prepareHarnessRun({
      runId: "run-preparation",
      conversationId: "thread-1",
      conversationMode: "work",
      settings: { provider: "test", baseUrl: "", model: "model", apiKey: "" },
      messages: [{ role: "user", content: "开始" }],
      toolSystemContent: "",
      soulSystemBaseContent: "persona",
    } as never, new AbortController().signal);

    expect(trace).toEqual(["materialize", "create"]);
    expect(prepared.runId).toBe("run-preparation");
    expect(prepared.systemPrompt).toBe("stable");
    expect(runStore.create).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: "thread-1",
      runId: "run-preparation",
      messages: expect.arrayContaining([{ role: "user", content: "materialized" }]),
    }));
  });

  it("forces reasoning off for the two-phase Chat tool run", async () => {
    const prepared = await prepareHarnessRun({
      runId: "run-chat-tool",
      conversationId: "thread-chat",
      conversationMode: "chat",
      chatResponseMode: "two-phase",
      settings: { provider: "test", baseUrl: "", model: "model", apiKey: "", reasoning: { mode: "on" } },
      messages: [{ role: "user", content: "看看屏幕" }],
      toolSystemContent: "tools",
      soulSystemBaseContent: "persona",
    } as never, new AbortController().signal);

    expect(prepared.vendorConfig.reasoning).toEqual({ mode: "off" });
    expect(materializeHarnessStartTranscript).toHaveBeenCalledWith(expect.objectContaining({
      includeTodoContext: false,
    }));
    expect(runStore.create).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({ reasoning: JSON.stringify({ mode: "off" }) }),
    }));
  });

  it("uses the dedicated Tool reasoning preference without changing Soul settings", async () => {
    const prepared = await prepareHarnessRun({
      runId: "run-chat-tool-reasoning",
      conversationId: "thread-chat",
      conversationMode: "chat",
      chatResponseMode: "two-phase",
      toolReasoning: { mode: "on", effort: "high" },
      settings: { provider: "test", baseUrl: "", model: "model", apiKey: "", reasoning: { mode: "off" } },
      messages: [{ role: "user", content: "看看屏幕" }],
      toolSystemContent: "tools",
      soulSystemBaseContent: "persona",
    } as never, new AbortController().signal);

    expect(prepared.vendorConfig.reasoning).toEqual({ mode: "on", effort: "high" });
    expect(runStore.create).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({ reasoning: JSON.stringify({ mode: "on", effort: "high" }) }),
    }));
  });
});
