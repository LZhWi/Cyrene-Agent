import { describe, expect, it, vi } from "vitest";
import { WindowManager } from "./window-manager";

function createFakeWindow() {
  const listeners = new Map<string, Array<() => void>>();
  let destroyed = false;
  let visible = false;
  let position: [number, number] = [100, 200];
  const resizedImage = {
    toJPEG: vi.fn(() => Buffer.from("jpeg")),
  };
  const capturedImage = {
    toDataURL: vi.fn(() => "data:image/png;base64,test"),
    isEmpty: vi.fn(() => false),
    resize: vi.fn(() => resizedImage),
  };
  const window = {
    isDestroyed: vi.fn(() => destroyed),
    isVisible: vi.fn(() => visible),
    show: vi.fn(() => { visible = true; }),
    showInactive: vi.fn(() => { visible = true; }),
    hide: vi.fn(() => { visible = false; }),
    minimize: vi.fn(),
    setAlwaysOnTop: vi.fn(),
    setIgnoreMouseEvents: vi.fn(),
    setOpacity: vi.fn(),
    setBounds: vi.fn(),
    getPosition: vi.fn(() => position),
    setPosition: vi.fn((x: number, y: number) => { position = [x, y]; }),
    on: vi.fn((event: string, listener: () => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    }),
    webContents: {
      isDestroyed: vi.fn(() => destroyed),
      send: vi.fn(),
      capturePage: vi.fn(async () => capturedImage),
    },
  };
  return {
    window,
    capturedImage,
    resizedImage,
    close: () => {
      destroyed = true;
      for (const listener of listeners.get("closed") ?? []) listener();
    },
  };
}

function createManager(persistMainWindowPosition = vi.fn()) {
  return new WindowManager({
    baseWidth: 400,
    baseHeight: 500,
    persistMainWindowPosition,
  });
}

describe("WindowManager", () => {
  it("owns main-window visibility, interaction, zoom, and messaging", () => {
    const fake = createFakeWindow();
    const manager = createManager();
    manager.attachMainWindow(fake.window as never);

    manager.showMainWindow(true);
    manager.setMainWindowAlwaysOnTop(true);
    manager.setMainWindowInteractive(false);
    manager.applyMainWindowZoom(1.25);
    manager.sendToMainWindow("test:event", { ok: true });

    expect(fake.window.showInactive).toHaveBeenCalledOnce();
    expect(fake.window.setAlwaysOnTop).toHaveBeenCalledWith(true, "screen-saver");
    expect(fake.window.setIgnoreMouseEvents).toHaveBeenCalledWith(true, { forward: true });
    expect(fake.window.setBounds).toHaveBeenCalledWith({ width: 500, height: 625 });
    expect(fake.window.webContents.send).toHaveBeenCalledWith("test:event", { ok: true });
  });

  it("clears only the window instance that actually closed", () => {
    const first = createFakeWindow();
    const second = createFakeWindow();
    const manager = createManager();

    manager.attachMainWindow(first.window as never);
    manager.attachMainWindow(second.window as never);
    first.close();

    expect(manager.getMainWindow()).toBe(second.window);
    second.close();
    expect(manager.getMainWindow()).toBeNull();
  });

  it("moves the pet through the existing normalized movement controller", () => {
    const persist = vi.fn();
    const fake = createFakeWindow();
    const manager = createManager(persist);
    manager.attachMainWindow(fake.window as never);

    manager.moveMainWindowRelative(10.4, -20.6);
    manager.setMainWindowDragging(false);

    expect(fake.window.setPosition).toHaveBeenCalledWith(110, 179, false);
    expect(persist).toHaveBeenCalledWith({ x: 110, y: 179 });
  });

  it("captures through the current live window and ignores destroyed windows", async () => {
    const fake = createFakeWindow();
    const manager = createManager();
    manager.attachMainWindow(fake.window as never);

    await expect(manager.captureMainWindowFrame()).resolves.toBe("data:image/png;base64,test");
    fake.close();
    manager.sendToMainWindow("ignored");
    await expect(manager.captureMainWindow()).resolves.toBeNull();
    expect(fake.window.webContents.send).not.toHaveBeenCalled();
  });

  it("captures a bounded binary JPEG without changing the existing PNG path", async () => {
    const fake = createFakeWindow();
    const manager = createManager();
    manager.attachMainWindow(fake.window as never);

    await expect(manager.captureMainWindowJpeg(320.4, 239.6, 61.7)).resolves.toEqual(Buffer.from("jpeg"));
    expect(fake.capturedImage.resize).toHaveBeenCalledWith({ width: 320, height: 240, quality: "good" });
    expect(fake.resizedImage.toJPEG).toHaveBeenCalledWith(62);
  });
});
