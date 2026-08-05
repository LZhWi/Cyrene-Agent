// 8 场景 baseScore 瞬间快照公式（0-100 连续值，无累积状态）。
// finalScore = baseScore × affinity
import type { SceneId, OpenerState, UserStateSnapshot, WeatherSnapshot } from "./opener-types";
import { SCENE_CONFIGS } from "./scenes-config";

const MIN = (v: number, max: number) => Math.min(v / max, 1);

export function timeWindowMatchScore(
  minuteOfDay: number,
  startMinute: number,
  centerMinute: number,
  endMinute: number,
  maxScore = 15,
): number {
  if (minuteOfDay < startMinute || minuteOfDay > endMinute) return 0;
  if (minuteOfDay === centerMinute) return maxScore;
  if (minuteOfDay < centerMinute) {
    return maxScore * (minuteOfDay - startMinute) / Math.max(1, centerMinute - startMinute);
  }
  return maxScore * (endMinute - minuteOfDay) / Math.max(1, endMinute - centerMinute);
}

/**
 * 算单个场景的 finalScore = baseScore × affinity。
 * back_from_away 在 tick 内恒返回 0（事件驱动，由 runner 直通车处理）。
 */
export function scoreScene(
  scene: SceneId,
  snap: UserStateSnapshot,
  weather: WeatherSnapshot,
  state: OpenerState,
  now: number,
): number {
  const base = baseScore(scene, snap, weather, state, now);
  if (base <= 0) return 0;
  const aff = state.affinity[scene] ?? 1.0;
  return base * aff;
}

function isCoolingDown(scene: SceneId, state: OpenerState, now: number): boolean {
  const cfg = SCENE_CONFIGS.find(c => c.id === scene);
  if (!cfg) return true;
  const last = state.lastFiredAt[scene];
  if (last !== undefined && last !== null && now - last < cfg.cooldownMs) return true;
  return false;
}

function isTodayFired(scene: SceneId, state: OpenerState): boolean {
  const cfg = SCENE_CONFIGS.find(c => c.id === scene);
  if (!cfg?.todayFiredFlag) return false;
  if (cfg.todayFiredFlag === "daily_checkin") {
    return Boolean(state.todayFired.daily_checkin || state.todayFired.morning || state.todayFired.evening_checkin);
  }
  return Boolean(state.todayFired[cfg.todayFiredFlag]);
}

function baseScore(
  scene: SceneId,
  snap: UserStateSnapshot,
  weather: WeatherSnapshot,
  state: OpenerState,
  now: number,
): number {
  if (isCoolingDown(scene, state, now)) return 0;
  if (isTodayFired(scene, state)) return 0;
  const minuteOfDay = snap.hour * 60 + snap.minute;

  switch (scene) {
    case "morning": {
      if (minuteOfDay < 7 * 60 || minuteOfDay > 10 * 60 + 30) return 0;
      return 70 + timeWindowMatchScore(minuteOfDay, 7 * 60, 8 * 60 + 30, 10 * 60 + 30);
    }
    case "topic_followup": {
      if (minuteOfDay < 11 * 60 + 30 || minuteOfDay > 23 * 60) return 0;
      if (snap.idleSec >= 180) return 0;
      if (snap.lastChatAgoMs < 60 * 60 * 1000 || snap.lastChatAgoMs > 6 * 60 * 60 * 1000) return 0;
      return 35 + timeWindowMatchScore(minuteOfDay, 11 * 60 + 30, 14 * 60 + 30, 23 * 60, 10);
    }
    case "evening_checkin": {
      if (minuteOfDay < 18 * 60 || minuteOfDay > 22 * 60) return 0;
      return 50 + timeWindowMatchScore(minuteOfDay, 18 * 60, 20 * 60, 22 * 60);
    }
    case "late_night":
      if (!(snap.hour >= 23 || snap.hour < 3)) return 0;
      return 50 + MIN(snap.keyboardAccumMin, 60) * 50;
    case "idle_daze":
      if (minuteOfDay < 9 * 60 || minuteOfDay > 23 * 60) return 0;
      if (snap.idleSec < 600) return 0;
      return 80 + MIN(snap.idleSec - 600, 1200) * 20;
    case "work_break":
      if (snap.continuousActiveMin < 90) return 0;
      return 70 + MIN(snap.continuousActiveMin - 90, 30) * 30;
    case "back_from_away":
      return 0;
    case "rainy_day":
      if (!weather.isRaining) return 0;
      return 70 + MIN(weather.precip, 5) * 30;
    case "cold_drop":
      if (weather.tempDropFromYesterday <= 5) return 0;
      return 70 + MIN(weather.tempDropFromYesterday - 5, 10) * 30;
    case "sunny_day":
      if (!weather.isSunny || !weather.tempComfortable) return 0;
      return 70;
  }
}
