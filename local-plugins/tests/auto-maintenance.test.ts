import { describe, expect, it, vi } from "vitest";
import type { PluginEvents, PluginStorage, PluginTurnFinishedEvent } from "@playa0v0/cyrene-plugin-sdk";
import { createAutoMaintenance } from "../plugins/companion-memory/src/auto-maintenance";

function fixture(scan = vi.fn(() => 2)) {
  const map = new Map<string, unknown>(), storage: PluginStorage = { get: <T>(key: string) => structuredClone(map.get(key)) as T | undefined, set: (key, value) => { map.set(key, structuredClone(value)); }, rootDir: () => "unused" };
  let listener: ((event: PluginTurnFinishedEvent) => void) | undefined;
  const off = vi.fn(), events: PluginEvents = { on: (_event, next: any) => { listener = next; return off; }, emit: async () => undefined };
  let now = 100_000;
  const service = createAutoMaintenance(storage, events, scan, () => now);
  const desktop = { eventId: "e", timestamp: "2026-01-01T00:00:00Z", runId: "r", mode: "chat", source: "desktop", conversationId: "c", inputMessageId: "m", status: "success" } as PluginTurnFinishedEvent;
  return { map, scan, service, off, emit: (event: PluginTurnFinishedEvent = desktop) => listener?.(event), advance: (ms: number) => { now += ms; } };
}

describe("低频本地候选自动收集", () => {
  it("默认关闭；启用后仅成功 desktop 事件每 24 小时触发一次", () => {
    const data = fixture(); data.emit(); expect(data.scan).not.toHaveBeenCalled(); expect(data.map.has("auto-maintenance-state")).toBe(false);
    data.service.set(true);
    data.emit({ eventId: "x", timestamp: "", runId: "r", mode: "chat", source: "channel", channel: "x", status: "success" }); expect(data.scan).not.toHaveBeenCalled();
    for (const mode of ["work", "code", "learn"] as const) data.emit({ eventId: mode, timestamp: "", runId: "r", mode, source: "desktop", conversationId: "c", inputMessageId: "m", status: "success" });
    expect(data.scan).not.toHaveBeenCalled(); expect(data.map.has("auto-maintenance-state")).toBe(false);
    data.emit(); expect(data.scan).toHaveBeenCalledTimes(1); expect(data.service.view()).toMatchObject({ enabled: true, lastAdded: 2, lastScanAt: 100_000 });
    data.emit(); expect(data.scan).toHaveBeenCalledTimes(1);
    data.advance(24 * 60 * 60 * 1000); data.emit(); expect(data.scan).toHaveBeenCalledTimes(2);
  });

  it("扫描失败不传播，停止后注销且不再执行", () => {
    const data = fixture(vi.fn(() => { throw new Error("secret failure"); })); data.service.set(true);
    expect(() => data.emit()).not.toThrow(); expect(data.service.view()).toMatchObject({ lastAdded: 0, lastErrorAt: 100_000 });
    expect(JSON.stringify(data.service.view())).not.toContain("secret failure");
    data.service.stop(); data.advance(24 * 60 * 60 * 1000); data.emit(); expect(data.scan).toHaveBeenCalledTimes(1); expect(data.off).toHaveBeenCalledTimes(1);
    data.service.stop(); expect(data.off).toHaveBeenCalledTimes(1);
  });
});
