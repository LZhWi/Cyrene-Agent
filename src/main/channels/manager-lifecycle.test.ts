import { describe, expect, it, vi } from "vitest";
import { ChannelManager } from "./manager";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("ChannelManager lifecycle", () => {
  it("waits for an in-flight start before stopping the newly started adapter", async () => {
    const gate = deferred();
    const adapter = {
      id: "feishu",
      displayName: "Feishu",
      start: vi.fn(() => gate.promise),
      stop: vi.fn(async () => undefined),
      getStatus: vi.fn(() => ({ enabled: true, phase: "running" })),
    };
    const manager = new ChannelManager();
    manager.register(adapter as never);

    const starting = manager.startAll();
    const stopping = manager.stopAll();
    expect(adapter.stop).not.toHaveBeenCalled();
    gate.resolve();
    await Promise.all([starting, stopping]);

    expect(adapter.start).toHaveBeenCalledOnce();
    expect(adapter.stop).toHaveBeenCalledOnce();
  });

  it("shares one start operation across concurrent callers", async () => {
    const gate = deferred();
    const adapter = {
      id: "feishu",
      displayName: "Feishu",
      start: vi.fn(() => gate.promise),
      stop: vi.fn(async () => undefined),
      getStatus: vi.fn(() => ({ enabled: true, phase: "running" })),
    };
    const manager = new ChannelManager();
    manager.register(adapter as never);
    const first = manager.startAll();
    const second = manager.startAll();
    gate.resolve();
    await Promise.all([first, second]);
    expect(adapter.start).toHaveBeenCalledOnce();
  });
});
