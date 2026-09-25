import { describe, expect, it } from "vitest";
import {
  DESIRE_THRESHOLD,
  FOLLOWUP_MIN_SCORE,
  createPlannerState,
  markPlannerCommitted,
  sampleAndPlan,
  settleIgnoreFeedback,
  settleReplyFeedback,
  validatePlannerState,
} from "../plugins/companion-chat/src/proactive-planner";

const active = { at: "2026-09-20T00:00:00.000Z", idleSeconds: 0, screenLocked: false };

describe("主动消息场景规划", () => {
  it("手动时区只改变场景时钟；没有刚结束的对话时不凭启动时间强加静默期", () => {
    const at = new Date(2026, 8, 20, 12, 0).getTime();
    const state = createPlannerState(at - 5 * 60_000);
    state.globalDesire = 39;
    const candidate = sampleAndPlan({ state,
      presence: { ...active, localHour: 8, localMinute: 30 }, at,
      lastActivityAt: 0, lastNormalConversationEndedAt: null,
      quietMs: 20 * 60_000, allowAttempt: true, random: () => 0,
    });
    expect(candidate).toMatchObject({ scene: "morning", score: 85 });
    expect(state.globalDesire).toBe(49);
  });

  it("冷清、自然、热闹按本地版 1/2/4 每分钟累积 Desire", () => {
    const at = new Date(2026, 8, 20, 12, 0).getTime();
    for (const [rate, expected] of [[1, 5], [2, 10], [4, 20]]) {
      const state = createPlannerState(at - 5 * 60_000);
      sampleAndPlan({ state, presence: active, at, lastActivityAt: 0,
        lastNormalConversationEndedAt: null, quietMs: 20 * 60_000,
        baseDesireRate: rate, allowAttempt: false });
      expect(state.globalDesire).toBe(expected);
    }
  });

  it("Desire 未达阈值不生成，达到后选择时间场景", () => {
    const at = new Date(2026, 8, 20, 8, 30).getTime();
    const state = createPlannerState(at - 20 * 60_000);
    state.globalDesire = DESIRE_THRESHOLD - 1;
    expect(sampleAndPlan({ state, presence: active, at, lastActivityAt: at - 2 * 60 * 60_000, quietMs: 20 * 60_000, allowAttempt: true, random: () => 0 })).toMatchObject({ scene: "morning", score: 85 });
  });

  it("离开半小时后恢复活动使用 back_from_away 直通场景", () => {
    const at = new Date(2026, 8, 20, 12).getTime();
    const state = createPlannerState(at - 60_000);
    state.lastIdleSeconds = 1800;
    expect(sampleAndPlan({ state, presence: active, at, lastActivityAt: at - 2 * 60 * 60_000, quietMs: 20 * 60_000, allowAttempt: true })).toEqual({ scene: "back_from_away", score: 100 });
    expect(state.globalDesire).toBe(100);
  });

  it("离开后回来即使仍在静默期也先把 Desire 设为 100", () => {
    const at = new Date(2026, 8, 20, 12).getTime();
    const state = createPlannerState(at - 5 * 60_000);
    state.lastIdleSeconds = 1800;
    expect(sampleAndPlan({ state, presence: active, at, lastActivityAt: 0,
      lastNormalConversationEndedAt: at - 10 * 60_000, quietMs: 20 * 60_000, allowAttempt: true,
    })).toMatchObject({ scene: "back_from_away", score: 100 });
    expect(state.globalDesire).toBe(100);
  });

  it("跨过静默期边界时按本地版整次采样累积 Desire", () => {
    const at = new Date(2026, 8, 20, 12).getTime();
    const state = createPlannerState(at - 5 * 60_000);
    sampleAndPlan({ state, presence: { ...active, idleSeconds: 300 }, at,
      lastActivityAt: 0, lastNormalConversationEndedAt: at - 19 * 60_000,
      quietMs: 20 * 60_000, allowAttempt: false });
    expect(state.globalDesire).toBe(0);
    sampleAndPlan({ state, presence: { ...active, idleSeconds: 300 }, at: at + 2 * 60_000,
      lastActivityAt: 0, lastNormalConversationEndedAt: at - 19 * 60_000,
      quietMs: 20 * 60_000, allowAttempt: false });
    expect(state.globalDesire).toBe(4);
  });

  it("持续活动超过九十分钟产生 work_break，采样断档则归零", () => {
    const at = new Date(2026, 8, 20, 12).getTime();
    const state = createPlannerState(at - 5 * 60_000);
    state.globalDesire = 100;
    state.continuousActiveMinutes = 89;
    expect(sampleAndPlan({ state, presence: active, at, lastActivityAt: at - 2 * 60 * 60_000, quietMs: 20 * 60_000, allowAttempt: true, random: () => 0 })).toMatchObject({ scene: "work_break" });
    sampleAndPlan({ state, presence: active, at: at + 10 * 60_000, lastActivityAt: 0, quietMs: 0, allowAttempt: false });
    expect(state.continuousActiveMinutes).toBe(0);
  });

  it("只使用未过期天气快照生成天气场景，并共享每日一次限制", () => {
    const at = new Date(2026, 8, 20, 12).getTime();
    const state = createPlannerState(at - 5 * 60_000);
    state.globalDesire = 100;
    const weather = {
      expiresAt: new Date(at + 30 * 60_000).toISOString(),
      category: "rain" as const,
      temperatureC: 21,
      precipitationMm: 2,
      previousDayHighC: 30,
      todayHighC: 22,
    };
    const candidate = sampleAndPlan({ state, presence: active, weather, at,
      lastActivityAt: at - 2 * 60 * 60_000, quietMs: 20 * 60_000, allowAttempt: true, random: () => 0 });
    expect(candidate).toMatchObject({ scene: "rainy_day", score: 82 });
    markPlannerCommitted(state, candidate!, at);
    state.globalDesire = 100;
    const next = sampleAndPlan({ state, presence: active, weather, at: at + 60_000,
      lastActivityAt: at - 2 * 60 * 60_000, quietMs: 20 * 60_000, allowAttempt: true, random: () => 0 });
    expect(next?.scene).not.toMatch(/rainy_day|cold_drop|sunny_day/);

    const stale = createPlannerState(at - 5 * 60_000);
    stale.globalDesire = 100;
    expect(sampleAndPlan({ state: stale, presence: active, weather: { ...weather, expiresAt: new Date(at).toISOString() }, at,
      lastActivityAt: at - 2 * 60 * 60_000, quietMs: 20 * 60_000, allowAttempt: true, random: () => 0 })?.scene).not.toBe("rainy_day");
  });

  it("天气场景只在用户本地时间 6–22 点生成", () => {
    const at = new Date(2026, 8, 20, 12).getTime();
    const weather = {
      expiresAt: new Date(at + 30 * 60_000).toISOString(),
      category: "rain" as const,
      temperatureC: 21,
      precipitationMm: 2,
    };
    for (const hour of [5, 6, 22, 23]) {
      const state = createPlannerState(at - 5 * 60_000);
      state.globalDesire = 100;
      const candidate = sampleAndPlan({ state, presence: { ...active, localHour: hour, localMinute: 0 }, weather, at,
        lastActivityAt: at - 2 * 60 * 60_000, quietMs: 20 * 60_000, allowAttempt: true, random: () => 0 });
      expect(candidate?.scene === "rainy_day", `hour=${hour}`).toBe(hour === 6 || hour === 22);
    }
  });

  it("回复时提高 affinity；只有下一次准备开口时才把未回复结算为忽略", () => {
    const at = Date.now();
    const state = createPlannerState(at);
    const candidate = { scene: "morning" as const, score: FOLLOWUP_MIN_SCORE };
    markPlannerCommitted(state, candidate, at);
    expect(settleReplyFeedback(state)).toBe(true);
    expect(state.affinity.morning).toBeCloseTo(1.2);
    expect(settleReplyFeedback(state)).toBe(false);
    markPlannerCommitted(state, candidate, at + 24 * 60 * 60_000);
    expect(settleIgnoreFeedback(state)).toBe(true);
    expect(state.affinity.morning).toBeCloseTo(1.02);
    expect(settleIgnoreFeedback(state)).toBe(false);
  });

  it("旧状态可补默认规划器，损坏规划器拒绝加载", () => {
    expect(validatePlannerState(undefined, 100).globalDesire).toBe(0);
    expect(() => validatePlannerState({ globalDesire: -1 }, 100)).toThrow("规划状态损坏");
  });
});
