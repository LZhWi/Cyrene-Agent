export const LIFE_STEP_MS = 15 * 60 * 1000;
export const LIFE_DETAIL_WINDOW_MS = 72 * 60 * 60 * 1000;
const MIN_ACTIVITY_MS = 30 * 60 * 1000;
export const LIFE_REST_ACTIVITY = "休息片刻";

export interface LifeDynamics {
  version: 1;
  updatedAt: number;
  energy: number;
  focus: number;
  restNeed: number;
  activity: string | null;
  activitySince: number;
  resting: boolean;
  recovering: boolean;
  /** 各活动的模拟累计分钟，不表示用户习惯。 */
  habits: Record<string, number>;
}

export interface ActivitySegment {
  startAt: number;
  endAt: number;
  activity: string | null;
}

const floorStep = (at: number) => Math.floor(at / LIFE_STEP_MS) * LIFE_STEP_MS;
const clamp = (value: number) => Math.max(0, Math.min(100, value));
const isRest = (activity: string | null) => activity === null || /睡|休息/.test(activity);

export function createDynamics(at: number): LifeDynamics {
  return { version: 1, updatedAt: floorStep(at), energy: 75, focus: 70, restNeed: 20,
    activity: null, activitySince: floorStep(at), resting: true, recovering: false, habits: {} };
}

export function validateDynamics(value: unknown, maxAt: number): LifeDynamics {
  const state = value as LifeDynamics | undefined;
  if (!state || state.version !== 1 || !Number.isSafeInteger(state.updatedAt) || state.updatedAt < 0
    || state.updatedAt > maxAt || state.updatedAt % LIFE_STEP_MS !== 0
    || !Number.isSafeInteger(state.activitySince) || state.activitySince < 0 || state.activitySince > state.updatedAt
    || ![state.energy, state.focus, state.restNeed].every((number) => Number.isFinite(number) && number >= 0 && number <= 100)
    || (state.activity !== null && (typeof state.activity !== "string" || !state.activity.trim() || state.activity.length > 200))
    || typeof state.resting !== "boolean" || state.resting !== isRest(state.activity)
    || typeof state.recovering !== "boolean" || !state.habits || typeof state.habits !== "object" || Array.isArray(state.habits)
    || Object.keys(state.habits).length > 100
    || Object.entries(state.habits).some(([key, minutes]) => !key.trim() || key.length > 200
      || !Number.isSafeInteger(minutes) || minutes < 0)) throw new Error("生活连续状态损坏，拒绝覆盖");
  return structuredClone(state);
}

function choose(state: LifeDynamics, at: number, scheduled: string | null): void {
  let desired = scheduled;
  if (scheduled === null) state.recovering = false;
  else {
    if (state.energy <= 25 || state.focus <= 20 || state.restNeed >= 75) state.recovering = true;
    if (state.recovering && state.energy >= 60 && state.focus >= 45 && state.restNeed <= 40) state.recovering = false;
    if (state.recovering) desired = LIFE_REST_ACTIVITY;
    else if (state.activity !== null && at - state.activitySince < MIN_ACTIVITY_MS) desired = state.activity;
  }
  if (state.activity !== desired) { state.activity = desired; state.activitySince = at; }
  state.resting = isRest(desired);
}

export function resetDynamics(input: LifeDynamics, at: number, schedule: (at: number) => string | null): LifeDynamics {
  const reset = { ...createDynamics(at), energy: 60, focus: 60, restNeed: 30, habits: { ...input.habits } };
  choose(reset, reset.updatedAt, schedule(reset.updatedAt));
  return reset;
}

/** 离散时间步保证 UI 轮询频率与重启分段不会改变模拟结果。 */
export function advanceDynamics(input: LifeDynamics, at: number, schedule: (at: number) => string | null): {
  state: LifeDynamics; segments: ActivitySegment[]; coarse: boolean;
} {
  const state = structuredClone(input);
  const end = floorStep(at);
  const segments: ActivitySegment[] = [];
  if (end < state.updatedAt) return { state, segments, coarse: false };
  if (end - state.updatedAt > LIFE_DETAIL_WINDOW_MS) {
    // 长离线缺少细节：恢复到温和基准，不虚构活动或累计习惯。
    return { state: resetDynamics(state, at, schedule), segments, coarse: true };
  }
  while (state.updatedAt < end) {
    const startAt = state.updatedAt;
    choose(state, startAt, schedule(startAt));
    const activity = state.activity;
    const change = activity === null ? [6, 3, -5]
      : isRest(activity) ? [5, 4, -6]
        : /听|哼|发呆|白日梦|期待/.test(activity) ? [-1, 1, 1]
          : /散步|逛街|探店|园艺/.test(activity) ? [-3, -1, 2] : [-2, -1, 2];
    state.energy = clamp(state.energy + change[0]);
    state.focus = clamp(state.focus + change[1]);
    state.restNeed = clamp(state.restNeed + change[2]);
    state.updatedAt += LIFE_STEP_MS;
    if (activity !== null) {
      // 数据键只来自内置活动；defineProperty 也避免特殊键落到对象原型。
      Object.defineProperty(state.habits, activity, { value: (Object.hasOwn(state.habits, activity) ? state.habits[activity] : 0) + 15,
        writable: true, configurable: true, enumerable: true });
    }
    const last = segments.at(-1);
    if (last && last.activity === activity && last.endAt === startAt) last.endAt = state.updatedAt;
    else segments.push({ startAt, endAt: state.updatedAt, activity });
  }
  choose(state, end, schedule(end));
  return { state, segments, coarse: false };
}
