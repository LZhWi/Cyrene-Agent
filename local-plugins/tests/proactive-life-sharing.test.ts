import { describe, expect, it, vi } from "vitest";
import type { PluginStorage } from "@playa0v0/cyrene-plugin-sdk";
import { createProactiveController, PROACTIVE_QUIET_MS } from "../plugins/companion-chat/src/proactive";
import { createPlannerState, markPlannerCommitted, sampleAndPlan, sceneCooldownMs, settleReplyFeedback, validatePlannerState } from "../plugins/companion-chat/src/proactive-planner";
import { buildProactiveMessages } from "../plugins/companion-chat/src/proactive-prompt";
import type { LifeShareSource } from "../plugins/companion-chat/src/life-sharing";

const at = new Date(2026, 8, 26, 12, 0).getTime();
const send = '{"decision":"send","text":"刚才读了一会儿书。"}';
const sourceAt = (): LifeShareSource => ({ eventId: "2026-09-26:上午", eventRevision: 4, text: "上午：读书",
  startAt: at - 5 * 60 * 60_000, endAt: at, expiresAt: at + 24 * 60 * 60_000 });

function fixture() {
  let now = at, valid = true, reserved = false, available = true;
  const data = new Map<string, unknown>(), events: string[] = [], source = sourceAt();
  const storage: PluginStorage = { get: <T>(key: string) => structuredClone(data.get(key)) as T | undefined,
    set: (key, value) => { data.set(key, structuredClone(value)); }, rootDir: () => "unused-memory-only" };
  const eligible = vi.fn((input: LifeShareSource) => valid && !reserved && input.endAt <= now && input.expiresAt > now
    && JSON.stringify(input) === JSON.stringify(source));
  const sharing = {
    candidate: vi.fn(() => available && eligible(source) ? source : null), eligible,
    reserve: vi.fn((input: LifeShareSource) => { events.push("reserve"); if (!eligible(input)) return false; reserved = true; return true; }),
    complete: vi.fn((_input: LifeShareSource, _receipt: { conversationId: string; messageId: string; at: string }) => { events.push("complete"); }),
  };
  const generate = vi.fn().mockResolvedValue(send);
  const deliver = vi.fn().mockImplementation(async () => { events.push("deliver"); return {
    conversationId: "synthetic-conversation", messageId: "synthetic-message", at: new Date(now).toISOString(),
  }; });
  const presence = vi.fn(async () => ({ at: new Date(now).toISOString(), idleSeconds: 0, screenLocked: false }));
  const canStartDelivery = vi.fn().mockResolvedValue(true);
  const lifeContext = vi.fn(() => "完整日程不应进入生活分享");
  const controller = createProactiveController({ storage, retrieve: async () => "", generate, deliver,
    lifeSharing: sharing, lifeContext, systemPrompt: () => "模拟角色", screenContext: () => "其它屏幕素材",
    presence, canStartDelivery, planCandidate: () => ({ scene: "life_share", score: 60 }),
    stopSignal: new AbortController().signal, now: () => now,
    setInterval: (() => ({ unref() {} })) as never, clearInterval: (() => {}) as never });
  controller.configure(true);
  return { controller, sharing, generate, deliver, presence, canStartDelivery, lifeContext, source, events,
    advance: (ms: number) => { now += ms; }, invalidate: () => { valid = false; }, unavailable: () => { available = false; } };
}

