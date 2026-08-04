import { describe, it, expect } from "vitest";
import { accumulateDesire, probabilityGate, applyClickFeedback, applyIgnoreFeedback, defaultState } from "./desire-engine";

describe("accumulateDesire", () => {
  it("正常累积不超 100", () => {
    let s = defaultState();
    s = accumulateDesire(s, 2);
    expect(s.globalDesire).toBe(2);
    s = accumulateDesire(s, 100);
    expect(s.globalDesire).toBe(100);
  });
  it("multiplier 影响增速", () => {
    let s = defaultState();
    s.desireRateMultiplier = 1.5;
    s = accumulateDesire(s, 2);
    expect(s.globalDesire).toBe(3);
  });
  it("按实际经过分钟数累积，支持不足或超过一分钟的 tick", () => {
    let s = defaultState();
    s = accumulateDesire(s, 2, 0.5);
    expect(s.globalDesire).toBe(1);
    s = accumulateDesire(s, 2, 1.5);
    expect(s.globalDesire).toBe(4);
  });
  it("拒绝负数和非有限时长", () => {
    let s = defaultState();
    s = accumulateDesire(s, 2, -1);
    s = accumulateDesire(s, 2, Number.POSITIVE_INFINITY);
    expect(s.globalDesire).toBe(0);
  });
});

describe("probabilityGate", () => {
  it("Desire < 阈值返回 false", () => {
    const s = defaultState();
    s.globalDesire = 30;
    expect(probabilityGate(s, () => 0.5)).toBe(false);
  });
  it("Desire 高时 random<desire 通过", () => {
    const s = defaultState();
    s.globalDesire = 90;
    expect(probabilityGate(s, () => 0.5)).toBe(true);
  });
  it("Desire 中等时 random>=desire 不通过", () => {
    const s = defaultState();
    s.globalDesire = 50;
    expect(probabilityGate(s, () => 0.9)).toBe(false);
  });
});

describe("applyClickFeedback", () => {
  it("affinity ×1.2 封顶 2.0，multiplier ×1.05，desire +20", () => {
    let s = defaultState();
    s.affinity = { late_night: 1.0 };
    s = applyClickFeedback(s, "late_night");
    expect(s.affinity.late_night).toBe(1.2);
    expect(s.desireRateMultiplier).toBe(1.05);
    expect(s.globalDesire).toBe(20);
  });
  it("affinity 封顶 2.0", () => {
    let s = defaultState();
    s.affinity = { late_night: 1.9 };
    s = applyClickFeedback(s, "late_night");
    expect(s.affinity.late_night).toBe(2.0);
  });
});

describe("applyIgnoreFeedback", () => {
  it("affinity ×0.85 下限 0.3，multiplier ×0.95", () => {
    let s = defaultState();
    s.affinity = { sunny_day: 1.0 };
    s = applyIgnoreFeedback(s, "sunny_day");
    expect(s.affinity.sunny_day).toBeCloseTo(0.85, 5);
    expect(s.desireRateMultiplier).toBeCloseTo(0.95, 5);
  });
  it("affinity 下限 0.3", () => {
    let s = defaultState();
    s.affinity = { sunny_day: 0.35 };
    s = applyIgnoreFeedback(s, "sunny_day");
    expect(s.affinity.sunny_day).toBe(0.3);
  });
});
