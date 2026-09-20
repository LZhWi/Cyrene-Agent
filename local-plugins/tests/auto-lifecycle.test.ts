import { describe, expect, it, vi } from "vitest";
import type { PluginEvents, PluginStorage, PluginTurnFinishedEvent } from "@playa0v0/cyrene-plugin-sdk";
import { createAutoLifecycle } from "../plugins/companion-memory/src/auto-lifecycle";

function fixture(scan = vi.fn(() => ({ agingCandidates: 2, archivedCandidates: 1 })), map = new Map<string, unknown>(), apply = vi.fn(() => ({ agingApplied: 2, archivedApplied: 1, agingCandidates: 0, archivedCandidates: 0, weightDecayed: 3 }))) {
  const storage: PluginStorage = { get: <T>(key: string) => structuredClone(map.get(key)) as T | undefined, set: (key, value) => { map.set(key, structuredClone(value)); }, rootDir: () => "unused" };
  let listener: ((event: PluginTurnFinishedEvent) => void | Promise<void>) | undefined;
  const off = vi.fn(), events: PluginEvents = { on: (_event, next: any) => { listener = next; return off; }, emit: async () => undefined };
  let now = 100_000;
  const service = createAutoLifecycle(storage, events, scan, () => now, apply);
  const desktop = { eventId: "e", timestamp: "", runId: "r", mode: "chat", source: "desktop", conversationId: "c", inputMessageId: "m", status: "success" } as PluginTurnFinishedEvent;
  return { map, scan, apply, service, off, emit: (event: PluginTurnFinishedEvent = desktop) => listener?.(event), advance: (ms: number) => { now += ms; } };
}

describe("后台生命周期候选扫描", () => {
  it("默认关闭，启用后每 24 小时最多扫描一次且只保存数量", async () => {
    const data = fixture(); await data.emit(); expect(data.scan).not.toHaveBeenCalled();
    data.service.set(true);
    for (const mode of ["work", "code", "learn"] as const) await data.emit({ eventId: mode, timestamp: "", runId: "r", mode, source: "desktop", conversationId: "c", inputMessageId: "m", status: "success" });
    expect(data.scan).not.toHaveBeenCalled(); expect(data.apply).not.toHaveBeenCalled(); expect(data.service.view().lastScanAt).toBeUndefined();
    await data.emit();
    expect(data.scan).toHaveBeenCalledTimes(1);
    expect(data.service.view()).toMatchObject({ agingCandidates: 2, archivedCandidates: 1, lastScanAt: 100_000 });
    expect(JSON.stringify([...data.map.values()])).not.toContain("entryIds");
    data.advance(24 * 60 * 60 * 1000 - 1); await data.emit(); expect(data.scan).toHaveBeenCalledTimes(1);
    data.advance(1); await data.emit(); expect(data.scan).toHaveBeenCalledTimes(2);
  });

  it("忽略 channel 和未成功轮次，失败只保存通用时间", async () => {
    const scan = vi.fn(() => { throw new Error("secret-entry-content"); }), data = fixture(scan); data.service.set(true);
    await data.emit({ eventId: "c", timestamp: "", runId: "r", mode: "chat", source: "channel", channel: "x", status: "success" });
    await data.emit({ eventId: "f", timestamp: "", runId: "r", mode: "chat", source: "desktop", conversationId: "c", inputMessageId: "m", status: "runtime_error" });
    expect(scan).not.toHaveBeenCalled();
    await data.emit(); expect(scan).toHaveBeenCalledTimes(1);
    expect(data.service.view().lastErrorAt).toBe(100_000);
    expect(JSON.stringify([...data.map.values()])).not.toContain("secret-entry-content");
  });

  it("停止后注销监听且不再扫描", async () => {
    const data = fixture(); data.service.set(true); data.service.stop(); data.service.stop(); await data.emit();
    expect(data.scan).not.toHaveBeenCalled(); expect(data.off).toHaveBeenCalledTimes(1);
  });

  it("重启后保留每日扫描时间，不会在冷启动时重复扫描", async () => {
    const first = fixture(); first.service.set(true); await first.emit(); first.service.stop();
    const second = fixture(undefined, first.map);
    await second.emit();
    expect(second.scan).not.toHaveBeenCalled();
    expect(second.service.view()).toMatchObject({ enabled: true, lastScanAt: 100_000, agingCandidates: 2, archivedCandidates: 1 });
    second.advance(24 * 60 * 60 * 1000); await second.emit();
    expect(second.scan).toHaveBeenCalledTimes(1);
  });

  it("自动执行必须单独开启，且只在每日扫描命中时调用事务执行器", async () => {
    const data = fixture();
    expect(() => data.service.setApply(true)).toThrow("先启用每日生命周期扫描");
    data.service.set(true); data.service.setApply(true); await data.emit();
    expect(data.apply).toHaveBeenCalledTimes(1);
    expect(data.service.view()).toMatchObject({ enabled: true, applyEnabled: true, agingCandidates: 0, archivedCandidates: 0, lastAppliedAt: 100_000, lastAppliedAging: 2, lastAppliedArchived: 1, lastWeightDecayCount: 3 });
    await data.emit(); expect(data.apply).toHaveBeenCalledTimes(1);
  });

  it("关闭每日扫描会同时关闭自动执行，重启后保持关闭", () => {
    const data = fixture(); data.service.set(true); data.service.setApply(true); data.service.set(false); data.service.stop();
    const restarted = fixture(undefined, data.map);
    expect(restarted.service.view()).toMatchObject({ enabled: false, applyEnabled: false });
  });
});
