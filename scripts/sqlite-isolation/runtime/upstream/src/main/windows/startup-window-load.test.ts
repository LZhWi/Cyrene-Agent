import { describe, expect, it, vi } from "vitest";
import { loadWindowForStartup, type StartupLoadWindowLike } from "./startup-window-load";

type ReadyListener = () => void;
type FailListener = (event: unknown, code: number, description: string, url: string, isMainFrame: boolean) => void;

function createFakeStartupWindow(): StartupLoadWindowLike & {
  emitReady(): void;
  emitFail(code: number, description: string, isMainFrame?: boolean): void;
  readyListeners: ReadyListener[];
  failListeners: FailListener[];
} {
  const readyListeners: ReadyListener[] = [];
  const failListeners: FailListener[] = [];
  return {
    readyListeners,
    failListeners,
    once: vi.fn((event: "ready-to-show", listener: ReadyListener) => {
      if (event === "ready-to-show") readyListeners.push(listener);
    }),
    removeListener: vi.fn((event: "ready-to-show", listener: ReadyListener) => {
      if (event === "ready-to-show") {
        const index = readyListeners.indexOf(listener);
        if (index >= 0) readyListeners.splice(index, 1);
      }
    }),
    webContents: {
      once: vi.fn((_event: "did-fail-load", listener: FailListener) => {
        failListeners.push(listener);
      }),
      removeListener: vi.fn((_event: "did-fail-load", listener: FailListener) => {
        const index = failListeners.indexOf(listener);
        if (index >= 0) failListeners.splice(index, 1);
      }),
    },
    emitReady() {
      for (const listener of [...readyListeners]) listener();
    },
    emitFail(code: number, description: string, isMainFrame = true) {
      for (const listener of [...failListeners]) listener({}, code, description, "http://localhost", isMainFrame);
    },
  };
}

describe("loadWindowForStartup", () => {
  it("attaches listeners before invoking load and resolves on ready-to-show", async () => {
    const window = createFakeStartupWindow();
    const order: string[] = [];
    const pending = loadWindowForStartup({
      window,
      load: async () => { order.push("load"); },
      timeoutMs: 20_000,
    });
    expect(order).toEqual([]);
    expect(window.readyListeners).toHaveLength(1);
    expect(window.failListeners).toHaveLength(1);
    await Promise.resolve();
    expect(order).toEqual(["load"]);
    window.emitReady();
    await expect(pending).resolves.toBeUndefined();
    expect(window.readyListeners).toHaveLength(0);
    expect(window.failListeners).toHaveLength(0);
  });

  it("rejects when loadURL rejects", async () => {
    const window = createFakeStartupWindow();
    await expect(loadWindowForStartup({
      window,
      load: async () => { throw new Error("load failed"); },
      timeoutMs: 20_000,
    })).rejects.toThrow("load failed");
  });

  it("rejects when ready-to-show never arrives", async () => {
    vi.useFakeTimers();
    try {
      const window = createFakeStartupWindow();
      const pending = loadWindowForStartup({
        window,
        load: async () => undefined,
        timeoutMs: 20_000,
      });
      // 先挂上拒绝断言，避免超时拒绝在推进时钟的宏任务间隙被判定为 unhandled
      const assertion = expect(pending).rejects.toThrow("ready-to-show timeout");
      await vi.advanceTimersByTimeAsync(20_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects on main-frame load failure but ignores subframe failures", async () => {
    const window = createFakeStartupWindow();
    const pending = loadWindowForStartup({
      window,
      load: async () => undefined,
      timeoutMs: 20_000,
    });
    window.emitFail(-3, "ERR_ABORTED", false);
    window.emitReady();
    await expect(pending).resolves.toBeUndefined();

    const window2 = createFakeStartupWindow();
    const pending2 = loadWindowForStartup({
      window: window2,
      load: async () => undefined,
      timeoutMs: 20_000,
    });
    window2.emitFail(-2, "ERR_FAILED", true);
    await expect(pending2).rejects.toThrow("did-fail-load");
  });
});
