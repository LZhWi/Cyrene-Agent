import { describe, expect, it, vi } from "vitest";
import type { PluginEvents, PluginStorage, PluginTurnFinishedEvent } from "@playa0v0/cyrene-plugin-sdk";
import { createAutoReflection } from "../plugins/companion-memory/src/auto-reflection";

function fixture() {
  const map = new Map<string, unknown>();
  const storage: PluginStorage = { get: <T>(key: string) => structuredClone(map.get(key)) as T | undefined, set: (key, value) => { map.set(key, structuredClone(value)); }, rootDir: () => "unused" };
  let listener: ((event: PluginTurnFinishedEvent) => void | Promise<void>) | undefined, now = 100_000;
  const off = vi.fn(), review = vi.fn(async (_signal: AbortSignal) => ({ suggested: 1 }));
  const events: PluginEvents = { on: (_event, next: any) => { listener = next; return off; }, emit: async () => undefined };
  const service = createAutoReflection(storage, events, review, () => now);
  const desktop = { eventId: "e", timestamp: "", runId: "r", mode: "chat", source: "desktop", conversationId: "c", inputMessageId: "m", status: "success" } as PluginTurnFinishedEvent;
  return { service, review, off, emit: (event: PluginTurnFinishedEvent = desktop) => listener?.(event), advance: () => { now += 60_000; } };
}

describe("后台画像反思", () => {
  it("默认关闭，启用后每二十个成功桌面轮次只生成候选", async () => {
    const data = fixture(); await data.emit(); expect(data.review).not.toHaveBeenCalled(); data.service.set(true);
    for (let index = 0; index < 19; index++) await data.emit(); expect(data.review).not.toHaveBeenCalled();
    await data.emit(); expect(data.review).toHaveBeenCalledTimes(1);
    expect(data.service.view()).toMatchObject({ enabled: true, pendingTurns: 0, lastSuggested: 1 });
  });

  it("忽略非桌面和失败轮次，关闭时取消在途请求", async () => {
    let release!: () => void, aborted = false;
    const data = fixture(); data.service.set(true);
    await data.emit({ eventId: "x", timestamp: "", runId: "r", mode: "chat", source: "channel", channel: "x", status: "success" });
    await data.emit({ eventId: "x", timestamp: "", runId: "r", mode: "chat", source: "desktop", conversationId: "c", inputMessageId: "m", status: "runtime_error" });
    await data.emit({ eventId: "work", timestamp: "", runId: "r", mode: "work", source: "desktop", conversationId: "c", inputMessageId: "m", status: "success" } as PluginTurnFinishedEvent);
    await data.emit({ eventId: "code", timestamp: "", runId: "r", mode: "code", source: "desktop", conversationId: "c", inputMessageId: "m", status: "success" } as PluginTurnFinishedEvent);
    expect(data.service.view().pendingTurns).toBe(0);
    data.review.mockImplementationOnce(async (signal: AbortSignal) => { await new Promise<void>((resolve) => { release = resolve; signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }); }); return { suggested: 0 }; });
    for (let index = 0; index < 19; index++) await data.emit();
    const pending = data.emit(); data.service.set(false); await pending;
    expect(aborted).toBe(true); expect(data.service.view()).toMatchObject({ enabled: false, pendingTurns: 0 });
    data.service.stop(); expect(data.off).toHaveBeenCalledTimes(1); release?.();
  });
});
