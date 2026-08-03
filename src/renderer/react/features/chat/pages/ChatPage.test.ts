import { describe, expect, it } from "vitest";
import { shouldRunModelForMode } from "./conversation-run-policy";

describe("React Code conversation run policy", () => {
  it("runs the model for ordinary Code messages", () => {
    expect(shouldRunModelForMode("code", false, false)).toBe(true);
  });
});
