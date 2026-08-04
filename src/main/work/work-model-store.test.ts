import fs from "fs";
import os from "os";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const electronMock = vi.hoisted(() => ({ userDataDir: "" }));

vi.mock("electron", () => ({ app: { getPath: () => electronMock.userDataDir } }));

describe("Work model selection isolation", () => {
  beforeEach(() => {
    vi.resetModules();
    electronMock.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-work-model-"));
  });

  it("stores a complete Work profile without writing Chat model settings", async () => {
    const store = await import("./work-model-store");
    store.saveWorkModelSettings({
      schemaVersion: 2,
      provider: "openai",
      baseUrl: "https://work.example/v1",
      model: "work-model",
      apiKey: "work-key",
      explicitTransport: "openai",
      perProvider: {},
    });

    expect(store.loadWorkModelSettings()).toEqual(expect.objectContaining({
      provider: "openai",
      baseUrl: "https://work.example/v1",
      model: "work-model",
      apiKey: "work-key",
      explicitTransport: "openai",
    }));
    expect(fs.existsSync(path.join(electronMock.userDataDir, "cyrene-work", "settings.json"))).toBe(true);
    expect(fs.existsSync(path.join(electronMock.userDataDir, "model-settings.json"))).toBe(false);
  });

  it("recognizes the previous provider and model selection for migration", async () => {
    const workDir = path.join(electronMock.userDataDir, "cyrene-work");
    fs.mkdirSync(workDir, { recursive: true });
    fs.writeFileSync(path.join(workDir, "settings.json"), JSON.stringify({ provider: "legacy", model: "legacy-model" }));
    const store = await import("./work-model-store");

    expect(store.loadLegacyWorkModelSelection()).toEqual({ provider: "legacy", model: "legacy-model" });
    expect(store.loadWorkModelSettings()).toBeNull();
  });

  it("persists Work vision settings independently", async () => {
    const store = await import("./work-model-store");
    store.saveWorkModelSettings({
      schemaVersion: 2,
      provider: "openai",
      baseUrl: "https://work.example/v1",
      model: "work-model",
      apiKey: "work-key",
      perProvider: {},
      vision: {
        syncWithMain: false,
        baseUrl: "https://vision.example/v1",
        model: "work-vision-model",
        apiKey: "work-vision-key",
      },
    });

    expect(store.loadWorkModelSettings()?.vision).toEqual({
      syncWithMain: false,
      baseUrl: "https://vision.example/v1",
      model: "work-vision-model",
      apiKey: "work-vision-key",
    });
    expect(fs.existsSync(path.join(electronMock.userDataDir, "model-settings.json"))).toBe(false);
  });
});
