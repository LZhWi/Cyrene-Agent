import { describe, it, expect, beforeEach, vi } from "vitest";

const { handlers, fakeApp } = vi.hoisted(() => {
  const handlers: Array<(e: { preventDefault: () => void }) => void> = [];
  const fakeApp = {
    on: (event: string, fn: (e: { preventDefault: () => void }) => void) => {
      if (event === "before-quit") handlers.push(fn);
    },
    quit: vi.fn(),
  };
  return { handlers, fakeApp };
});

vi.mock("electron", () => ({ app: fakeApp }));

import { installShutdownLatch } from "./shutdown-latch";

beforeEach(() => {
  handlers.length = 0;
  fakeApp.quit.mockReset();
  vi.useRealTimers();
});

describe("installShutdownLatch", () => {
  it("calls preventDefault on first before-quit and prevents immediate exit", () => {
    const bootstrap = {
      isShuttingDown: () => false,
      shutdown: vi.fn().mockResolvedValue({}),
    };
    installShutdownLatch(bootstrap, 1000);
    const event = { preventDefault: vi.fn() };
    handlers[0](event);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(fakeApp.quit).not.toHaveBeenCalled();
  });

  it("calls bootstrap.shutdown() and re-quits after it resolves", async () => {
    const shutdown = vi.fn().mockResolvedValue({});
    const bootstrap = { isShuttingDown: () => false, shutdown };
    installShutdownLatch(bootstrap, 1000);
    handlers[0]({ preventDefault: vi.fn() });
    await new Promise((r) => setTimeout(r, 0));
    expect(shutdown).toHaveBeenCalled();
    expect(fakeApp.quit).toHaveBeenCalled();
  });

  it("waits for dependent shutdown and contains its failure", async () => {
    let release!: () => void;
    const dependent = vi.fn(() => new Promise<void>((_resolve, reject) => {
      release = () => reject(new Error("channel stop failed"));
    }));
    const bootstrap = { isShuttingDown: () => false, shutdown: vi.fn().mockResolvedValue({}) };
    installShutdownLatch(bootstrap, 1000, dependent);
    handlers[0]({ preventDefault: vi.fn() });
    await vi.waitFor(() => expect(dependent).toHaveBeenCalled());
    expect(fakeApp.quit).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(fakeApp.quit).toHaveBeenCalled());
  });

  it("keeps blocking repeated before-quit events until cleanup finishes", async () => {
    let release!: () => void;
    const shutdown = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const bootstrap = { isShuttingDown: () => false, shutdown };
    installShutdownLatch(bootstrap, 1000);
    const first = { preventDefault: vi.fn() };
    const second = { preventDefault: vi.fn() };
    handlers[0](first);
    handlers[0](second);
    expect(first.preventDefault).toHaveBeenCalledOnce();
    expect(second.preventDefault).toHaveBeenCalledOnce();
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(fakeApp.quit).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(fakeApp.quit).toHaveBeenCalledOnce());
  });

  it("joins an already-running bootstrap shutdown instead of bypassing dependents", async () => {
    let release!: () => void;
    const inFlight = new Promise<void>((resolve) => { release = resolve; });
    const dependent = vi.fn().mockResolvedValue(undefined);
    const bootstrap = {
      isShuttingDown: () => true,
      shutdown: vi.fn(() => inFlight),
    };
    installShutdownLatch(bootstrap, 1000, dependent);
    const event = { preventDefault: vi.fn() };
    handlers[0](event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(bootstrap.shutdown).toHaveBeenCalledOnce();
    expect(dependent).toHaveBeenCalledOnce();
    expect(fakeApp.quit).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(fakeApp.quit).toHaveBeenCalledOnce());
  });

  it("forces app.quit() on timeout if shutdown hangs", () => {
    vi.useFakeTimers();
    const shutdown = vi.fn().mockReturnValue(new Promise(() => {}));
    const bootstrap = { isShuttingDown: () => false, shutdown };
    installShutdownLatch(bootstrap, 500);
    handlers[0]({ preventDefault: vi.fn() });
    vi.advanceTimersByTime(500);
    expect(fakeApp.quit).toHaveBeenCalled();
  });

  it("does not quit twice when timed-out cleanup resolves late", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const shutdown = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const bootstrap = { isShuttingDown: () => false, shutdown };
    installShutdownLatch(bootstrap, 500);
    handlers[0]({ preventDefault: vi.fn() });
    vi.advanceTimersByTime(500);
    expect(fakeApp.quit).toHaveBeenCalledOnce();
    release();
    await Promise.resolve();
    await Promise.resolve();
    expect(fakeApp.quit).toHaveBeenCalledOnce();
  });
});
