import { describe, expect, it } from "vitest";
import { buildWorkFinalSystemPrompt } from "./work-final-prompt";

describe("buildWorkFinalSystemPrompt", () => {
  it("adds speaking style only to the Work final system prompt", () => {
    expect(buildWorkFinalSystemPrompt("work rules", "speaking style"))
      .toBe("work rules\n\n---\n\nspeaking style");
  });

  it("does not add an empty style section", () => {
    expect(buildWorkFinalSystemPrompt("work rules", "")).toBe("work rules");
  });
});
