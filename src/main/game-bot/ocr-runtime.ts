import * as fs from "fs";
import * as path from "path";

export interface OcrLaunchConfig {
  command: string;
  args: string[];
  source: "custom" | "better-hsrcw";
}

const RAPID_OCR_RELATIVE = path.join("OCRRuntime", "rapidocr_bridge", "rapidocr_bridge.exe");

export function betterOcrCandidates(appPath: string, envHome = process.env.BETTER_HSRCW_HOME): string[] {
  const candidates = [
    envHome ? path.join(envHome, "current", RAPID_OCR_RELATIVE) : "",
    path.join(appPath, RAPID_OCR_RELATIVE),
    path.join(path.parse(appPath).root, "Better-HSRCW-V13-Portable", "current", RAPID_OCR_RELATIVE),
    path.join("E:\\", "Better-HSRCW-V13-Portable", "current", RAPID_OCR_RELATIVE),
  ].filter(Boolean);
  return Array.from(new Set(candidates.map((candidate) => path.normalize(candidate))));
}

export function resolveOcrLaunchConfig(options: {
  command: string;
  args: string[];
  autoDetect: boolean;
  appPath: string;
  exists?: (candidate: string) => boolean;
}): OcrLaunchConfig | null {
  if (options.command.trim()) {
    return { command: options.command.trim(), args: [...options.args], source: "custom" };
  }
  if (!options.autoDetect) return null;
  const exists = options.exists ?? fs.existsSync;
  const detected = betterOcrCandidates(options.appPath).find(exists);
  return detected ? { command: detected, args: ["--server"], source: "better-hsrcw" } : null;
}
