import { describe, expect, it } from "vitest";
import { scoreScene, timeWindowMatchScore } from "./scene-scorer";
import type { OpenerState, UserStateSnapshot, WeatherSnapshot } from "./opener-types";

const state: OpenerState = {
  globalDesire: 0,
  proactiveEpoch: 0, unansweredCount: 0, lastProactiveAt: null,
  lastProactiveScene: null, lastNormalConversationEndedAt: null, lastSilentAt: null,
  lastFeedbackJudgedAt: null,
  affinity: { morning:1, topic_followup:1, evening_checkin:1, late_night:1, idle_daze:1, work_break:1, back_from_away:1, rainy_day:1, cold_drop:1, sunny_day:1 },
  todayFired: {}, lastFiredAt: {}, recentItems: {},
  lastTriggeredScene: null, lastTriggeredAt: null, desireRateMultiplier: 1, lastDateStr: "x",
};
const emptyWeather: WeatherSnapshot = { isRaining:false, precip:0, temp:0, tempDropFromYesterday:0, isSunny:false, tempComfortable:false };

function snap(overrides: Partial<UserStateSnapshot> = {}): UserStateSnapshot {
  return {
    hour: 14, minute: 0, idleSec: 5, mouseResumeEvent: false,
    lastChatAgoMs: 0, keyboardAccumMin: 0, continuousActiveMin: 0,
    ...overrides,
  };
}

describe("timeWindowMatchScore", () => {
  it("is triangular: zero at edges and highest at center", () => {
    expect(timeWindowMatchScore(7 * 60, 7 * 60, 8 * 60 + 30, 10 * 60 + 30)).toBe(0);
    expect(timeWindowMatchScore(8 * 60 + 30, 7 * 60, 8 * 60 + 30, 10 * 60 + 30)).toBe(15);
    expect(timeWindowMatchScore(10 * 60 + 30, 7 * 60, 8 * 60 + 30, 10 * 60 + 30)).toBe(0);
  });
});

describe("scoreScene", () => {
  it("morning uses a small smooth time bonus inside the window", () => {
    expect(scoreScene("morning", snap({ hour: 7 }), emptyWeather, state, Date.now())).toBe(70);
    expect(scoreScene("morning", snap({ hour: 8, minute: 30 }), emptyWeather, state, Date.now())).toBe(85);
    expect(scoreScene("morning", snap({ hour: 11 }), emptyWeather, state, Date.now())).toBe(0);
  });

  it("morning and evening check-in are mutually exclusive per day", () => {
    const fired = { ...state, todayFired: { daily_checkin: true } };
    expect(scoreScene("morning", snap({ hour: 8, minute: 30 }), emptyWeather, fired, Date.now())).toBe(0);
    expect(scoreScene("evening_checkin", snap({ hour: 20 }), emptyWeather, fired, Date.now())).toBe(0);
  });

  it("evening_checkin is low-weight and peaks around 20:00", () => {
    expect(scoreScene("evening_checkin", snap({ hour: 18 }), emptyWeather, state, Date.now())).toBe(50);
    expect(scoreScene("evening_checkin", snap({ hour: 20 }), emptyWeather, state, Date.now())).toBe(65);
    expect(scoreScene("evening_checkin", snap({ hour: 23 }), emptyWeather, state, Date.now())).toBe(0);
  });

  it("topic_followup is the lowest-weight scene and requires a recent ordinary topic", () => {
    const twoHoursAgo = 2 * 60 * 60 * 1000;
    expect(scoreScene("topic_followup", snap({ hour: 14, minute: 30, lastChatAgoMs: twoHoursAgo }), emptyWeather, state, Date.now())).toBe(45);
    expect(scoreScene("topic_followup", snap({ hour: 14, minute: 30, lastChatAgoMs: 30 * 60 * 1000 }), emptyWeather, state, Date.now())).toBe(0);
    expect(scoreScene("topic_followup", snap({ hour: 14, minute: 30, lastChatAgoMs: 7 * 60 * 60 * 1000 }), emptyWeather, state, Date.now())).toBe(0);
    expect(scoreScene("topic_followup", snap({ hour: 14, minute: 30, lastChatAgoMs: twoHoursAgo, idleSec: 180 }), emptyWeather, state, Date.now())).toBe(0);
  });

  it("topic_followup only runs in the afternoon window", () => {
    const recentTopic = 2 * 60 * 60 * 1000;
    expect(scoreScene("topic_followup", snap({ hour: 11, minute: 29, lastChatAgoMs: recentTopic }), emptyWeather, state, Date.now())).toBe(0);
    expect(scoreScene("topic_followup", snap({ hour: 11, minute: 30, lastChatAgoMs: recentTopic }), emptyWeather, state, Date.now())).toBe(35);
    expect(scoreScene("topic_followup", snap({ hour: 17, minute: 31, lastChatAgoMs: recentTopic }), emptyWeather, state, Date.now())).toBe(0);
  });

  it("late_night keeps its existing active-use weighting", () => {
    expect(scoreScene("late_night", snap({ hour: 23, keyboardAccumMin: 60 }), emptyWeather, state, Date.now())).toBe(100);
    expect(scoreScene("late_night", snap({ hour: 22, keyboardAccumMin: 60 }), emptyWeather, state, Date.now())).toBe(0);
    expect(scoreScene("late_night", snap({ hour: 1, keyboardAccumMin: 60 }), emptyWeather, state, Date.now())).toBe(100);
    expect(scoreScene("late_night", snap({ hour: 3, keyboardAccumMin: 60 }), emptyWeather, state, Date.now())).toBe(0);
  });

  it("idle_daze remains available after ten idle minutes in daytime", () => {
    expect(scoreScene("idle_daze", snap({ idleSec: 600 }), emptyWeather, state, Date.now())).toBe(80);
  });

  it("work_break requires 90 minutes of continuous activity", () => {
    expect(scoreScene("work_break", snap({ continuousActiveMin: 89.9 }), emptyWeather, state, Date.now())).toBe(0);
    expect(scoreScene("work_break", snap({ continuousActiveMin: 90 }), emptyWeather, state, Date.now())).toBe(70);
    expect(scoreScene("work_break", snap({ continuousActiveMin: 120 }), emptyWeather, state, Date.now())).toBe(100);
  });

  it("weather mutual exclusion is unchanged", () => {
    const rain: WeatherSnapshot = { ...emptyWeather, isRaining: true };
    expect(scoreScene("rainy_day", snap(), rain, state, Date.now())).toBe(70);
    expect(scoreScene("rainy_day", snap(), rain, { ...state, todayFired: { weather: true } }, Date.now())).toBe(0);
  });

  it("affinity still scales the final score", () => {
    const boosted = { ...state, affinity: { ...state.affinity, morning: 1.5 } };
    expect(scoreScene("morning", snap({ hour: 8, minute: 30 }), emptyWeather, boosted, Date.now())).toBe(127.5);
  });
});
