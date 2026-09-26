import { describe, expect, it } from "vitest";
import { advanceDynamics, createDynamics, LIFE_DETAIL_WINDOW_MS, LIFE_REST_ACTIVITY, LIFE_STEP_MS } from "../plugins/companion-chat/src/life-dynamics";

const start = new Date(2026, 8, 1, 7).getTime();
const schedule = (at: number) => {
  const hour = new Date(at).getHours();
  return hour < 7 || hour >= 23 ? null : hour < 12 ? "学习" : hour < 18 ? "做园艺" : "读书";
};

describe("生活连续状态独立模拟复核", () => {
  it("不同初始指标下随机轮询分段与单次推进等价，输入保持不变", () => {
    for (let seed = 0; seed < 100; seed++) {
      let randomState = seed + 1;
      const random = () => ((randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0) / 4294967296);
      const end = start + Math.floor(random() * 72 * 60) * 60_000;
      const initial = { ...createDynamics(start), energy: Math.floor(random() * 101),
        focus: Math.floor(random() * 101), restNeed: Math.floor(random() * 101) };
      const before = structuredClone(initial);
      const single = advanceDynamics(initial, end, schedule).state;
      let divided = initial, at = start;
      while (at < end) {
        at = Math.min(end, at + Math.floor(random() * 55 + 1) * 60_000);
        divided = advanceDynamics(divided, at, schedule).state;
      }
      expect(divided, `随机分段 seed=${seed}`).toEqual(single);
      expect(initial).toEqual(before);
    }
  });

  it("活动惯性在三十分钟边界释放，恢复需要和夜间优先于惯性", () => {
    const initial = advanceDynamics(createDynamics(start), start, () => "读书").state;
    const early = advanceDynamics(initial, start + LIFE_STEP_MS, () => "学习").state;
    expect(early.activity).toBe("读书");
    expect(advanceDynamics(early, start + 2 * LIFE_STEP_MS, () => "学习").state.activity).toBe("学习");
    const exhausted = { ...initial, energy: 25 };
    expect(advanceDynamics(exhausted, start, () => "学习").state.activity).toBe(LIFE_REST_ACTIVITY);
    expect(advanceDynamics(initial, start, () => null).state.activity).toBeNull();
  });

  it("详细窗口恰好七十二小时可推进，超过窗口仅保留旧习惯并重置指标", () => {
    const initial = { ...createDynamics(start), habits: { "读书": 45 } };
    const detailed = advanceDynamics(initial, start + LIFE_DETAIL_WINDOW_MS, schedule);
    expect(detailed.coarse).toBe(false);
    expect(detailed.segments.length).toBeGreaterThan(0);
    const coarse = advanceDynamics(initial, start + LIFE_DETAIL_WINDOW_MS + LIFE_STEP_MS, schedule);
    expect(coarse.coarse).toBe(true);
    expect(coarse.segments).toEqual([]);
    expect(coarse.state).toMatchObject({ energy: 60, focus: 60, restNeed: 30, habits: initial.habits });
    expect(initial.habits).toEqual({ "读书": 45 });
  });
});
