import { describe, expect, it } from "vitest";
import { revealStartupWindows } from "./startup-window-reveal";

interface FakeWindow {
  close(): void;
  isDestroyed(): boolean;
  isVisible(): boolean;
  show(): void;
}

function createFakeWindow(initiallyVisible = false): FakeWindow & {
  state: { destroyed: boolean; visible: boolean };
} {
  const state = { destroyed: false, visible: initiallyVisible };
  return {
    state,
    close: () => {
      state.destroyed = true;
      state.visible = false;
    },
    isDestroyed: () => state.destroyed,
    isVisible: () => state.visible,
    show: () => {
      state.visible = true;
    },
  };
}

describe("revealStartupWindows", () => {
  it("keeps the pet hidden when startup finishes with petVisible disabled", () => {
    const splashWindow = createFakeWindow(true);
    const petWindow = createFakeWindow(false);
    let startupReady = false;

    revealStartupWindows({
      splashWindow,
      petWindow,
      petVisible: false,
      markStartupReady: () => {
        startupReady = true;
      },
    });

    expect(splashWindow.state).toEqual({ destroyed: true, visible: false });
    expect(petWindow.state).toEqual({ destroyed: false, visible: false });
    expect(startupReady).toBe(true);
  });

  it("shows the pet when startup finishes with petVisible enabled", () => {
    const splashWindow = createFakeWindow(true);
    const petWindow = createFakeWindow(false);

    revealStartupWindows({
      splashWindow,
      petWindow,
      petVisible: true,
      markStartupReady: () => {},
    });

    expect(petWindow.state.visible).toBe(true);
  });
});
