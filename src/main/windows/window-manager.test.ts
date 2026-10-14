import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createPetWindow: vi.fn(), createdWindows: [] as Array<ReturnType<typeof createFakeWindow>> }));

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  screen: { getCursorScreenPoint: vi.fn(() => ({ x: 0, y: 0 })) },
}));
vi.mock("../startup/create-pet-window", () => ({
  createPetWindow: mocks.createPetWindow, PET_WINDOW_BASE_HEIGHT: 500, PET_WINDOW_BASE_WIDTH: 400,
}));
vi.mock("./create-aux-windows", () => ({
  createCallWindow: vi.fn(), createReactChatWindowShell: vi.fn(), createReactWorkspaceWindowShell: vi.fn(),
  createSettingsWindow: vi.fn(), createSidebarWindow: vi.fn(), createStickerManagerWindow: vi.fn(),
  createTasksWindow: vi.fn(), loadReactChatWindowPage: vi.fn(), showReactChatWindow: vi.fn(),
  showReactWorkspaceWindow: vi.fn(),
}));
vi.mock("./startup-window-load", () => ({ CHAT_READY_TIMEOUT_MS: 1, loadWindowForStartup: vi.fn() }));
vi.mock("./create-music-player-window", () => ({ createMusicPlayerWindow: vi.fn() }));
vi.mock("./broadcast", () => ({ broadcastToAllWindows: vi.fn() }));
vi.mock("../pet-window-movement", () => ({
  PetWindowMoveController: class { dispose() {} finishDragging() {} moveRelative() {} queueAbsolute() {} },
}));
vi.mock("../chats/chats-store", () => ({ getSession: vi.fn() }));

function createFakeWindow() {
  const listeners = new Map<string, Array<() => void>>();
  let visible = false;
  let destroyed = false;
  return {
    on: vi.fn((event: string, listener: () => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    }),
    once: vi.fn((event: string, listener: () => void) => {
      const wrapped = () => {
        listeners.set(event, (listeners.get(event) ?? []).filter((item) => item !== wrapped));
        listener();
      };
      listeners.set(event, [...(listeners.get(event) ?? []), wrapped]);
    }),
    emit(event: string) { for (const listener of [...(listeners.get(event) ?? [])]) listener(); },
    hide: vi.fn(() => { visible = false; for (const listener of [...(listeners.get("hide") ?? [])]) listener(); }),
    show: vi.fn(() => { visible = true; for (const listener of [...(listeners.get("show") ?? [])]) listener(); }),
    destroy: vi.fn(() => { destroyed = true; for (const listener of [...(listeners.get("closed") ?? [])]) listener(); }),
    isDestroyed: vi.fn(() => destroyed),
    isVisible: vi.fn(() => visible),
    setAlwaysOnTop: vi.fn(),
    getPosition: vi.fn(() => [0, 0]),
  };
}

import { createWindowManager } from "./window-manager";

describe("pet window resource release", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.createdWindows = [];
    mocks.createPetWindow.mockImplementation(() => {
      const window = createFakeWindow();
      mocks.createdWindows.push(window);
      return window;
    });
  });
  afterEach(() => vi.useRealTimers());

  it("releases a hidden window after 30 seconds and restores topmost on recreation", () => {
    const manager = createWindowManager({
      getCurrentAppIconPath: () => "icon", isDev: false,
      loadPetWindowSettingsSlice: () => ({ petAlwaysOnTop: true }), persistPetWindowPosition: vi.fn(),
    });
    const first = manager.createPetWindow();
    manager.hidePetWindow();
    vi.advanceTimersByTime(29_999);
    expect(first.destroy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(first.destroy).toHaveBeenCalledOnce();
    manager.showPetWindow();
    expect(mocks.createdWindows).toHaveLength(2);
    expect(mocks.createdWindows[1].setAlwaysOnTop).toHaveBeenCalledWith(true, "screen-saver");
    manager.dispose();
  });

  it("cancels the release when the window is shown again", () => {
    const manager = createWindowManager({
      getCurrentAppIconPath: () => "icon", isDev: false,
      loadPetWindowSettingsSlice: () => ({ petAlwaysOnTop: false }), persistPetWindowPosition: vi.fn(),
    });
    const window = manager.createPetWindow();
    manager.hidePetWindow();
    vi.advanceTimersByTime(20_000);
    manager.showPetWindow();
    vi.advanceTimersByTime(30_000);
    expect(window.destroy).not.toHaveBeenCalled();
    expect(window.setAlwaysOnTop).toHaveBeenCalledWith(false, "normal");
    manager.dispose();
  });
});