describe("生活分享沿既有主动投递路径", () => {
  it("冻结有效来源，先预占再投递，只在回执后完成并记录既有冷却", async () => {
    const f = fixture();
    expect(await f.controller.evaluate()).toMatchObject({ kind: "committed", messageId: "synthetic-message" });
    expect(f.events).toEqual(["reserve", "deliver", "complete"]);
    const selected = f.sharing.reserve.mock.calls[0][0];
    expect(selected).toEqual(f.source); expect(selected).not.toBe(f.source);
    expect(f.sharing.complete).toHaveBeenCalledWith(selected, expect.objectContaining({ messageId: "synthetic-message" }));
    expect(f.controller.view()).toMatchObject({ unansweredCount: 1, lastScene: "life_share", lastSentAt: at,
      planner: { lastFiredAt: { life_share: at }, globalDesire: 0 } });
    const prompt = JSON.stringify(f.generate.mock.calls[0][0]);
    expect(prompt).toContain(f.source.eventId); expect(prompt).toContain("不添加记录中没有");
    expect(prompt).not.toContain("完整日程不应进入"); expect(prompt).not.toContain("其它屏幕素材");
    expect(f.lifeContext).not.toHaveBeenCalled();
    expect(await f.controller.evaluate()).toEqual({ kind: "skipped" });
    expect(f.deliver).toHaveBeenCalledOnce();
    f.controller.stop();
  });

  it("无有效来源不生成，手动测试保持原行为且不消费生活来源", async () => {
    const f = fixture(); f.unavailable();
    expect(await f.controller.evaluate()).toEqual({ kind: "skipped" });
    expect(f.generate).not.toHaveBeenCalled();
    expect(await f.controller.manualTest()).toMatchObject({ kind: "committed" });
    expect(f.sharing.reserve).not.toHaveBeenCalled(); expect(f.sharing.complete).not.toHaveBeenCalled();
    expect(JSON.stringify(f.generate.mock.calls[0][0])).toContain("manual-test");
    expect(f.lifeContext).toHaveBeenCalledOnce(); f.controller.stop();
  });

  it.each(["revoked", "expired", "revision", "disabled", "stopped"] as const)("生成途中%s时不预占、不投递", async (change) => {
    const f = fixture(); let finish!: (value: string) => void;
    f.generate.mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; }));
    const pending = f.controller.evaluate();
    await vi.waitFor(() => expect(f.generate).toHaveBeenCalledOnce());
    if (change === "revoked") f.invalidate();
    if (change === "expired") f.advance(24 * 60 * 60_000);
    if (change === "revision") f.source.eventRevision++;
    if (change === "disabled") f.controller.configure(false);
    if (change === "stopped") f.controller.stop();
    finish(send);
    expect(await pending).toEqual({ kind: "stale" });
    expect(f.sharing.reserve).not.toHaveBeenCalled(); expect(f.deliver).not.toHaveBeenCalled();
    expect(f.sharing.complete).not.toHaveBeenCalled(); f.controller.stop();
  });

  it("最终宿主投递门关闭或预占失败时不会发送", async () => {
    const closed = fixture();
    closed.canStartDelivery.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await closed.controller.evaluate()).toEqual({ kind: "stale" });
    expect(closed.sharing.reserve).not.toHaveBeenCalled(); expect(closed.deliver).not.toHaveBeenCalled(); closed.controller.stop();
    const denied = fixture(); denied.sharing.reserve.mockReturnValueOnce(false);
    expect(await denied.controller.evaluate()).toEqual({ kind: "stale" });
    expect(denied.deliver).not.toHaveBeenCalled(); expect(denied.sharing.complete).not.toHaveBeenCalled(); denied.controller.stop();
  });

  it("等待最后投递许可期间取消，迟到许可也不能触发预占", async () => {
    const f = fixture(); let allow!: (value: boolean) => void;
    f.canStartDelivery.mockResolvedValueOnce(true).mockImplementationOnce(() => new Promise<boolean>((resolve) => { allow = resolve; }));
    const pending = f.controller.evaluate();
    await vi.waitFor(() => expect(f.canStartDelivery).toHaveBeenCalledTimes(2));
    f.controller.cancel(); allow(true);
    expect(await pending).toEqual({ kind: "stale" });
    expect(f.sharing.reserve).not.toHaveBeenCalled(); expect(f.deliver).not.toHaveBeenCalled(); f.controller.stop();
  });

  it("投递失败保留预占且不完成，同来源不能自动再次生成或重发", async () => {
    const f = fixture(); f.deliver.mockRejectedValueOnce(new Error("模拟投递失败"));
    await expect(f.controller.evaluate()).rejects.toThrow("模拟投递失败");
    expect(f.sharing.reserve).toHaveBeenCalledOnce(); expect(f.sharing.complete).not.toHaveBeenCalled();
    expect(f.controller.view()).toMatchObject({ unansweredCount: 0, lastSentAt: null });
    expect(await f.controller.evaluate()).toEqual({ kind: "skipped" });
    expect(f.generate).toHaveBeenCalledOnce(); expect(f.deliver).toHaveBeenCalledOnce(); f.controller.stop();
  });

  it("模型静默、非法输出及重复文本都不预占事件", async () => {
    for (const raw of ['{"decision":"silent"}', "not-json"]) {
      const f = fixture(); f.generate.mockResolvedValueOnce(raw);
      expect((await f.controller.evaluate()).kind).toBe(raw === "not-json" ? "invalid" : "silent");
      expect(f.sharing.reserve).not.toHaveBeenCalled(); expect(f.deliver).not.toHaveBeenCalled(); f.controller.stop();
    }
    const f = fixture(); await f.controller.manualTest();
    await f.controller.noteUserActivity(); f.controller.noteConversationEnded(); f.advance(2 * 60 * 60_000);
    expect(await f.controller.evaluate()).toEqual({ kind: "duplicate" });
    expect(f.sharing.reserve).not.toHaveBeenCalled(); expect(f.sharing.complete).not.toHaveBeenCalled(); f.controller.stop();
  });

  it("来源完成记账异常也保留真实投递回执、全局冷却和未回复次数", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const f = fixture(); f.sharing.complete.mockImplementationOnce(() => { throw new Error("模拟来源写失败"); });
      expect(await f.controller.evaluate()).toMatchObject({ kind: "committed" });
      expect(f.controller.view()).toMatchObject({ unansweredCount: 1, lastSentAt: at, lastDeliveredMessageId: "synthetic-message" });
      expect(await f.controller.evaluate()).toEqual({ kind: "skipped" });
      expect(f.deliver).toHaveBeenCalledOnce(); f.controller.stop();
    } finally { warning.mockRestore(); }
  });

  it("生活候选仍服从对话静默期与屏幕锁定，不增加消息频率", async () => {
    const f = fixture(); f.controller.noteConversationEnded();
    expect(await f.controller.evaluate()).toEqual({ kind: "skipped" });
    f.advance(PROACTIVE_QUIET_MS); f.presence.mockResolvedValueOnce({ at: new Date(at).toISOString(), idleSeconds: 0, screenLocked: true });
    expect(await f.controller.evaluate()).toEqual({ kind: "skipped" });
    expect(f.generate).not.toHaveBeenCalled(); f.controller.stop();
  });
});

