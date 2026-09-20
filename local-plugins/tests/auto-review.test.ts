import { describe, expect, it, vi } from "vitest";
import type { PluginEvents, PluginStorage, PluginTurnFinishedEvent } from "@playa0v0/cyrene-plugin-sdk";
import { createAutoReview, type AutoReviewCandidate } from "../plugins/companion-memory/src/auto-review";

const candidate: AutoReviewCandidate = { id: "i1", leftId: "a", rightId: "b", status: "open", stale: false };

function fixture(opts: { candidates?: AutoReviewCandidate[]; review?: (item: AutoReviewCandidate, signal: AbortSignal) => Promise<unknown>; apply?: (result: unknown) => { applied: boolean; reviewId?: string }; map?: Map<string, unknown> } = {}) {
  const map = opts.map ?? new Map<string, unknown>();
  const storage: PluginStorage = {
    get: <T>(key: string) => structuredClone(map.get(key)) as T | undefined,
    set: (key, value) => { map.set(key, structuredClone(value)); },
    rootDir: () => "unused",
  };
  let listener: ((event: PluginTurnFinishedEvent) => void | Promise<void>) | undefined;
  const off = vi.fn();
  const events: PluginEvents = { on: (_event, next: any) => { listener = next; return off; }, emit: async () => undefined };
  let now = 100_000;
  const review = vi.fn(opts.review ?? (async () => ({ verdict: "uncertain" })));
  const apply = vi.fn(opts.apply ?? (() => ({ applied: false })));
  const service = createAutoReview(storage, events, () => opts.candidates ?? [candidate], review, () => now, apply);
  const desktop = { eventId: "e", timestamp: "2026-01-01T00:00:00Z", runId: "r", mode: "chat", source: "desktop", conversationId: "c", inputMessageId: "m", status: "success" } as PluginTurnFinishedEvent;
  return { map, review, apply, service, off, emit: (event: PluginTurnFinishedEvent = desktop) => listener?.(event), advance: (ms: number) => { now += ms; } };
}

describe("后台维护候选模型复核", () => {
  it("默认关闭；启用后只按成功 desktop 轮次每五轮处理一对", async () => {
    const data = fixture();
    await data.emit(); expect(data.review).not.toHaveBeenCalled();
    data.service.set(true);
    await data.emit({ eventId: "x", timestamp: "", runId: "r", mode: "chat", source: "channel", channel: "x", status: "success" });
    for (let i = 0; i < 4; i += 1) await data.emit();
    expect(data.review).not.toHaveBeenCalled();
    for (const mode of ["work", "code", "learn"] as const) await data.emit({ eventId: mode, timestamp: "", runId: "r", mode, source: "desktop", conversationId: "c", inputMessageId: "m", status: "success" });
    expect(data.service.view().pendingTurns).toBe(4);
    expect(data.review).not.toHaveBeenCalled();
    await data.emit();
    expect(data.review).toHaveBeenCalledTimes(1);
    expect(data.apply).not.toHaveBeenCalled();
    expect(data.service.view()).toMatchObject({ enabled: true, pendingTurns: 0, lastReviewedItemId: "i1", lastCompletedAt: 100_000 });
    data.advance(60_000);
    for (let i = 0; i < 5; i += 1) await data.emit();
    expect(data.review).toHaveBeenCalledTimes(1);
  });

  it("自动应用需独立授权，关闭后台复核会同步关闭且重启不恢复", async () => {
    const data = fixture({ review: async () => ({ id: "review-1" }), apply: () => ({ applied: true, reviewId: "review-1" }) });
    expect(() => data.service.setApply(true)).toThrow("请先启用");
    data.service.set(true); data.service.setApply(true);
    for (let i = 0; i < 5; i += 1) await data.emit();
    expect(data.apply).toHaveBeenCalledWith({ id: "review-1" });
    expect(data.service.view()).toMatchObject({ applyEnabled: true, lastAutoAppliedAt: 100_000, lastAutoAppliedReviewId: "review-1" });
    data.service.set(false);
    expect(data.service.view()).toMatchObject({ enabled: false, applyEnabled: false });
    expect(fixture({ map: data.map }).service.view()).toMatchObject({ enabled: false, applyEnabled: false });
  });

  it("无候选不调用模型；失败只记录时间且不保存错误正文", async () => {
    const empty = fixture({ candidates: [] }); empty.service.set(true);
    for (let i = 0; i < 5; i += 1) await empty.emit();
    expect(empty.review).not.toHaveBeenCalled();

    const failed = fixture({ review: async () => { throw new Error("secret failure"); } }); failed.service.set(true);
    for (let i = 0; i < 5; i += 1) await failed.emit();
    expect(failed.service.view()).toMatchObject({ lastErrorAt: 100_000, pendingTurns: 0 });
    expect(JSON.stringify(failed.service.view())).not.toContain("secret failure");
  });

  it("关闭或停止会中止在途请求并注销监听", async () => {
    let aborted = false;
    const data = fixture({ review: (_item, signal) => new Promise((resolve) => signal.addEventListener("abort", () => { aborted = true; resolve(undefined); })) });
    data.service.set(true);
    for (let i = 0; i < 4; i += 1) await data.emit();
    const running = data.emit();
    await Promise.resolve();
    data.service.set(false);
    await running;
    expect(aborted).toBe(true);
    expect(data.service.view()).toMatchObject({ enabled: false, running: false, pendingTurns: 0 });
    data.service.stop(); data.service.stop();
    expect(data.off).toHaveBeenCalledTimes(1);
  });

  it("重启后延续轮次水位且不会重复处理已完成候选", async () => {
    const first = fixture(); first.service.set(true);
    for (let i = 0; i < 3; i += 1) await first.emit();
    first.service.stop();

    const second = fixture({ map: first.map });
    expect(second.service.view()).toMatchObject({ enabled: true, pendingTurns: 3 });
    await second.emit(); expect(second.review).not.toHaveBeenCalled();
    await second.emit(); expect(second.review).toHaveBeenCalledTimes(1);
    second.service.stop();

    const third = fixture({ map: first.map });
    for (let i = 0; i < 5; i += 1) await third.emit();
    expect(third.review).not.toHaveBeenCalled();
    expect(third.service.view().pendingTurns).toBe(5);
    third.advance(60_000); await third.emit();
    expect(third.service.view()).toMatchObject({ enabled: true, pendingTurns: 0, lastReviewedItemId: "i1" });
  });
});
