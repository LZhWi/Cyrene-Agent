import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { inputs, timeoutInput, runtimeStatus } = vi.hoisted(() => ({
  inputs: {
    timeoutUserChoiceInput: { value: "60" },
    timeoutUserChoiceReset: { addEventListener: vi.fn() },
    timeoutTestInput: { value: "15000" },
    timeoutTestReset: { addEventListener: vi.fn() },
    maxParallelToolCallsInput: { value: "4" },
    modelRequestMaxRetriesInput: { value: "5" },
  },
  timeoutInput: { value: "" },
  runtimeStatus: vi.fn(),
}));
vi.mock("./dom", () => inputs);
vi.mock("../api/dom", () => ({
  modelRequestTimeoutSecInput: timeoutInput,
  modelRequestTimeoutSecReset: { addEventListener: vi.fn() },
}));
vi.mock("../shared/save-status", () => ({ setRuntimeSaveStatus: runtimeStatus, setSaveStatus: vi.fn() }));

function settingsBridge() {
  return {
    getTimeoutSettings: vi.fn(async () => ({ userChoiceTimeout: 60000, testTimeout: 15000 })),
    getConfig: vi.fn(async () => ({ modelRequestMaxRetries: 7 })),
    getGeneral: vi.fn(async () => ({ maxParallelToolCalls: 4 })),
    saveTimeoutSettings: vi.fn(async () => undefined),
    saveConfig: vi.fn(async () => undefined),
    saveGeneral: vi.fn(async () => undefined),
  };
}
beforeEach(() => vi.resetModules());
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("native timeout settings retry control", () => {
  it("loads, saves and reloads the retry setting through the native settings bridge", async () => {
    const bridge = settingsBridge();
    vi.stubGlobal("window", { settings: bridge });
    const panel = await import("./panel");
    await panel.loadTimeoutSettings();
    expect(inputs.modelRequestMaxRetriesInput.value).toBe("7");
    inputs.modelRequestMaxRetriesInput.value = "0";
    expect(await panel.saveTimeoutSettings(false)).toBe(true);
    expect(bridge.saveConfig).toHaveBeenCalledWith({ modelRequestMaxRetries: 0 });
  });

  it.each(["", "-1", "11", "2.5", "invalid"])("rejects invalid retry input %s before any writes", async (value) => {
    const bridge = settingsBridge();
    vi.stubGlobal("window", { settings: bridge });
    const panel = await import("./panel");
    await panel.loadTimeoutSettings();
    inputs.modelRequestMaxRetriesInput.value = value;
    expect(await panel.saveTimeoutSettings(false)).toBe(false);
    expect(bridge.saveTimeoutSettings).not.toHaveBeenCalled();
    expect(bridge.saveConfig).not.toHaveBeenCalled();
  });

  it("does not alter the retry count when saving only the connection-test timeout", async () => {
    const bridge = settingsBridge();
    vi.stubGlobal("window", { settings: bridge });
    const panel = await import("./panel");
    await panel.loadTimeoutSettings();
    inputs.modelRequestMaxRetriesInput.value = "invalid";
    expect(await panel.saveTimeoutSettings(true)).toBe(true);
    expect(bridge.saveTimeoutSettings).toHaveBeenCalledWith({ testTimeout: 15000 });
    expect(bridge.saveConfig).not.toHaveBeenCalled();
  });
});