describe("生活分享规划与提示词边界", () => {
  const plan = (options: { available?: boolean; desire?: number; random?: number; hour?: number; allow?: boolean } = {}) => {
    const state = createPlannerState(at); state.globalDesire = options.desire ?? 100;
    return sampleAndPlan({ state, presence: { at: new Date(at).toISOString(), idleSeconds: 0, screenLocked: false,
      localHour: options.hour ?? 12, localMinute: 0 }, at, lastActivityAt: 0, quietMs: PROACTIVE_QUIET_MS,
      allowAttempt: options.allow ?? true, lifeShareAvailable: options.available ?? true, random: () => options.random ?? 0 });
  };
  it("只在有来源的白天按60分竞争，沿用Desire、概率和允许门", () => {
    expect(plan()).toEqual({ scene: "life_share", score: 60 });
    expect(plan({ available: false })).toBeNull(); expect(plan({ desire: 0 })).toBeNull();
    expect(plan({ desire: 40, random: 0.9 })).toBeNull(); expect(plan({ allow: false })).toBeNull();
    expect(plan({ hour: 23 })?.scene).not.toBe("life_share");
    expect(plan({ hour: 7 })?.scene).not.toBe("life_share");
    expect(plan({ hour: 8 })?.scene).toBe("morning");
  });

  it("旧planner迁移只补life affinity，回执后有两小时场景冷却并支持既有反馈", () => {
    const old = createPlannerState(at); delete (old.affinity as Partial<typeof old.affinity>).life_share;
    old.globalDesire = 53; old.affinity.morning = 1.4;
    const restored = validatePlannerState(old, at);
    expect(restored.affinity.life_share).toBe(1); expect(restored.affinity.morning).toBe(1.4); expect(restored.globalDesire).toBe(53);
    markPlannerCommitted(restored, { scene: "life_share", score: 60 }, at);
    expect(sceneCooldownMs("life_share")).toBe(2 * 60 * 60_000);
    expect(settleReplyFeedback(restored)).toBe(true); expect(restored.affinity.life_share).toBeCloseTo(1.2);
    restored.globalDesire = 100;
    expect(sampleAndPlan({ state: restored, presence: { at: new Date(at).toISOString(), idleSeconds: 0, screenLocked: false },
      at: at + 60_000, lastActivityAt: 0, quietMs: 0, allowAttempt: true, lifeShareAvailable: true, random: () => 0 })?.scene).not.toBe("life_share");
  });

  it("life_share没有来源直接拒绝；有来源只注入该记录并限制自由补充", () => {
    const input = { basePersona: "模拟角色", ordinaryHistory: [], proactiveHistory: [], sceneId: "life_share", localNow: new Date(at),
      idleSec: 0, unansweredCount: 0 as const, lifeContext: "无关完整日程", screenActivity: "无关屏幕活动" };
    expect(() => buildProactiveMessages(input)).toThrow("缺少有效来源");
    const prompt = JSON.stringify(buildProactiveMessages({ ...input, lifeShare: sourceAt() }));
    expect(prompt).toContain("上午：读书"); expect(prompt).toContain("最多分享一句");
    expect(prompt).not.toContain("无关完整日程"); expect(prompt).not.toContain("无关屏幕活动");
  });
});
