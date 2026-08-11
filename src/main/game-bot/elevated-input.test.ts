import { describe, expect, it } from "vitest";
import { ELEVATED_INPUT_HELPER_SCRIPT } from "./elevated-input-helper-script";
import { encodePowerShellCommand } from "./elevated-input";

describe("elevated gamebot input helper", () => {
  it("enables Per-Monitor V2 DPI awareness before connecting the input pipe", () => {
    expect(ELEVATED_INPUT_HELPER_SCRIPT).toContain("SetProcessDpiAwarenessContext");
    expect(ELEVATED_INPUT_HELPER_SCRIPT).toContain("new IntPtr(-4)");
    expect(ELEVATED_INPUT_HELPER_SCRIPT.indexOf("[CyreneGameBotInput]::EnablePerMonitorV2()"))
      .toBeLessThan(ELEVATED_INPUT_HELPER_SCRIPT.indexOf("$pipe ="));
  });

  it("使用与 Better-HSRCW 相同的窗口激活和鼠标事件", () => {
    expect(ELEVATED_INPUT_HELPER_SCRIPT).toContain("SetForegroundWindow");
    expect(ELEVATED_INPUT_HELPER_SCRIPT).toContain("SetCursorPos");
    expect(ELEVATED_INPUT_HELPER_SCRIPT).toContain("mouse_event(2");
    expect(ELEVATED_INPUT_HELPER_SCRIPT).toContain("mouse_event(4");
  });

  it("PowerShell EncodedCommand 使用 UTF-16LE", () => {
    const command = "Write-Output '测试'";
    expect(Buffer.from(encodePowerShellCommand(command), "base64").toString("utf16le")).toBe(command);
  });
});
