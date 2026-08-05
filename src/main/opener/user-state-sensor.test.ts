import { describe, expect, it } from "vitest";
import { latestUserMessageAt, nextContinuousActiveMinutes } from "./user-state-sensor";

describe("nextContinuousActiveMinutes", () => {
  it("uses elapsed time and tolerates short idle periods", () => {
    expect(nextContinuousActiveMinutes(30, 10, 1.5)).toBe(31.5);
    expect(nextContinuousActiveMinutes(31.5, 120, 2)).toBe(33.5);
  });

  it("resets after three minutes without activity", () => {
    expect(nextContinuousActiveMinutes(89, 180, 1)).toBe(0);
    expect(nextContinuousActiveMinutes(89, 600, 1)).toBe(0);
  });

  it("resets when sampling was paused for too long", () => {
    expect(nextContinuousActiveMinutes(10, 0, 30)).toBe(0);
  });
});

describe("latestUserMessageAt", () => {
  it("uses user replies from proactive conversations but ignores proactive model messages", () => {
    expect(latestUserMessageAt([
      { role: "user", at: 100 },
      { role: "model", at: 300 },
      { role: "user", at: 200 },
    ])).toBe(200);
  });

  it("returns null when a conversation has no user message", () => {
    expect(latestUserMessageAt([{ role: "model", at: 300 }])).toBeNull();
  });
});
