import { describe, expect, it } from "vitest";
import { normalizeCompanionLifeStatus } from "./chat-page-bridge";

describe("companion life status bridge", () => {
  it("accepts only the bounded read-only display shape", () => {
    expect(normalizeCompanionLifeStatus({ text: "正在读书", resting: false }))
      .toEqual({ text: "正在读书", resting: false });
    expect(normalizeCompanionLifeStatus({ text: "", resting: false })).toBeNull();
    expect(normalizeCompanionLifeStatus({ text: "x".repeat(81), resting: false })).toBeNull();
    expect(normalizeCompanionLifeStatus({ text: "休息中", resting: "yes" })).toBeNull();
    expect(normalizeCompanionLifeStatus(null)).toBeNull();
  });
});
