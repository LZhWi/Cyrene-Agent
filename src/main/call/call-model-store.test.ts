import fs from "fs";
import os from "os";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const electronMock = vi.hoisted(() => ({ userDataDir: "" }));

vi.mock("electron", () => ({ app: { getPath: () => electronMock.userDataDir } }));

describe("Call model settings isolation", () => {
  beforeEach(() => {
    vi.resetModules();
    electronMock.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-call-model-"));
  });

  it("stores a complete call profile separately from Chat and Work", async () => {
    const store = await import("./call-model-store");
    store.saveCallModelSettings({
      schemaVersion: 1,
      provider: "openai",
      baseUrl: "https://call.example/v1",
      model: "call-model",
      apiKey: "call-key",
      explicitTransport: "openai",
      reasoning: { mode: "on", effort: "low" },
      perProvider: {},
    });

    expect(store.loadCallModelSettings()).toEqual(expect.objectContaining({
      provider: "openai",
      baseUrl: "https://call.example/v1",
      model: "call-model",
      apiKey: "call-key",
      explicitTransport: "openai",
      reasoning: { mode: "on", effort: "low" },
    }));
    expect(fs.existsSync(path.join(electronMock.userDataDir, "cyrene-call", "settings.json"))).toBe(true);
    expect(fs.existsSync(path.join(electronMock.userDataDir, "model-settings.json"))).toBe(false);
    expect(fs.existsSync(path.join(electronMock.userDataDir, "cyrene-work", "settings.json"))).toBe(false);
  });

  it("keeps provider profiles when switching the active call model", async () => {
    const store = await import("./call-model-store");
    store.saveCallModelSettings({
      schemaVersion: 1,
      provider: "one",
      baseUrl: "https://one.example/v1",
      model: "one-model",
      apiKey: "one-key",
      perProvider: {},
    });
    store.saveCallModelSettings({
      schemaVersion: 1,
      provider: "two",
      baseUrl: "https://two.example/v1",
      model: "two-model",
      apiKey: "two-key",
      perProvider: {},
    });

    const saved = store.loadCallModelSettings();
    expect(saved?.provider).toBe("two");
    expect(saved?.perProvider.one?.model).toBe("one-model");
    expect(saved?.perProvider.two?.model).toBe("two-model");
  });
});
