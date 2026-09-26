import { describe, expect, it } from "vitest";
import { advanceDynamics, createDynamics, LIFE_REST_ACTIVITY, LIFE_STEP_MS, validateDynamics } from "../plugins/companion-chat/src/life-dynamics";

const at = (day: number, hour: number, minute = 0) => new Date(2026, 8, day, hour, minute).getTime();
const schedule = (time: number) => {
  const hour = new Date(time).getHours();
  return hour < 7 || hour >= 23 ? null : hour < 12 ? "学习" : hour < 18 ? "做园艺" : "读书";
};

describe("生活连续状态的合成时间模拟", () => {
  it("两天一次推进与每分钟轮询、序列化重启的状态完全相同", () => {
    const start = at(1, 4), end = at(3, 4);
    const one = advanceDynamics(createDynamics(start), end, schedule);
    let divided = createDynamics(start);
    for (let time = start; time <= end; time += 60_000) {
      divided = validateDynamics(JSON.parse(JSON.stringify(advanceDynamics(divided, time, schedule).state)), time);
    }
    expect(divided).toEqual(one.state);
    expect(one.segments.some((segment) => segment.activity === LIFE_REST_ACTIVITY)).toBe(true);
    expect(Object.values(one.state.habits).reduce((a, b) => a + b, 0)).toBe(2 * 16 * 60);
  });

  it("低能量进入恢复并保持到恢复阈值，避免每步来回切换", () => {
    const start = at(1, 12);
    const low = { ...createDynamics(start), energy: 24, restNeed: 80 };
    const first = advanceDynamics(low, start, () => "学习").state;
    expect(first).toMatchObject({ activity: LIFE_REST_ACTIVITY, recovering: true, resting: true });
    const stillResting = advanceDynamics(first, start + 6 * LIFE_STEP_MS, () => "学习").state;
    expect(stillResting.activity).toBe(LIFE_REST_ACTIVITY);
    const recovered = advanceDynamics(stillResting, start + 8 * LIFE_STEP_MS, () => "学习").state;
    expect(recovered).toMatchObject({ activity: "学习", recovering: false, resting: false });
    expect(recovered.energy).toBeGreaterThanOrEqual(60);
  });

  it("短时计划变化保留三十分钟活动惯性，夜间立即停止日间活动", () => {
    const start = at(1, 22, 30);
    const first = advanceDynamics(createDynamics(start), start, () => "读书").state;
    const changed = advanceDynamics(first, start + LIFE_STEP_MS, () => "学习").state;
    expect(changed.activity).toBe("读书");
    const night = advanceDynamics(changed, at(1, 23), schedule).state;
    expect(night).toMatchObject({ activity: null, resting: true });
  });

  it("精力尚足但专注耗尽时也会恢复，恢复后继续活动", () => {
    const start = at(1, 12);
    const low = { ...createDynamics(start), focus: 19 };
    expect(advanceDynamics(low, start, () => "学习").state.activity).toBe(LIFE_REST_ACTIVITY);
    const restored = advanceDynamics(low, start + 7 * LIFE_STEP_MS, () => "学习").state;
    expect(restored).toMatchObject({ activity: "学习", recovering: false });
    expect(restored.focus).toBeGreaterThanOrEqual(45);
  });

  it("跨夜恢复数值且所有状态有界，睡眠没有附加用户约束", () => {
    const low = { ...createDynamics(at(1, 23)), energy: 5, focus: 1, restNeed: 95 };
    const morning = advanceDynamics(low, at(2, 7), schedule).state;
    expect(morning).toMatchObject({ energy: 100, focus: 97, restNeed: 0, activity: "学习", resting: false });
    const later = advanceDynamics(morning, at(4, 7), schedule).state;
    for (const value of [later.energy, later.focus, later.restNeed]) expect(value).toBeGreaterThanOrEqual(0);
    expect(validateDynamics(later, at(4, 7))).toEqual(later);
  });

  it("时间倒退不改变状态或习惯；长离线不虚构细节和习惯", () => {
    const original = advanceDynamics(createDynamics(at(1, 7)), at(1, 13), schedule).state;
    expect(advanceDynamics(original, at(1, 8), schedule)).toEqual({ state: original, segments: [], coarse: false });
    const resumed = advanceDynamics(original, at(20, 13), schedule);
    expect(resumed.coarse).toBe(true);
    expect(resumed.segments).toEqual([]);
    expect(resumed.state.habits).toEqual(original.habits);
    expect(resumed.state.energy).toBe(60);
  });

  it.each([NaN, -1, 101])("损坏的连续指标 %s 拒绝加载", (energy) => {
    expect(() => validateDynamics({ ...createDynamics(at(1, 7)), energy }, at(1, 7))).toThrow("损坏");
  });
});
