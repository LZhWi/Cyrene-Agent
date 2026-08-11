import { describe, expect, it } from "vitest";
import { isProcessProbeRunning } from "./process-tools";

describe("gamebot process tools", () => {
  it("识别运行标记", () => {
    expect(isProcessProbeRunning("RUNNING\r\n")).toBe(true);
  });

  it("拒绝空结果和其他输出", () => {
    expect(isProcessProbeRunning("")).toBe(false);
    expect(isProcessProbeRunning("ERROR")).toBe(false);
  });
});
