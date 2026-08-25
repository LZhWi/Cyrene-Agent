import * as fs from "fs";
import type { HoloCubicSettings } from "../../shared/holocubic-types";
import { writeJsonAtomicSync } from "../runtime/atomic-file";

export const DEFAULT_HOLOCUBIC_SETTINGS: HoloCubicSettings = {
  enabled: false,
  host: "192.168.3.40",
  port: 8766,
  frameRate: 5,
  jpegQuality: 60,
};

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.round(parsed))) : fallback;
}

export function normalizeHoloCubicSettings(input: Partial<HoloCubicSettings> | null | undefined): HoloCubicSettings {
  const candidateHost = typeof input?.host === "string" ? input.host.trim() : "";
  const host = /^[a-zA-Z0-9.-]+$/.test(candidateHost) ? candidateHost : DEFAULT_HOLOCUBIC_SETTINGS.host;
  return {
    enabled: input?.enabled === undefined ? DEFAULT_HOLOCUBIC_SETTINGS.enabled : Boolean(input.enabled),
    host,
    port: clampInteger(input?.port, DEFAULT_HOLOCUBIC_SETTINGS.port, 1, 65535),
    frameRate: clampInteger(input?.frameRate, DEFAULT_HOLOCUBIC_SETTINGS.frameRate, 1, 15),
    jpegQuality: clampInteger(input?.jpegQuality, DEFAULT_HOLOCUBIC_SETTINGS.jpegQuality, 20, 95),
  };
}

export class HoloCubicSettingsStore {
  constructor(private readonly getSettingsPath: () => string) {}

  load(): HoloCubicSettings {
    try {
      const filePath = this.getSettingsPath();
      if (!fs.existsSync(filePath)) return { ...DEFAULT_HOLOCUBIC_SETTINGS };
      return normalizeHoloCubicSettings(JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<HoloCubicSettings>);
    } catch (error) {
      console.error("[HoloCubic] load settings failed:", error);
      return { ...DEFAULT_HOLOCUBIC_SETTINGS };
    }
  }

  save(patch: Partial<HoloCubicSettings>): HoloCubicSettings {
    const settings = normalizeHoloCubicSettings({ ...this.load(), ...patch });
    writeJsonAtomicSync(this.getSettingsPath(), settings);
    return settings;
  }
}
