import { describe, expect, it, vi } from "vitest";
import { nativeTheme } from "electron";
import { getEffectiveUiTheme, watchSystemUiTheme } from "./system-ui-theme";

const themeMock = vi.hoisted(() => ({
  shouldUseDarkColors: false,
  listener: undefined as (() => void) | undefined,
}));

vi.mock("electron", () => ({
  nativeTheme: {
    get shouldUseDarkColors() { return themeMock.shouldUseDarkColors; },
    on: vi.fn((_event: string, listener: () => void) => { themeMock.listener = listener; }),
    off: vi.fn((_event: string, listener: () => void) => {
      if (themeMock.listener === listener) themeMock.listener = undefined;
    }),
  },
}));

describe("system UI theme", () => {
  it("resolves saved choices using the native system appearance", () => {
    themeMock.shouldUseDarkColors = true;
    expect(getEffectiveUiTheme("system")).toBe("charcoal-pink");
    expect(getEffectiveUiTheme("pearl-white")).toBe("pearl-white");
    themeMock.shouldUseDarkColors = false;
    expect(getEffectiveUiTheme("system")).toBe("pearl-white");
  });

  it("broadcasts live changes only while following the system", () => {
    let choice: "system" | "pearl-white" = "system";
    const broadcast = vi.fn();
    const stop = watchSystemUiTheme(() => choice, broadcast);
    expect(nativeTheme.on).toHaveBeenCalledWith("updated", expect.any(Function));

    themeMock.shouldUseDarkColors = true;
    themeMock.listener?.();
    expect(broadcast).toHaveBeenCalledWith("charcoal-pink");

    choice = "pearl-white";
    themeMock.shouldUseDarkColors = false;
    themeMock.listener?.();
    expect(broadcast).toHaveBeenCalledTimes(1);

    stop();
    expect(nativeTheme.off).toHaveBeenCalledWith("updated", expect.any(Function));
  });
});
