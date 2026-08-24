import { describe, expect, it } from "vitest";
import type { GeneralSettings } from "./general-settings";
import { normalizeGeneralSettings } from "./settings-facade";

describe("general LSP settings", () => {
  it("keeps valid user server overrides and safely drops malformed settings", () => {
    const settings = normalizeGeneralSettings({
      lspServerOverrides: [
        { id: "python-pyright", command: "basedpyright-langserver", args: ["--stdio"] },
        { id: "python-pyright", command: "duplicate" },
        { id: "unknown-server", command: "not-allowed" },
        { id: "gopls", command: "  " },
        { id: "typescript-language-server", initializationOptions: { preferences: { includeCompletionsForModuleExports: true } }, constructor: "unsafe" },
      ] as unknown as GeneralSettings["lspServerOverrides"],
    });

    expect(settings.lspServerOverrides).toEqual([
      { id: "python-pyright", command: "basedpyright-langserver", args: ["--stdio"] },
      { id: "typescript-language-server", initializationOptions: { preferences: { includeCompletionsForModuleExports: true } } },
    ]);
  });

  it("loads older settings without requiring an LSP migration", () => {
    expect(normalizeGeneralSettings({}).lspServerOverrides).toEqual([]);
  });
});

describe("general Harness tool concurrency settings", () => {
  it("defaults to four and normalizes the configured safe range", () => {
    expect(normalizeGeneralSettings({}).maxParallelToolCalls).toBe(4);
    expect(normalizeGeneralSettings({ maxParallelToolCalls: 0 } as never).maxParallelToolCalls).toBe(1);
    expect(normalizeGeneralSettings({ maxParallelToolCalls: 99 } as never).maxParallelToolCalls).toBe(8);
    expect(normalizeGeneralSettings({ maxParallelToolCalls: 3.8 } as never).maxParallelToolCalls).toBe(3);
    expect(normalizeGeneralSettings({ maxParallelToolCalls: "invalid" } as never).maxParallelToolCalls).toBe(4);
  });
});

describe("general ASR settings", () => {
  it("keeps Mossland as a supported ASR provider", () => {
    const settings = normalizeGeneralSettings({ asrEngine: "mossland" } as never);

    expect(settings.asrEngine).toBe("mossland");
  });
});
