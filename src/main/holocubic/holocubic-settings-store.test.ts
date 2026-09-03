import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_HOLOCUBIC_SETTINGS,
  HoloCubicSettingsStore,
  normalizeHoloCubicSettings,
} from "./holocubic-settings-store";

describe("HoloCubicSettingsStore", () => {
  let directory = "";
  let filePath = "";

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-holocubic-settings-"));
    filePath = path.join(directory, "nested", "holocubic-settings.json");
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("defaults to a disabled device bridge", () => {
    expect(new HoloCubicSettingsStore(() => filePath).load()).toEqual(DEFAULT_HOLOCUBIC_SETTINGS);
  });

  it("atomically persists a normalized partial update", () => {
    const saved = new HoloCubicSettingsStore(() => filePath).save({
      enabled: true,
      host: " 192.168.3.41 ",
      frameRate: 99,
      jpegQuality: 1,
    });

    expect(saved).toEqual({
      enabled: true,
      connectionMode: "direct",
      host: "192.168.3.41",
      port: 8766,
      frameRate: 15,
      jpegQuality: 20,
    });
    expect(JSON.parse(fs.readFileSync(filePath, "utf8"))).toEqual(saved);
    expect(fs.readdirSync(path.dirname(filePath))).toEqual(["holocubic-settings.json"]);
  });

  it("falls back safely when persisted JSON is invalid", () => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "{broken", "utf8");
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(new HoloCubicSettingsStore(() => filePath).load()).toEqual(DEFAULT_HOLOCUBIC_SETTINGS);
  });
});

describe("normalizeHoloCubicSettings", () => {
  it("clamps numeric fields and rejects a malformed host", () => {
    expect(normalizeHoloCubicSettings({ host: "device/path", port: 0, frameRate: 3.6, jpegQuality: 120 })).toEqual({
      enabled: false,
      connectionMode: "direct",
      host: "192.168.3.40",
      port: 1,
      frameRate: 4,
      jpegQuality: 95,
    });
  });

  it("accepts device-initiated listener mode", () => {
    expect(normalizeHoloCubicSettings({ connectionMode: "listen", host: "0.0.0.0" })).toMatchObject({
      connectionMode: "listen",
      host: "0.0.0.0",
    });
  });
});
