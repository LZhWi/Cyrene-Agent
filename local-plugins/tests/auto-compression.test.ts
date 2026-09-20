import { describe, expect, it, vi } from "vitest";
import type { PluginEvents, PluginStorage, PluginTurnFinishedEvent } from "@playa0v0/cyrene-plugin-sdk";
import { createAutoCompression, type AutoCompressionCandidate } from "../plugins/companion-memory/src/auto-compression";

const candidate: AutoCompressionCandidate = { id: "a\0b\0c", entryIds: ["a", "b", "c"] };

function fixture(opts: { candidates?: AutoCompressionCandidate[]; review?: (item: AutoCompressionCandidate, signal: AbortSignal) => Promise<unknown>; apply?: (review: unknown) => { applied: boolean; reviewId?: string }; suppressed?: () => boolean; map?: Map<string, unknown> } = {}) {
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
  const service = createAutoCompression(storage, events, () => opts.candidates ?? [candidate], review, () => now, apply, opts.suppressed);
  const desktop = { eventId: "e", timestamp: "2026-01-01T00:00:00Z", runId: "r", mode: "chat", source: "desktop", conversationId: "c", inputMessageId: "m", status: "success" } as PluginTurnFinishedEvent;
  return { map, review, apply, service, off, emit: (event: PluginTurnFinishedEvent = desktop) => listener?.(event), advance: (ms: number) => { now += ms; } };
}

describe("后台压缩建议", () => {
  it("默认关闭；启用后只按成功 desktop 轮次每二十轮生成一份建议", async () => {
    const data = fixture();
    await data.emit(); expect(data.review).not.toHaveBeenCalled();
    data.service.set(true);
    for (let index = 0; index < 19; index++) await data.emit();
    expect(data.review).not.toHaveBeenCalled();
    for (const mode of ["work", "code", "learn"] as const) await data.emit({ eventId: mode, timestamp: "", runId: "r", mode, source: "desktop", conversationId: "c", inputMessageId: "m", status: "success" });
    expect(data.service.view().pendingTurns).toBe(19);
    expect(data.review).not.toHaveBeenCalled();
    await data.emit();
    expect(data.review).toHaveBeenCalledTimes(1);
    expect(data.review.mock.calls[0][0]).toEqual(candidate);
    expect(data.service.view()).toMatchObject({ pendingTurns: 0, lastReviewedCandidateId: candidate.id });
  });

  it("忽略 channel、失败和取消轮次，且不重复处理已完成候选", async () => {
    const data = fixture(); data.service.set(true);
    await data.emit({ eventId: "channel", timestamp: "", runId: "r", mode: "chat", source: "channel", channel: "x", status: "success" });
    await data.emit({ eventId: "error", timestamp: "", runId: "r", mode: "chat", source: "desktop", conversationId: "c", inputMessageId: "m", status: "runtime_error" });
    await data.emit({ eventId: "cancelled", timestamp: "", runId: "r", mode: "chat", source: "desktop", conversationId: "c", inputMessageId: "m", status: "cancelled" });
    expect(data.service.view().pendingTurns).toBe(0);
    for (let index = 0; index < 20; index++) await data.emit();
    data.advance(60_000);
    for (let index = 0; index < 20; index++) await data.emit();
    expect(data.review).toHaveBeenCalledTimes(1);
    expect(data.service.view().pendingTurns).toBe(0);
  });

  it("没有候选时不调用模型，失败也不保存错误正文", async () => {
    const empty = fixture({ candidates: [] }); empty.service.set(true);
    for (let index = 0; index < 20; index++) await empty.emit();
    expect(empty.review).not.toHaveBeenCalled();

    const failed = fixture({ review: async () => { throw new Error("secret-provider-message"); } }); failed.service.set(true);
    for (let index = 0; index < 20; index++) await failed.emit();
    expect(JSON.stringify([...failed.map.values()])).not.toContain("secret-provider-message");
    expect(failed.service.view().lastErrorAt).toBeDefined();
  });

  it("关闭或停止会取消在途请求并注销监听器", async () => {
    let release!: () => void, aborted = false;
    const data = fixture({ review: async (_item, signal) => { await new Promise<void>((resolve) => { release = resolve; signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }); }); } });
    data.service.set(true);
    for (let index = 0; index < 19; index++) await data.emit();
    const pending = data.emit(); data.service.set(false); await pending;
    expect(aborted).toBe(true); expect(data.service.view().lastCompletedAt).toBeUndefined();
    data.service.stop(); expect(data.off).toHaveBeenCalledTimes(1); release?.();
  });

  it("重启后延续轮次水位且不重复处理已完成分组", async () => {
    const first = fixture(); first.service.set(true);
    for (let index = 0; index < 12; index++) await first.emit();
    first.service.stop();

    const second = fixture({ map: first.map });
    expect(second.service.view()).toMatchObject({ enabled: true, pendingTurns: 12 });
    for (let index = 0; index < 8; index++) await second.emit();
    expect(second.review).toHaveBeenCalledTimes(1);
    second.service.stop();

    const third = fixture({ map: first.map });
    for (let index = 0; index < 20; index++) await third.emit();
    expect(third.review).not.toHaveBeenCalled();
    expect(third.service.view().pendingTurns).toBe(20);
    third.advance(60_000); await third.emit();
    expect(third.service.view()).toMatchObject({ enabled: true, pendingTurns: 0, lastReviewedCandidateId: candidate.id });
  });

  it("自动应用是独立授权，关闭基础功能会一并关闭并可跨重启保持", async () => {
    const first = fixture({ review: async () => ({ id: "review-1" }), apply: () => ({ applied: true, reviewId: "review-1" }) });
    expect(() => first.service.setApply(true)).toThrow("请先启用");
    first.service.set(true); first.service.setApply(true);
    for (let index = 0; index < 20; index++) await first.emit();
    expect(first.apply).toHaveBeenCalledTimes(1);
    expect(first.service.view()).toMatchObject({ enabled: true, applyEnabled: true, lastAutoAppliedReviewId: "review-1" });
    first.service.stop();
    const second = fixture({ map: first.map });
    expect(second.service.view()).toMatchObject({ enabled: true, applyEnabled: true });
    second.service.set(false);
    expect(second.service.view()).toMatchObject({ enabled: false, applyEnabled: false, pendingTurns: 0 });
  });

  it("完整梦境周期启用时暂停独立二十轮调度，避免同批候选重复处理", async () => {
    let suppressed = true;
    const data = fixture({ suppressed: () => suppressed }); data.service.set(true);
    for (let index = 0; index < 25; index++) await data.emit();
    expect(data.review).not.toHaveBeenCalled(); expect(data.service.view()).toMatchObject({ suppressed: true, pendingTurns: 0 });
    suppressed = false;
    for (let index = 0; index < 20; index++) await data.emit();
    expect(data.review).toHaveBeenCalledTimes(1); expect(data.service.view().suppressed).toBe(false);
  });
});
