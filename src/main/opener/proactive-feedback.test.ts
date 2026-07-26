import { describe, it, expect } from "vitest";
import { defaultState } from "./desire-engine";
import { hasPendingFeedback, settleReplyFeedback, settleIgnoreFeedback } from "./proactive-feedback";
import type { OpenerState } from "./opener-types";

/** 模拟一条已发送未回复的主动消息（markProactiveCommitted 后的状态）。 */
function stateWithPendingProactive(at = 1000): OpenerState {
  const s = defaultState();
  s.unansweredCount = 1;
  s.lastProactiveScene = "late_night";
  s.lastProactiveAt = at;
  return s;
}

describe("hasPendingFeedback", () => {
  it("有未回复未判定的主动消息 → true", () => {
    expect(hasPendingFeedback(stateWithPendingProactive())).toBe(true);
  });
  it("初始状态无主动消息 → false", () => {
    expect(hasPendingFeedback(defaultState())).toBe(false);
  });
  it("已回复（unansweredCount 归零）→ false", () => {
    const s = stateWithPendingProactive();
    s.unansweredCount = 0;
    expect(hasPendingFeedback(s)).toBe(false);
  });
  it("已删除（rollbackLastProactive 置空场景）→ false", () => {
    const s = stateWithPendingProactive();
    s.lastProactiveScene = null;
    s.lastProactiveAt = null;
    expect(hasPendingFeedback(s)).toBe(false);
  });
  it("已判定过 → false", () => {
    const s = stateWithPendingProactive(1000);
    s.lastFeedbackJudgedAt = 1000;
    expect(hasPendingFeedback(s)).toBe(false);
  });
});

describe("settleReplyFeedback", () => {
  it("回复 → affinity 上调 + 标记已判定", () => {
    const s = stateWithPendingProactive();
    expect(settleReplyFeedback(s)).toBe(true);
    expect(s.affinity.late_night).toBeCloseTo(1.2);
    expect(s.desireRateMultiplier).toBeCloseTo(1.05);
    expect(s.lastFeedbackJudgedAt).toBe(1000);
  });
  it("重复上报只记账一次", () => {
    const s = stateWithPendingProactive();
    settleReplyFeedback(s);
    expect(settleReplyFeedback(s)).toBe(false);
    expect(s.affinity.late_night).toBeCloseTo(1.2);
  });
  it("先被判定为忽略后再回复 → 不再计正反馈", () => {
    const s = stateWithPendingProactive();
    settleIgnoreFeedback(s);
    expect(settleReplyFeedback(s)).toBe(false);
    expect(s.affinity.late_night).toBeCloseTo(0.85);
  });
  it("无待判定消息时是 no-op", () => {
    const s = defaultState();
    expect(settleReplyFeedback(s)).toBe(false);
    expect(s.affinity.late_night).toBe(1.0);
  });
});

describe("settleIgnoreFeedback", () => {
  it("忽略 → affinity 下调 + 标记已判定", () => {
    const s = stateWithPendingProactive();
    expect(settleIgnoreFeedback(s)).toBe(true);
    expect(s.affinity.late_night).toBeCloseTo(0.85);
    expect(s.desireRateMultiplier).toBeCloseTo(0.95);
    expect(s.lastFeedbackJudgedAt).toBe(1000);
  });
  it("已回复后（unansweredCount 归零）点忽略是 no-op", () => {
    const s = stateWithPendingProactive();
    s.unansweredCount = 0;
    expect(settleIgnoreFeedback(s)).toBe(false);
  });
  it("兜底重复结算只记账一次", () => {
    const s = stateWithPendingProactive();
    settleIgnoreFeedback(s);
    expect(settleIgnoreFeedback(s)).toBe(false);
    expect(s.affinity.late_night).toBeCloseTo(0.85);
  });
  it("新一条主动消息发出后（lastProactiveAt 更新）可重新判定", () => {
    const s = stateWithPendingProactive(1000);
    settleIgnoreFeedback(s);
    // 第二条主动消息（followup）
    s.unansweredCount = 2;
    s.lastProactiveAt = 2000;
    expect(settleIgnoreFeedback(s)).toBe(true);
    expect(s.affinity.late_night).toBeCloseTo(0.85 * 0.85);
    expect(s.lastFeedbackJudgedAt).toBe(2000);
  });
});
