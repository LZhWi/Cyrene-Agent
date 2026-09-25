import type { UserPresenceSnapshot } from "./proactive";

export type ProactiveScene = "morning" | "topic_followup" | "evening_checkin" | "late_night"
  | "idle_daze" | "work_break" | "back_from_away" | "rainy_day" | "cold_drop" | "sunny_day";

export interface ProactiveWeatherSnapshot {
  expiresAt: string;
  category: "clear" | "cloudy" | "rain" | "snow" | "thunder" | "fog" | "unknown";
  temperatureC: number;
  precipitationMm: number;
  todayHighC?: number;
  previousDayHighC?: number;
}

export interface ProactiveCandidate {
  scene: ProactiveScene;
  score: number;
}

export interface ProactivePlannerState {
  globalDesire: number;
  desireRateMultiplier: number;
  affinity: Record<ProactiveScene, number>;
  lastFiredAt: Partial<Record<ProactiveScene, number>>;
  todayFired: Partial<Record<"morning" | "evening_checkin" | "late_night" | "weather", boolean>>;
  lastDate: string;
  lastSampleAt: number | null;
  lastIdleSeconds: number;
  keyboardAccumMinutes: number;
  continuousActiveMinutes: number;
  pendingFeedback: { scene: ProactiveScene; sentAt: number } | null;
}

const SCENES: ProactiveScene[] = [
  "morning", "topic_followup", "evening_checkin", "late_night", "idle_daze", "work_break", "back_from_away",
  "rainy_day", "cold_drop", "sunny_day",
];
const COOLDOWN_MS: Record<ProactiveScene, number> = {
  morning: 10 * 60 * 60 * 1000,
  topic_followup: 2 * 60 * 60 * 1000,
  evening_checkin: 10 * 60 * 60 * 1000,
  late_night: 2 * 60 * 60 * 1000,
  idle_daze: 60 * 60 * 1000,
  work_break: 2 * 60 * 60 * 1000,
  back_from_away: 30 * 60 * 1000,
  rainy_day: 4 * 60 * 60 * 1000,
  cold_drop: 4 * 60 * 60 * 1000,
  sunny_day: 4 * 60 * 60 * 1000,
};
export const sceneCooldownMs = (scene: ProactiveScene): number => COOLDOWN_MS[scene];
export const DESIRE_THRESHOLD = 40;
export const FOLLOWUP_MIN_SCORE = 55;
const MAX_SAMPLE_MINUTES = 5;

/** 本地版天气场景只在 6:00–22:59 读取天气。 */
export const isWeatherSceneHour = (hour: number): boolean => hour >= 6 && hour <= 22;

