import type { BrowserWindow, NativeImage } from "electron";
import { describe, expect, it, vi } from "vitest";
import { attachWindowIconLifecycle } from "./window-icon-lifecycle";

describe("attachWindowIconLifecycle", () => {
  it("sets the icon immediately and refreshes it at ready-to-show", () => {
    let readyHandler: (() => void) | undefined;
    const window = {
      isDestroyed: vi.fn(() => false),
      setIcon: vi.fn(),
      once: vi.fn((event: string, handler: () => void) => {
        expect(event).toBe("ready-to-show");
        readyHandler = handler;
      }),
    } as unknown as BrowserWindow;
    const icon = { isEmpty: () => false } as NativeImage;
    const getIconPath = vi.fn(() => "C:\\icons\\cyrene.ico");

    attachWindowIconLifecycle(window, getIconPath, {
      createNativeImage: vi.fn(() => icon),
      warn: vi.fn(),
    });
    readyHandler?.();

    expect(getIconPath).toHaveBeenCalledTimes(2);
    expect(window.setIcon).toHaveBeenCalledTimes(2);
    expect(window.setIcon).toHaveBeenNthCalledWith(1, icon);
    expect(window.setIcon).toHaveBeenNthCalledWith(2, icon);
  });

  it("does not touch a destroyed window", () => {
    const window = {
      isDestroyed: vi.fn(() => true),
      setIcon: vi.fn(),
      once: vi.fn(),
    } as unknown as BrowserWindow;
    const createNativeImage = vi.fn();

    attachWindowIconLifecycle(window, vi.fn(() => "unused.ico"), {
      createNativeImage,
      warn: vi.fn(),
    });

    expect(createNativeImage).not.toHaveBeenCalled();
    expect(window.setIcon).not.toHaveBeenCalled();
  });
});
