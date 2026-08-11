import * as path from "path";
import { describe, expect, it } from "vitest";
import { betterOcrCandidates, resolveOcrLaunchConfig } from "./ocr-runtime";

describe("gamebot OCR runtime", () => {
  it("优先使用自定义 OCR", () => {
    expect(resolveOcrLaunchConfig({
      command: "custom.exe", args: ["--server"], autoDetect: true, appPath: "E:\\Cyrene", exists: () => true,
    })).toEqual({ command: "custom.exe", args: ["--server"], source: "custom" });
  });

  it("自动发现同盘 Better-HSRCW RapidOCR", () => {
    const candidates = betterOcrCandidates("E:\\Cyrene-Agent");
    const expected = path.normalize("E:\\Better-HSRCW-V13-Portable\\current\\OCRRuntime\\rapidocr_bridge\\rapidocr_bridge.exe");
    expect(candidates).toContain(expected);
    expect(resolveOcrLaunchConfig({
      command: "", args: [], autoDetect: true, appPath: "E:\\Cyrene-Agent", exists: (candidate) => candidate === expected,
    })).toEqual({ command: expected, args: ["--server"], source: "better-hsrcw" });
  });

  it("关闭自动检测时不使用外部 OCR", () => {
    expect(resolveOcrLaunchConfig({
      command: "", args: [], autoDetect: false, appPath: "E:\\Cyrene-Agent", exists: () => true,
    })).toBeNull();
  });
});
