import { describe, expect, it } from "vitest";
import { parseTurnUnderstanding } from "./schema";

const valid = {
  dialogueAct: { type: "select" },
  resolvedReferences: [
    {
      surface: "第一首",
      targetRef: "music-candidate-1",
      relation: "candidate_position",
    },
  ],
  topicTransition: "continue",
  focusedEntityRefs: ["music-candidate-1"],
  contextualizedQuery: "用户选择当前候选中的第一首《胆小鬼》。",
  rewriteStatus: "contextualized",
  uncertainties: [],
};

describe("parseTurnUnderstanding", () => {
  it("accepts the bounded cognition schema", () => {
    expect(parseTurnUnderstanding(valid)).toEqual(valid);
  });

  it.each(["toolName", "toolCall", "execute", "requiredToolArgs", "trackId", "provider"])(
    "rejects execution field %s",
    (field) => {
      expect(() => parseTurnUnderstanding({ ...valid, [field]: "forbidden" })).toThrow(/unknown/i);
    },
  );

  it("rejects unknown nested fields", () => {
    expect(() => parseTurnUnderstanding({
      ...valid,
      dialogueAct: { type: "select", tool: "music_play_track" },
    })).toThrow(/unknown/i);
  });

  it("allows reference existence to be checked by the validation layer", () => {
    const parsed = parseTurnUnderstanding({
      ...valid,
      resolvedReferences: [{ surface: "那个", targetRef: "unknown-ref", relation: "focused" }],
    });
    expect(parsed.resolvedReferences[0].targetRef).toBe("unknown-ref");
  });

  it("rejects oversized arrays and queries", () => {
    expect(() => parseTurnUnderstanding({
      ...valid,
      focusedEntityRefs: Array.from({ length: 17 }, (_, index) => `ref-${index}`),
    })).toThrow(/focusedEntityRefs/i);
    expect(() => parseTurnUnderstanding({
      ...valid,
      contextualizedQuery: "x".repeat(2_001),
    })).toThrow(/contextualizedQuery/i);
  });
});
