import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginEventBus, PLUGIN_EVENT_LISTENER_TIMEOUT_MS } from "./events";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("PluginEventBus", () => {
  it("按订阅顺序等待监听器，并隔离单个监听器错误", async () => {
    const errors: unknown[] = [];
    const bus = createPluginEventBus((event, error) => errors.push([event, error]));
    const received: string[] = [];
    bus.on("host:chat:message", async () => {
      await Promise.resolve();
      received.push("first");
    });
    bus.on("host:chat:message", () => {
      throw new Error("listener failed");
    });
    bus.on("host:chat:message", () => { received.push("third"); });

    await bus.emit("host:chat:message", { text: "hello" });

    expect(received).toEqual(["first", "third"]);
    expect(errors).toEqual([["host:chat:message", expect.any(Error)]]);
  });

  it("退订函数幂等，发布使用监听器快照", async () => {
    const bus = createPluginEventBus();
    const first = vi.fn();
    const second = vi.fn();
    let unsubscribeSecond = () => {};
    bus.on("host:runtime:ready", () => {
      first();
      unsubscribeSecond();
    });
    unsubscribeSecond = bus.on("host:runtime:ready", second);

    await bus.emit("host:runtime:ready", undefined);
    unsubscribeSecond();
    await bus.emit("host:runtime:ready", undefined);

    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("监听器超时后记录错误并继续后续监听器", async () => {
    vi.useFakeTimers();
    const errors: unknown[] = [];
    const bus = createPluginEventBus((event, error) => errors.push([event, error]));
    const continued = vi.fn();
    bus.on("host:plugins:stopping", () => new Promise<void>(() => {}));
    bus.on("host:plugins:stopping", continued);

    const emitting = bus.emit("host:plugins:stopping", undefined);
    await vi.advanceTimersByTimeAsync(PLUGIN_EVENT_LISTENER_TIMEOUT_MS);
    await emitting;

    expect(continued).toHaveBeenCalledOnce();
    expect(errors).toEqual([
      ["host:plugins:stopping", expect.objectContaining({ message: expect.stringContaining("执行超时") })],
    ]);
  });

  it("拒绝无命名空间或格式非法的事件名", async () => {
    const bus = createPluginEventBus();
    expect(() => bus.on("message", () => {})).toThrow(/事件名/);
    expect(() => bus.on("host:bad event", () => {})).toThrow(/事件名/);
    expect(() => bus.on("plugin:demo", () => {})).toThrow(/插件 id/);
    await expect(bus.emit("other:event", undefined)).rejects.toThrow(/命名空间/);
  });
});
