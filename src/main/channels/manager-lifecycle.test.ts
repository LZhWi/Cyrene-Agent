import { describe, expect, it, vi } from "vitest";
import { ChannelManager } from "./manager";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("ChannelManager lifecycle", () => {
  it("reports the adapter delivery receipt after sending", async () => {
    const onDeliveryResult = vi.fn();
    const adapter = {
      id: "wechat",
      displayName: "WeChat",
      capability: { text: true },
      onMessage: null,
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      send: vi.fn(async () => ({ ok: true, deliveredPartIndexes: [0] })),
      getStatus: vi.fn(() => ({ enabled: true, phase: "running" })),
    };
    const manager = new ChannelManager();
    manager.register(adapter as never);
    manager.setDispatcher(async () => ({
      channel: "wechat",
      targetId: "wx-1",
      parts: [{ kind: "text", text: "送达" }],
      _onDeliveryResult: onDeliveryResult,
    }));

    await (adapter.onMessage as any)({ channel: "wechat", senderId: "wx-1", chatId: "wx-1", text: "hi", at: new Date() });

    expect(onDeliveryResult).toHaveBeenCalledWith(
      { ok: true, deliveredPartIndexes: [0] },
      expect.objectContaining({ targetId: "wx-1" }),
    );
  });

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
