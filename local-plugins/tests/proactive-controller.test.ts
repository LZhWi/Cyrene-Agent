import { describe, expect, it, vi } from "vitest";
import type { PluginStorage } from "@playa0v0/cyrene-plugin-sdk";
import {
  MAX_UNANSWERED_PROACTIVE,
  NIGHT_ACTIVE_IDLE_LIMIT_SECONDS,
  PROACTIVE_CHECK_INTERVAL_MS,
  PROACTIVE_FOLLOWUP_COOLDOWN_MS,
  PROACTIVE_GLOBAL_COOLDOWN_MS,
  PROACTIVE_QUIET_MS,
  PROACTIVE_SILENT_COOLDOWN_MS,
  createProactiveController,
} from "../plugins/companion-chat/src/proactive";

function storage(): PluginStorage {
  const data = new Map<string, unknown>();
  return {
    get: <T>(key: string) => structuredClone(data.get(key)) as T | undefined,
    set: (key, value) => { data.set(key, structuredClone(value)); },
    rootDir: () => "unused",
  };
}

function fixture(
  data = storage(),
  screenContext?: () => string,
  presence?: () => Promise<{ at: string; idleSeconds: number; screenLocked: boolean }>,
  planCandidate?: (input: { allowAttempt: boolean; weather?: unknown }) => { scene: "morning" | "evening_checkin" | "idle_daze" | "rainy_day"; score: number } | null,
  weather?: () => Promise<any>,
  recentContext?: () => Promise<{ ordinaryHistory: Array<{ role: "user" | "model"; content: string; at: number }>; proactiveHistory: Array<{ role: "user" | "model"; content: string; at: number }>; recentTopic: string }>,
) {
  let now = new Date(2026, 8, 19, 12, 0, 0).getTime();
  const generate = vi.fn().mockResolvedValue('{"decision":"send","text":"记得休息一下呀。"}');
  const deliver = vi.fn().mockResolvedValue({ conversationId: "proactive-1", messageId: "message-1", at: new Date(now).toISOString() });
  const scheduled: Array<() => void> = [];
  const cleared: unknown[] = [];
  let planned = 0;
  const controller = createProactiveController({
    storage: data,
    retrieve: vi.fn().mockResolvedValue("用户最近在忙项目"),
    recentContext,
    generate,
    systemPrompt: () => "人设",
    screenContext,
    presence: presence ?? (async () => ({ at: new Date(now).toISOString(), idleSeconds: 0, screenLocked: false })),
    weather,
    planCandidate: planCandidate ?? ((input) => {
      if (!input.allowAttempt) return null;
      planned += 1;
      return { scene: planned % 2 === 1 ? "morning" : "idle_daze", score: 100 };
    }),
    deliver,
    stopSignal: new AbortController().signal,
    now: () => now,
    setInterval: ((callback: () => void) => { scheduled.push(callback); return { unref() {} }; }) as never,
    clearInterval: ((timer: unknown) => { cleared.push(timer); }) as never,
  });
  return { controller, generate, deliver, scheduled, cleared, advance: (ms: number) => { now += ms; } };
}

