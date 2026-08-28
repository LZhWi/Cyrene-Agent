import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_GENERAL_SETTINGS,
  SettingsFacade,
  normalizeGeneralSettings,
} from "./settings-facade";

describe("SettingsFacade", () => {
  let directory = "";
  let filePath = "";

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-settings-facade-"));
    filePath = path.join(directory, "nested", "app-settings.json");
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("loads defaults when no settings file exists", () => {
    const facade = new SettingsFacade(() => filePath);
    expect(facade.load()).toEqual(DEFAULT_GENERAL_SETTINGS);
  });

  it("normalizes legacy and malformed field values without dropping valid settings", () => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({
      musicEnabled: true,
      musicVolume: 120,
      soundEnabled: false,
      petZoom: 3,
      petIdleMotionsEnabled: true,
      petWindowX: 10.6,
      petWindowY: Number.NaN,
      sidebarVisible: false,
      emailSmtpPort: 70000,
      asrLocalProfile: "qwen06-stream",
      asrHotwords: ["昔涟", " 昔涟 ", ""],
      ttsGptsovitsVersion: "v4",
      ttsGptsovitsTextSplitMethod: "cut2",
    }), "utf8");

    const settings = new SettingsFacade(() => filePath).load();
    expect(settings).toMatchObject({
      musicEnabled: true,
      musicVolume: 100,
      soundEnabled: false,
      petZoom: 2,
      petIdleMotionsEnabled: true,
      petWindowX: 11,
      sidebarVisible: false,
      tasksVisible: true,
      emailSmtpPort: 65535,
      asrLocalProfile: "qwen06-stream",
      asrHotwords: ["昔涟", "昔涟"],
      ttsGptsovitsVersion: "v4",
      ttsGptsovitsTextSplitMethod: "cut2",
    });
    expect(settings.petWindowY).toBeUndefined();
  });

  it("atomically persists a partial update and notifies after the file is readable", () => {
    const facade = new SettingsFacade(() => filePath);
    const listener = vi.fn((_before, after) => {
      expect(JSON.parse(fs.readFileSync(filePath, "utf8"))).toEqual(after);
    });
    facade.onChanged(listener);

    const saved = facade.save({
      musicEnabled: true,
      musicVolume: 37,
      uiTheme: "classic",
      petVisible: false,
      petIdleMotionsEnabled: true,
    });

    expect(saved).toMatchObject({
      musicEnabled: true,
      musicVolume: 37,
      petVisible: false,
      petIdleMotionsEnabled: true,
      soundEnabled: true,
    });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0]).toEqual(DEFAULT_GENERAL_SETTINGS);
    expect(fs.readdirSync(path.dirname(filePath))).toEqual(["app-settings.json"]);
  });

  it("falls back to defaults when persisted JSON cannot be parsed", () => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "{broken", "utf8");
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(new SettingsFacade(() => filePath).load()).toEqual(DEFAULT_GENERAL_SETTINGS);
    expect(console.error).toHaveBeenCalledOnce();
  });
});

describe("normalizeGeneralSettings", () => {
  it("keeps boundary values and applies stable defaults", () => {
    const settings = normalizeGeneralSettings({
      petZoom: 0.5,
      ttsSpeed: 2,
      ttsVolume: 0,
      asrVadSilenceMs: 300,
      asrVadThreshold: 0.5,
      ttsCustomCloudTimeoutMs: 120000,
    });

    expect(settings).toMatchObject({
      petZoom: 0.5,
      ttsSpeed: 2,
      ttsVolume: 0,
      asrVadSilenceMs: 300,
      asrVadThreshold: 0.5,
      ttsCustomCloudTimeoutMs: 120000,
      defaultChatMode: "collab",
      proactiveDeliveryTarget: "local",
    });
  });
});
