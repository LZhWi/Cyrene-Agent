import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginEvents, PluginStorage, PluginTurnFinishedEvent } from "@playa0v0/cyrene-plugin-sdk";
import { createAutoDream } from "../plugins/companion-memory/src/auto-dream";

function fixture(opts: { ids?: string[]; review?: (ids: string[], signal: AbortSignal) => Promise<unknown>; apply?: (review: unknown) => { applied: boolean; reviewId?: string }; after?: (signal: AbortSignal) => Promise<any>; map?: Map<string, unknown> } = {}) {
  const map = opts.map ?? new Map<string, unknown>();
  const storage: PluginStorage = { get: <T>(key: string) => structuredClone(map.get(key)) as T | undefined, set: (key, value) => { map.set(key, structuredClone(value)); }, rootDir: () => "unused" };
  let listener: ((event: PluginTurnFinishedEvent) => void | Promise<void>) | undefined;
  const off = vi.fn(), events: PluginEvents = { on: (_event, next: any) => { listener = next; return off; }, emit: async () => undefined };
  const review = vi.fn(opts.review ?? (async () => ({ status: "pending" })));
  const apply = vi.fn(opts.apply ?? (() => ({ applied: true, reviewId: "dream-review" })));
  const after = vi.fn(opts.after ?? (async () => undefined));
  const service = createAutoDream(storage, events, () => opts.ids ?? ["a", "b"], review, Date.now, apply, opts.after ? after : undefined);
  const desktop = { eventId: "e", timestamp: "", runId: "r", mode: "chat", source: "desktop", conversationId: "c", inputMessageId: "m", status: "success" } as PluginTurnFinishedEvent;
  return { map, review, apply, after, service, off, emit: (event: PluginTurnFinishedEvent = desktop) => listener?.(event) };
}

