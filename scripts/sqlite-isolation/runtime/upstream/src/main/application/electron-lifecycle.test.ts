import { describe, expect, it, vi } from "vitest";
import { createStartupReadiness } from "./readiness";
import { createShutdownCoordinator, type ShutdownCoordinator } from "./shutdown";
import { attachWindowsSessionEndHandlers, installAppShutdownHandlers } from "./electron-lifecycle";

type QuitEvent = { preventDefault(): void };

function createFakeApp() {
  const listeners = new Map<string, Set<(event: QuitEvent) => void>>();
  return {
    on: vi.fn((event: "before-quit", listener: (event: QuitEvent) => void) => {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
    }),
    removeListener: vi.fn((event: "before-quit", listener: (event: QuitEvent) => void) => {
      listeners.get(event)?.delete(listener);
    }),
    quit: vi.fn(),
    emit(event: "before-quit"): QuitEvent {
      const quitEvent: QuitEvent = { preventDefault: vi.fn() };
      for (const listener of [...(listeners.get(event) ?? [])]) listener(quitEvent);
      return quitEvent;
    },
  };
}

function createFakeWindow() {
  const listeners = new Map<string, Set<(event: QuitEvent) => void>>();
  return {
    on: vi.fn((event: "query-session-end" | "session-end", listener: (event: QuitEvent) => void) => {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
    }),
    removeListener: vi.fn((event: "query-session-end" | "session-end", listener: (event: QuitEvent) => void) => {
      listeners.get(event)?.delete(listener);
    }),
    emit(event: "query-session-end" | "session-end"): QuitEvent {
      const endEvent: QuitEvent = { preventDefault: vi.fn() };
      for (const listener of [...(listeners.get(event) ?? [])]) listener(endEvent);
      return endEvent;
    },
  };
}

function createCoordinatorForLifecycle(): ShutdownCoordinator {
  return createShutdownCoordinator({ readiness: createStartupReadiness(), timeoutMs: 1000 });
}

describe("installAppShutdownHandlers", () => {
  it("prevents the first before-quit and runs the controlled shutdown before quitting", async () => {
    const app = createFakeApp();
    const coordinator = createCoordinatorForLifecycle();
    const unregister = installAppShutdownHandlers({ app, coordinator });
    const quitEvent = app.emit("before-quit");
    expect(quitEvent.preventDefault).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledOnce());
    expect(coordinator.isFinalizing()).toBe(true);
    unregister();
  });

  it("lets quit pass through without preventDefault once finalizing", async () => {
    const app = createFakeApp();
    const coordinator = createCoordinatorForLifecycle();
    installAppShutdownHandlers({ app, coordinator });
    app.emit("before-quit");
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledOnce());
    const second = app.emit("before-quit");
    expect(second.preventDefault).not.toHaveBeenCalled();
  });

  it("stops intercepting quit after the disposer runs", () => {
    const app = createFakeApp();
    const coordinator = createCoordinatorForLifecycle();
    const unregister = installAppShutdownHandlers({ app, coordinator });
    unregister();
    const quitEvent = app.emit("before-quit");
    expect(quitEvent.preventDefault).not.toHaveBeenCalled();
    expect(app.removeListener).toHaveBeenCalledWith("before-quit", expect.any(Function));
  });
});

describe("attachWindowsSessionEndHandlers", () => {
  it("performs emergency flush synchronously on both query-session-end and session-end", () => {
    const window = createFakeWindow();
    const coordinator = createCoordinatorForLifecycle();
    const flush = vi.fn();
    coordinator.registerEmergencyFlush("token-usage", flush);
    const unregister = attachWindowsSessionEndHandlers({ window, coordinator });
    window.emit("query-session-end");
    window.emit("session-end");
    expect(flush).toHaveBeenCalledOnce();
    expect(coordinator.isStopping()).toBe(false);
    unregister();
  });

  it("stops flushing after the disposer runs", () => {
    const window = createFakeWindow();
    const coordinator = createCoordinatorForLifecycle();
    const flush = vi.fn();
    coordinator.registerEmergencyFlush("token-usage", flush);
    const unregister = attachWindowsSessionEndHandlers({ window, coordinator });
    unregister();
    window.emit("session-end");
    expect(flush).not.toHaveBeenCalled();
  });
});