describe("陪伴插件自动主动消息控制器", () => {
  it("仅持久投递成功后提交上下文，静默和投递失败只清理预览", async () => {
    const events: string[] = [];
    let answer = '{"decision":"silent"}';
    let failDelivery = false;
    const controller = createProactiveController({
      storage: storage(),
      retrieve: async () => { events.push("preview-memory"); return "记忆"; },
      profileContext: async () => { events.push("preview-worldbook"); return "世界书"; },
      generate: async () => answer,
      systemPrompt: () => "人设",
      deliver: async () => {
        events.push("deliver");
        if (failDelivery) throw new Error("投递失败");
        return { conversationId: "c", messageId: "m", at: new Date().toISOString() };
      },
      commitContext: async () => { events.push("commit"); },
      discardContext: async () => { events.push("discard"); },
      stopSignal: new AbortController().signal,
    });
    await expect(controller.manualTest()).resolves.toMatchObject({ kind: "silent" });
    expect(events).toEqual(["preview-memory", "preview-worldbook", "discard"]);
    events.length = 0;
    answer = '{"decision":"send","text":"想你啦"}';
    failDelivery = true;
    await expect(controller.manualTest()).rejects.toThrow("投递失败");
    expect(events).toEqual(["preview-memory", "preview-worldbook", "deliver", "discard"]);
    events.length = 0;
    failDelivery = false;
    await expect(controller.manualTest()).resolves.toMatchObject({ kind: "committed" });
    expect(events).toEqual(["preview-memory", "preview-worldbook", "deliver", "commit", "discard"]);
  });
  it("每分钟采样，深夜活跃窗口为最近五分钟", () => {
    expect(PROACTIVE_CHECK_INTERVAL_MS).toBe(60_000);
    expect(NIGHT_ACTIVE_IDLE_LIMIT_SECONDS).toBe(300);
  });
  it("默认关闭且不创建计时器，启用后才开始周期检查", () => {
    const { controller, scheduled } = fixture();
    expect(controller.view()).toMatchObject({ enabled: false, unansweredCount: 0, busy: false });
    expect(scheduled).toHaveLength(0);
    controller.configure(true);
    expect(controller.view().enabled).toBe(true);
    expect(scheduled).toHaveLength(1);
  });

  it("执行静默期、三小时冷却和最多两条未回复限制", async () => {
    const { controller, generate, deliver, advance } = fixture();
    controller.configure(true);
    controller.noteConversationEnded();
    await expect(controller.evaluate()).resolves.toEqual({ kind: "skipped" });
    advance(PROACTIVE_QUIET_MS);
    await expect(controller.evaluate()).resolves.toMatchObject({ kind: "committed", messageId: "message-1" });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(controller.view().unansweredCount).toBe(1);
    await expect(controller.evaluate()).resolves.toEqual({ kind: "skipped" });
    advance(PROACTIVE_FOLLOWUP_COOLDOWN_MS);
    generate.mockResolvedValueOnce('{"decision":"send","text":"今天也别忘了喝点水。"}');
    await expect(controller.evaluate()).resolves.toEqual({ kind: "skipped" });
    await expect(controller.evaluate()).resolves.toMatchObject({ kind: "committed" });
    expect(controller.view().unansweredCount).toBe(MAX_UNANSWERED_PROACTIVE);
    advance(PROACTIVE_FOLLOWUP_COOLDOWN_MS);
    await expect(controller.evaluate()).resolves.toEqual({ kind: "skipped" });
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it("用户新消息使生成结果失效并清零未回复计数", async () => {
    const f = fixture();
    f.controller.configure(true);
    f.advance(PROACTIVE_QUIET_MS);
    let resolve!: (value: string) => void;
    f.generate.mockImplementationOnce(() => new Promise<string>((done) => { resolve = done; }));
    const run = f.controller.evaluate();
    await vi.waitFor(() => expect(f.generate).toHaveBeenCalledTimes(1));
    const activity = f.controller.noteUserActivity();
    resolve('{"decision":"send","text":"迟到回复"}');
    await expect(run).resolves.toEqual({ kind: "stale" });
    await activity;
    expect(f.deliver).not.toHaveBeenCalled();
    expect(f.controller.view()).toMatchObject({ unansweredCount: 0, busy: false });
  });

  it("关闭自动设置会立即使在途生成失效", async () => {
    const f = fixture();
    f.controller.configure(true);
    f.advance(PROACTIVE_QUIET_MS);
    let resolve!: (value: string) => void;
    f.generate.mockImplementationOnce(() => new Promise<string>((done) => { resolve = done; }));
    const run = f.controller.evaluate();
    await vi.waitFor(() => expect(f.generate).toHaveBeenCalledTimes(1));
    expect(f.controller.configure(false).enabled).toBe(false);
    resolve('{"decision":"send","text":"迟到回复"}');
    await expect(run).resolves.toEqual({ kind: "stale" });
    expect(f.deliver).not.toHaveBeenCalled();
  });

  it("手动测试在自动模式关闭时可运行，但真实投递仍计入冷却", async () => {
    const { controller, deliver } = fixture();
    await expect(controller.manualTest()).resolves.toMatchObject({ kind: "committed" });
    expect(deliver).toHaveBeenCalledOnce();
    expect(controller.view()).toMatchObject({ enabled: false, unansweredCount: 1 });
  });

  it("只把新鲜屏幕摘要作为只读上下文交给主动消息模型", async () => {
    const f = fixture(storage(), () => "用户正在编辑代码");
    await f.controller.manualTest();
    const messages = f.generate.mock.calls[0][0];
    expect(messages.some((message: any) => message.content.includes("[屏幕活动]") && message.content.includes("编辑代码"))).toBe(true);
    expect(messages.some((message: any) => message.content.includes("不要暴露检测、监控之类的机制"))).toBe(true);
  });

  it("主动会话历史中的用户回复和助手发言都进入本地版 16 条提示词窗口", async () => {
    const at = new Date(2026, 8, 19, 11, 0, 0).getTime();
    const f = fixture(storage(), undefined, undefined, undefined, undefined, async () => ({
      ordinaryHistory: [{ role: "user", content: "普通会话中的项目进度", at }],
      proactiveHistory: [
        { role: "model", content: "上次主动问候", at: at + 1_000 },
        { role: "user", content: "用户回复了主动问候", at: at + 2_000 },
      ],
      recentTopic: "普通会话中的项目进度",
    }));
    await f.controller.manualTest();
    const messages = f.generate.mock.calls[0][0];
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toContain("普通会话中的项目进度");
    expect(messages[0].content).toContain("assistant: 上次主动问候");
    expect(messages[0].content).toContain("user: 用户回复了主动问候");
    expect(messages[1].content).toContain("候选场景：manual-test");
  });

  it("天气只参与场景规划，不额外注入本地版没有的天气提示", async () => {
    const plan = vi.fn((input: { allowAttempt: boolean; weather?: any }) => {
      if (!input.allowAttempt) return null;
      expect(input.weather).toMatchObject({ category: "rain", temperatureC: 21 });
      expect(input.weather).not.toHaveProperty("city");
      return { scene: "rainy_day" as const, score: 82 };
    });
    const f = fixture(storage(), undefined, undefined, plan, async () => ({
      observedAt: "2026-09-20T03:50:00.000Z", expiresAt: "2026-09-20T04:20:00.000Z",
      category: "rain", temperatureC: 21, precipitationMm: 2,
    }));
    f.controller.configure(true); f.advance(PROACTIVE_QUIET_MS);
    await expect(f.controller.evaluate()).resolves.toMatchObject({ kind: "committed" });
    const messages = f.generate.mock.calls[0][0];
    expect(messages.some((message: any) => message.content.includes("[天气上下文]"))).toBe(false);
  });

  it("用户本地时间不在 6–22 点时不读取天气", async () => {
    let localHour = 23;
    const weather = vi.fn().mockResolvedValue({ category: "rain", temperatureC: 21, precipitationMm: 2 });
    const f = fixture(storage(), undefined,
      async () => ({ at: "2026-09-20T00:00:00.000Z", idleSeconds: 0, screenLocked: false, localHour }),
      () => null, weather);
    f.controller.configure(true);
    await f.controller.evaluate();
    expect(weather).not.toHaveBeenCalled();
    localHour = 6;
    f.advance(5 * 60_000);
    await f.controller.evaluate();
    expect(weather).toHaveBeenCalledTimes(1);
  });

  it("模型选择 silent 时不投递、不增加未回复计数并进入十分钟冷却", async () => {
    const f = fixture();
    f.controller.configure(true); f.advance(PROACTIVE_QUIET_MS);
    f.generate.mockResolvedValueOnce('{"decision":"silent","text":""}');
    await expect(f.controller.evaluate()).resolves.toEqual({ kind: "silent" });
    expect(f.deliver).not.toHaveBeenCalled();
    expect(f.controller.view()).toMatchObject({ unansweredCount: 0, lastSentAt: null });
    await expect(f.controller.evaluate()).resolves.toEqual({ kind: "skipped" });
    f.advance(PROACTIVE_SILENT_COOLDOWN_MS);
    await expect(f.controller.evaluate()).resolves.toMatchObject({ kind: "committed" });
  });

  it("模型输出无效时不误记为主动选择 silent", async () => {
    const f = fixture();
    f.controller.configure(true); f.advance(PROACTIVE_QUIET_MS);
    f.generate.mockResolvedValueOnce("不是 JSON");
    await expect(f.controller.evaluate()).resolves.toEqual({ kind: "invalid" });
    expect(f.controller.view()).toMatchObject({ lastSilentAt: null, lastSentAt: null });
    expect(f.deliver).not.toHaveBeenCalled();
  });

  it("抑制与上一条主动消息仅标点空白不同的重复文本", async () => {
    const f = fixture();
    await expect(f.controller.manualTest()).resolves.toMatchObject({ kind: "committed" });
    f.generate.mockResolvedValueOnce('{"decision":"send","text":"记得休息一下呀！"}');
    await expect(f.controller.manualTest()).resolves.toEqual({ kind: "duplicate" });
    expect(f.deliver).toHaveBeenCalledOnce();
  });

  it("用户已回复后下一条使用两小时全局冷却", async () => {
    const f = fixture(); f.controller.configure(true); f.advance(PROACTIVE_QUIET_MS);
    await f.controller.evaluate();
    await f.controller.noteUserActivity();
    f.controller.noteConversationEnded();
    f.advance(PROACTIVE_GLOBAL_COOLDOWN_MS - 1);
    await expect(f.controller.evaluate()).resolves.toEqual({ kind: "skipped" });
    f.advance(1);
    f.generate.mockResolvedValueOnce('{"decision":"send","text":"忙完了吗？要不要歇一会儿。"}');
    await expect(f.controller.evaluate()).resolves.toEqual({ kind: "skipped" });
    await expect(f.controller.evaluate()).resolves.toMatchObject({ kind: "committed" });
  });

  it("回应反馈学习默认关闭，只有用户主动开启后才修改 affinity", async () => {
    const off = fixture(); off.controller.configure(true); off.advance(PROACTIVE_QUIET_MS);
    await off.controller.evaluate();
    await off.controller.noteUserActivity();
    expect(off.controller.view()).toMatchObject({ feedbackLearningEnabled: false });
    expect(off.controller.view().planner!.affinity.morning).toBe(1);
    expect(off.controller.view().planner!.pendingFeedback).toBeNull();

    const on = fixture(); on.controller.configure(true, true); on.advance(PROACTIVE_QUIET_MS);
    await on.controller.evaluate();
    await on.controller.noteUserActivity();
    expect(on.controller.view()).toMatchObject({ feedbackLearningEnabled: true });
    expect(on.controller.view().planner!.affinity.morning).toBeCloseTo(1.2);
  });

  it("非微信渠道活动只打断主动生成，不误记为主动消息的正反馈", async () => {
    const f = fixture();
    f.controller.configure(true, true); f.advance(PROACTIVE_QUIET_MS);
    await f.controller.evaluate();
    await f.controller.noteUserActivity(false);
    f.controller.noteConversationEnded();
    expect(f.controller.view().planner!.affinity.morning).toBe(1);
  });

  it("只有启用反馈学习的自动主动消息声明忽略入口，并按最后消息 ID 结算一次", async () => {
    const off = fixture(); off.controller.configure(true); off.advance(PROACTIVE_QUIET_MS);
    await off.controller.evaluate();
    expect(off.deliver).toHaveBeenCalledWith("记得休息一下呀。", { allowIgnoreFeedback: false });
    expect(off.controller.ignoreMessage("message-1")).toBe(false);
    expect(off.controller.view().planner!.affinity.morning).toBe(1);

    const on = fixture(); on.controller.configure(true, true); on.advance(PROACTIVE_QUIET_MS);
    await on.controller.evaluate();
    expect(on.deliver).toHaveBeenCalledWith("记得休息一下呀。", { allowIgnoreFeedback: true });
    expect(on.controller.ignoreMessage("wrong-message")).toBe(false);
    expect(on.controller.ignoreMessage("message-1")).toBe(true);
    expect(on.controller.view().planner!.affinity.morning).toBeCloseTo(0.85);
    expect(on.controller.ignoreMessage("message-1")).toBe(false);
  });

  it("第二条未回复消息必须换场景，且评分至少五十五", async () => {
    const candidates = [
      { scene: "morning" as const, score: 90 },
      { scene: "evening_checkin" as const, score: 54 },
      { scene: "morning" as const, score: 90 },
      { scene: "evening_checkin" as const, score: 55 },
    ];
    const f = fixture(storage(), undefined, undefined, (input) => input.allowAttempt ? candidates.shift() ?? null : null);
    f.controller.configure(true, true); f.advance(PROACTIVE_QUIET_MS);
    await expect(f.controller.evaluate()).resolves.toMatchObject({ kind: "committed" });
    f.advance(PROACTIVE_FOLLOWUP_COOLDOWN_MS);
    await expect(f.controller.evaluate()).resolves.toEqual({ kind: "skipped" });
    expect(f.controller.view().planner!.affinity.morning).toBeCloseTo(0.85);
    await expect(f.controller.evaluate()).resolves.toEqual({ kind: "skipped" });
    f.generate.mockResolvedValueOnce('{"decision":"send","text":"早上的事处理得还顺利吗？"}');
    await expect(f.controller.evaluate()).resolves.toMatchObject({ kind: "committed" });
    expect(f.controller.view().planner!.affinity.morning).toBeCloseTo(0.85);
  });

  it("锁屏时始终不生成；深夜仅允许仍活跃的用户", async () => {
    const locked = fixture(storage(), undefined, async () => ({ at: new Date().toISOString(), idleSeconds: 0, screenLocked: true }));
    locked.controller.configure(true); locked.advance(PROACTIVE_QUIET_MS);
    await expect(locked.controller.evaluate()).resolves.toEqual({ kind: "skipped" });
    expect(locked.generate).not.toHaveBeenCalled();

    const away = fixture(storage(), undefined, async () => ({ at: new Date().toISOString(), idleSeconds: NIGHT_ACTIVE_IDLE_LIMIT_SECONDS, screenLocked: false }));
    away.controller.configure(true); away.advance(11 * 60 * 60 * 1000);
    await expect(away.controller.evaluate()).resolves.toEqual({ kind: "skipped" });
    expect(away.generate).not.toHaveBeenCalled();

    const active = fixture(storage(), undefined, async () => ({ at: new Date().toISOString(), idleSeconds: NIGHT_ACTIVE_IDLE_LIMIT_SECONDS - 1, screenLocked: false }));
    active.controller.configure(true); active.advance(11 * 60 * 60 * 1000);
    await expect(active.controller.evaluate()).resolves.toMatchObject({ kind: "committed" });
    expect(active.generate).toHaveBeenCalledOnce();
    expect(active.generate.mock.calls[0][0][0].content).toContain("[night_system]");
  });

  it("投递失败不提交冷却或未回复计数", async () => {
    const f = fixture();
    f.controller.configure(true);
    f.advance(PROACTIVE_QUIET_MS);
    f.deliver.mockRejectedValueOnce(new Error("delivery failed"));
    await expect(f.controller.evaluate()).rejects.toThrow("delivery failed");
    expect(f.controller.view()).toMatchObject({ unansweredCount: 0, lastSentAt: null, busy: false });
  });

  it("删除最后一条未回复主动消息仅回退全局冷却，保留场景冷却", async () => {
    const f = fixture();
    f.controller.configure(true);
    f.advance(PROACTIVE_QUIET_MS);
    await f.controller.evaluate();
    expect(f.controller.invalidateDeliveredMessage("other", false, ["message-1"])).toBe(false);
    expect(f.controller.invalidateDeliveredMessage("proactive-1", false, ["message-1"])).toBe(true);
    expect(f.controller.view()).toMatchObject({ unansweredCount: 0, lastSentAt: null, lastScene: null });
    expect(f.controller.view().planner!.lastFiredAt).toHaveProperty("morning");
  });

  it("状态跨重启保存，损坏状态直接拒绝加载", async () => {
    const data = storage();
    const first = fixture(data);
    first.controller.configure(true, true);
    await first.controller.manualTest();
    first.controller.stop();
    const second = fixture(data);
    expect(second.controller.view()).toMatchObject({ unansweredCount: 1, enabled: true, feedbackLearningEnabled: true });
    second.controller.stop();
    data.set("proactive-controller", { version: 1, enabled: true, epoch: -1 });
    expect(() => fixture(data)).toThrow("主动消息状态损坏");
  });

  it("关闭设置与停止插件都会清理计时器并取消在途生成", () => {
    const { controller, cleared } = fixture();
    controller.configure(true);
    controller.configure(false);
    expect(cleared).toHaveLength(1);
    controller.configure(true);
    controller.stop();
    expect(cleared).toHaveLength(2);
  });
});