describe("原生 Chat 近似空闲梦境草稿", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-01-02T00:00:00Z")); });
  afterEach(() => vi.useRealTimers());

  it("默认关闭；启用后空闲 15 分钟只生成待确认草稿", async () => {
    const data = fixture(); await data.emit(); await vi.advanceTimersByTimeAsync(15 * 60 * 1000); expect(data.review).not.toHaveBeenCalled();
    data.service.set(true);
    const lastActivityAt = data.service.view().lastActivityAt, scheduledTimers = vi.getTimerCount();
    for (const mode of ["work", "code", "learn"] as const) await data.emit({ eventId: mode, timestamp: "", runId: "r", mode, source: "desktop", conversationId: "c", inputMessageId: "m", status: "success" });
    expect(data.service.view().lastActivityAt).toBe(lastActivityAt); expect(vi.getTimerCount()).toBe(scheduledTimers);
    await data.emit();
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000 - 1); expect(data.review).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(data.review).toHaveBeenCalledWith(["a", "b"], expect.any(AbortSignal));
    expect(data.service.view().lastCompletedAt).toBe(Date.now());
    expect(data.apply).not.toHaveBeenCalled();
  });

  it("自动采用需要第二重授权，关闭主开关会同步撤销授权", async () => {
    const review = { id: "review-1", status: "pending" };
    const data = fixture({ review: async () => review, apply: (value) => ({ applied: value === review, reviewId: "review-1" }) });
    expect(() => data.service.setApply(true)).toThrow("请先启用后台梦境");
    data.service.set(true);
    data.service.setApply(true);
    await data.emit();
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect(data.apply).toHaveBeenCalledWith(review);
    expect(data.service.view()).toMatchObject({ applyEnabled: true, lastAutoAppliedReviewId: "review-1" });
    data.service.set(false);
    expect(data.service.view()).toMatchObject({ enabled: false, applyEnabled: false });
  });

  it("没有 Chat 活动时，其他桌面模式不会启动空闲梦境", async () => {
    const data = fixture(); data.service.set(true);
    for (const mode of ["work", "code", "learn"] as const) await data.emit({ eventId: mode, timestamp: "", runId: "r", mode, source: "desktop", conversationId: "c", inputMessageId: "m", status: "success" });
    expect(data.service.view().lastActivityAt).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect(data.review).not.toHaveBeenCalled();
  });

  it("24 小时内不重复，候选不足时不调用模型", async () => {
    const data = fixture(); data.service.set(true); await data.emit(); await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    await data.emit(); await vi.advanceTimersByTimeAsync(23 * 60 * 60 * 1000); expect(data.review).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000); expect(data.review).toHaveBeenCalledTimes(2);
    const empty = fixture({ ids: ["a"] }); empty.service.set(true); await empty.emit(); await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect(empty.review).not.toHaveBeenCalled();
  });

  it("统一周期即使没有足够叙事材料也继续压缩阶段，并记录各阶段结果", async () => {
    const data = fixture({ ids: ["a"], after: async () => ({ demotedToAging: 1, demotedToArchived: 2, compressionReviewed: 3, compressionApplied: 1 }) });
    data.service.set(true); await data.emit(); await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect(data.review).not.toHaveBeenCalled(); expect(data.after).toHaveBeenCalledTimes(1);
    expect(data.service.view()).toMatchObject({ lastDemotedToAging: 1, lastDemotedToArchived: 2, lastCompressionReviewed: 3, lastCompressionApplied: 1 });
  });

  it("叙事阶段失败会记录但不阻止后续压缩阶段", async () => {
    const data = fixture({ review: async () => { throw new Error("模型失败"); }, after: async () => ({ compressionReviewed: 2, compressionApplied: 0 }) });
    data.service.set(true); await data.emit(); await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect(data.after).toHaveBeenCalledTimes(1);
    expect(data.service.view()).toMatchObject({ lastFailedStage: "dream", lastCompressionReviewed: 2, lastCompletedAt: Date.now() });
  });

  it("新的桌面活动取消在途请求，channel 不重置空闲", async () => {
    let aborted = false;
    const data = fixture({ review: (_ids, signal) => new Promise((resolve) => signal.addEventListener("abort", () => { aborted = true; resolve(undefined); }, { once: true })) });
    data.service.set(true); await data.emit();
    vi.advanceTimersByTime(15 * 60 * 1000); await Promise.resolve();
    for (const mode of ["work", "code", "learn"] as const) await data.emit({ eventId: mode, timestamp: "", runId: "r", mode, source: "desktop", conversationId: "c", inputMessageId: "m", status: "success" });
    expect(aborted).toBe(false);
    await data.emit(); await Promise.resolve();
    expect(aborted).toBe(true); expect(data.service.view().lastCompletedAt).toBeUndefined();
    const lastActivityAt = data.service.view().lastActivityAt;
    await data.emit({ eventId: "c", timestamp: "", runId: "r", mode: "chat", source: "channel", channel: "x", status: "success" });
    for (const mode of ["work", "code", "learn"] as const) await data.emit({ eventId: mode, timestamp: "", runId: "r", mode, source: "desktop", conversationId: "c", inputMessageId: "m", status: "success" });
    expect(data.service.view().lastActivityAt).toBe(lastActivityAt);
  });

  it("关闭与停止均清理计时器和监听器", async () => {
    const data = fixture(); data.service.set(true); await data.emit(); data.service.set(false);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000); expect(data.review).not.toHaveBeenCalled();
    data.service.stop(); data.service.stop(); expect(data.off).toHaveBeenCalledTimes(1);
  });

  it("重启后恢复空闲计时，但保留 24 小时去重水位", async () => {
    const first = fixture(); first.service.set(true); await first.emit();
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000); first.service.stop();

    const second = fixture({ map: first.map });
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 - 1); expect(second.review).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(second.review).toHaveBeenCalledTimes(1);
    second.service.stop();

    const third = fixture({ map: first.map });
    await vi.advanceTimersByTimeAsync(23 * 60 * 60 * 1000); expect(third.review).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000); expect(third.review).toHaveBeenCalledTimes(1);
  });
});