function dateKey(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function createPlannerState(at: number): ProactivePlannerState {
  return {
    globalDesire: 0,
    desireRateMultiplier: 1,
    affinity: Object.fromEntries(SCENES.map((scene) => [scene, 1])) as Record<ProactiveScene, number>,
    lastFiredAt: {},
    todayFired: {},
    lastDate: dateKey(at),
    lastSampleAt: at,
    lastIdleSeconds: 0,
    keyboardAccumMinutes: 0,
    continuousActiveMinutes: 0,
    pendingFeedback: null,
  };
}

export function validatePlannerState(value: unknown, at: number): ProactivePlannerState {
  if (value === undefined) return createPlannerState(at);
  if (!value || typeof value !== "object") throw new Error("主动消息规划状态损坏，拒绝覆盖");
  const input = value as Partial<ProactivePlannerState>;
  const finite = (number: unknown, min = 0) => typeof number === "number" && Number.isFinite(number) && number >= min;
  if (!finite(input.globalDesire) || !finite(input.desireRateMultiplier)
    || !finite(input.lastIdleSeconds) || !finite(input.keyboardAccumMinutes) || !finite(input.continuousActiveMinutes)
    || (input.lastSampleAt !== null && !finite(input.lastSampleAt))
    || typeof input.lastDate !== "string" || !input.affinity || !input.lastFiredAt || !input.todayFired
    || (input.pendingFeedback !== null && (!input.pendingFeedback || !SCENES.includes(input.pendingFeedback.scene) || !finite(input.pendingFeedback.sentAt)))) {
    throw new Error("主动消息规划状态损坏，拒绝覆盖");
  }
  const normalized = structuredClone(input as ProactivePlannerState);
  for (const scene of SCENES) {
    normalized.affinity[scene] ??= 1;
    if (!finite(normalized.affinity[scene], 0.3)) throw new Error("主动消息规划状态损坏，拒绝覆盖");
    const firedAt = normalized.lastFiredAt[scene];
    if (firedAt !== undefined && !finite(firedAt)) throw new Error("主动消息规划状态损坏，拒绝覆盖");
  }
  return normalized;
}

function timeWindow(minute: number, start: number, center: number, end: number, max = 15): number {
  if (minute < start || minute > end) return 0;
  if (minute <= center) return max * (minute - start) / Math.max(1, center - start);
  return max * (end - minute) / Math.max(1, end - center);
}

function score(scene: ProactiveScene, state: ProactivePlannerState, presence: UserPresenceSnapshot,
  weather: ProactiveWeatherSnapshot | null | undefined, at: number, lastActivityAt: number): number {
  const last = state.lastFiredAt[scene];
  if (last !== undefined && at - last < COOLDOWN_MS[scene]) return 0;
  if ((scene === "morning" || scene === "evening_checkin" || scene === "late_night") && state.todayFired[scene]) return 0;
  if ((scene === "rainy_day" || scene === "cold_drop" || scene === "sunny_day") && state.todayFired.weather) return 0;
  const date = new Date(at), hour = presence.localHour ?? date.getHours();
  const minute = hour * 60 + (presence.localMinute ?? date.getMinutes());
  let base = 0;
  switch (scene) {
    case "morning":
      if (minute >= 420 && minute <= 630) base = 70 + timeWindow(minute, 420, 510, 630);
      break;
    case "topic_followup": {
      const ago = at - lastActivityAt;
      if (minute >= 690 && minute <= 1380 && presence.idleSeconds < 180 && ago >= 60 * 60 * 1000 && ago <= 24 * 60 * 60 * 1000) {
        base = 35 + timeWindow(minute, 690, 870, 1380, 10);
      }
      break;
    }
    case "evening_checkin":
      if (minute >= 1080 && minute <= 1320) base = 50 + timeWindow(minute, 1080, 1200, 1320);
      break;
    case "late_night":
      if (hour >= 23 || hour < 3) base = 50 + Math.min(state.keyboardAccumMinutes / 60, 1) * 50;
      break;
    case "idle_daze":
      if (minute >= 540 && minute <= 1380 && presence.idleSeconds >= 600) base = 80 + Math.min((presence.idleSeconds - 600) / 1200, 1) * 20;
      break;
    case "work_break":
      if (state.continuousActiveMinutes >= 90) base = 70 + Math.min((state.continuousActiveMinutes - 90) / 30, 1) * 30;
      break;
    case "back_from_away":
      break;
    case "rainy_day":
      if (weather?.category === "rain" || weather?.category === "thunder") {
        base = 70 + Math.min(weather.precipitationMm / 5, 1) * 30;
      }
      break;
    case "cold_drop": {
      const drop = weather?.previousDayHighC !== undefined && weather.todayHighC !== undefined
        ? weather.previousDayHighC - weather.todayHighC : 0;
      if (drop > 5) base = 70 + Math.min((drop - 5) / 10, 1) * 30;
      break;
    }
    case "sunny_day":
      if (weather?.category === "clear" && weather.temperatureC >= 18 && weather.temperatureC <= 26) base = 70;
      break;
  }
  return base * state.affinity[scene];
}

/** 每次周期采样都更新传感状态；只有 allowAttempt=true 时才经过 Desire/概率门挑选场景。 */
export function sampleAndPlan(input: {
  state: ProactivePlannerState;
  presence: UserPresenceSnapshot;
  at: number;
  lastActivityAt: number;
  lastNormalConversationEndedAt?: number | null;
  quietMs: number;
  baseDesireRate?: number;
  weather?: ProactiveWeatherSnapshot | null;
  allowAttempt: boolean;
  random?: () => number;
}): ProactiveCandidate | null {
  const { state, presence, at } = input;
  const localHour = presence.localHour ?? new Date(at).getHours();
  const weather = isWeatherSceneHour(localHour) && input.weather && Date.parse(input.weather.expiresAt) > at
    ? input.weather : null;
  const today = dateKey(at);
  if (today !== state.lastDate) {
    state.lastDate = today;
    state.todayFired = {};
  }
  const rawElapsed = state.lastSampleAt === null ? 0 : Math.max(0, (at - state.lastSampleAt) / 60_000);
  const elapsed = Math.min(MAX_SAMPLE_MINUTES, rawElapsed);
  state.lastSampleAt = at;
  const backFromAway = state.lastIdleSeconds >= 1800 && presence.idleSeconds < 60;
  state.lastIdleSeconds = presence.idleSeconds;
  state.keyboardAccumMinutes = presence.idleSeconds < 60
    ? state.keyboardAccumMinutes + elapsed
    : Math.max(0, state.keyboardAccumMinutes - elapsed);
  state.continuousActiveMinutes = presence.idleSeconds < 180 && rawElapsed <= MAX_SAMPLE_MINUTES
    ? state.continuousActiveMinutes + elapsed
    : 0;

  if (backFromAway) {
    state.globalDesire = 100;
    return input.allowAttempt ? { scene: "back_from_away", score: 100 } : null;
  }
  const inQuietPeriod = input.lastNormalConversationEndedAt !== null
    && input.lastNormalConversationEndedAt !== undefined
    && at - input.lastNormalConversationEndedAt < input.quietMs;
  if (!inQuietPeriod) {
    state.globalDesire = Math.min(100, state.globalDesire + (input.baseDesireRate ?? 2) * elapsed * state.desireRateMultiplier);
  }
  if (!input.allowAttempt) return null;
  const random = input.random ?? Math.random;
  if (state.globalDesire < DESIRE_THRESHOLD || random() * 100 >= state.globalDesire) return null;
  const candidates = SCENES
    .filter((scene) => scene !== "back_from_away")
    .map((scene) => ({ scene, score: score(scene, state, presence, weather, at, input.lastActivityAt) }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score);
  if (candidates.length === 0) {
    state.globalDesire = Math.max(0, state.globalDesire - 10);
    return null;
  }
  const top = candidates[0].score;
  const ties = candidates.filter((candidate) => candidate.score >= top * 0.95);
  return ties[Math.floor(random() * ties.length)];
}

export function markPlannerCommitted(state: ProactivePlannerState, candidate: ProactiveCandidate, at: number): void {
  state.globalDesire = 0;
  state.lastFiredAt[candidate.scene] = at;
  if (candidate.scene === "morning" || candidate.scene === "evening_checkin" || candidate.scene === "late_night") {
    state.todayFired[candidate.scene] = true;
  }
  if (candidate.scene === "rainy_day" || candidate.scene === "cold_drop" || candidate.scene === "sunny_day") {
    state.todayFired.weather = true;
  }
  state.pendingFeedback = { scene: candidate.scene, sentAt: at };
}

/** 用户回复主动会话时结算正反馈；当前模型主动消息不使用固定响应时限。 */
export function settleReplyFeedback(state: ProactivePlannerState): boolean {
  const pending = state.pendingFeedback;
  if (!pending) return false;
  state.affinity[pending.scene] = Math.min(2, state.affinity[pending.scene] * 1.2);
  state.desireRateMultiplier = Math.min(1.5, state.desireRateMultiplier * 1.05);
  state.globalDesire = Math.min(100, state.globalDesire + 20);
  state.pendingFeedback = null;
  return true;
}

/** 下一次已有合格场景、准备再次开口时，才把上一条未回复消息结算为忽略。 */
export function settleIgnoreFeedback(state: ProactivePlannerState): boolean {
  const pending = state.pendingFeedback;
  if (!pending) return false;
  state.affinity[pending.scene] = Math.max(0.3, state.affinity[pending.scene] * 0.85);
  state.desireRateMultiplier = Math.max(0.5, state.desireRateMultiplier * 0.95);
  state.pendingFeedback = null;
  return true;
}
