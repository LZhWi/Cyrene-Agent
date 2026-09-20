import { describe, expect, it, vi } from "vitest";
import type { PluginStorage } from "@playa0v0/cyrene-plugin-sdk";
import {
  SCREEN_CONTEXT_MAX_AGE_MS,
  SCREEN_LOW_CHANGE_INTERVAL_MS,
  SCREEN_PERIODIC_INTERVAL_MS,
  SCREEN_RETRY_INTERVAL_MS,
  createScreenMonitor,
} from "../plugins/companion-chat/src/screen-monitor";

function fixture(saved?: unknown) {
  const values = new Map<string, unknown>(saved === undefined ? [] : [["screen-monitor-settings", saved]]);
  const storage: PluginStorage = {
    get: <T>(key: string) => structuredClone(values.get(key)) as T | undefined,
    set: (key, value) => { values.set(key, structuredClone(value)); },
    rootDir: () => "unused",
  };
  let now = 1_000_000;
  const delays: number[] = [], cleared: unknown[] = [];
  const observe = vi.fn<() => Promise<string>>().mockResolvedValue("用户正在编辑代码");
  const monitor = createScreenMonitor({
    storage,
    observe,
    stopSignal: new AbortController().signal,
    now: () => now,
    setTimeout: ((_: () => void, delay?: number) => { delays.push(delay ?? 0); return { unref() {} }; }) as never,
    clearTimeout: ((timer: unknown) => { cleared.push(timer); }) as never,
  });
  return { monitor, observe, delays, cleared, values, advance: (ms: number) => { now += ms; } };
}

describe("后台屏幕观察", () => {
  it("默认关闭，显式启用后从完整三分钟间隔开始且不立即截屏", () => {
    const data = fixture();
    expect(data.monitor.view()).toMatchObject({ enabled: false, running: false, busy: false });
    expect(data.observe).not.toHaveBeenCalled();
    data.monitor.configure(true);
    expect(data.delays).toEqual([SCREEN_PERIODIC_INTERVAL_MS]);
    expect(data.values.get("screen-monitor-settings")).toEqual({ version: 1, enabled: true });
  });

  it("只在内存保留新鲜摘要，低变化降频，过期后不提供给主动消息", async () => {
    const data = fixture(); data.monitor.configure(true);
    await data.monitor.evaluate();
    expect(data.monitor.latestContext()).toBe("用户正在编辑代码");
    data.advance(60_000);
    data.observe.mockResolvedValueOnce("用户仍在编辑代码");
    await data.monitor.evaluate();
    expect(data.monitor.view().intervalMs).toBe(SCREEN_LOW_CHANGE_INTERVAL_MS);
    expect(data.monitor.latestContext()).toContain("没有明显变化");
    data.advance(SCREEN_CONTEXT_MAX_AGE_MS);
    expect(data.monitor.latestContext()).toBe("");
  });

  it("失败采用两分钟重试，停用后清除摘要和计划", async () => {
    const data = fixture(); data.monitor.configure(true);
    data.observe.mockRejectedValueOnce(new Error("视觉服务失败"));
    await data.monitor.evaluate();
    expect(data.monitor.view().intervalMs).toBe(SCREEN_RETRY_INTERVAL_MS);
    data.monitor.configure(false);
    expect(data.monitor.view()).toMatchObject({ enabled: false, running: false });
    expect(data.monitor.latestContext()).toBe("");
    expect(data.cleared.length).toBeGreaterThan(0);
  });

  it("拒绝损坏设置", () => {
    expect(() => fixture({ version: 1, enabled: "yes" })).toThrow("屏幕观察设置损坏");
  });
});
