import { describe, expect, it } from "vitest";
import {
  normalizeDefaultChatMode,
  normalizeSegmentedOutputMode,
} from "../shared/preferences";

describe("preferences", () => {
  it("defaults chat mode to collaboration unless talk is explicitly selected", () => {
    expect(normalizeDefaultChatMode(undefined)).toBe("collab");
    expect(normalizeDefaultChatMode("bad")).toBe("collab");
    expect(normalizeDefaultChatMode("collab")).toBe("collab");
    expect(normalizeDefaultChatMode("talk")).toBe("talk");
  });

  it("normalizes segmented output placeholder mode", () => {
    expect(normalizeSegmentedOutputMode(undefined)).toBe("off");
    expect(normalizeSegmentedOutputMode("bad")).toBe("off");
    expect(normalizeSegmentedOutputMode("all")).toBe("all");
    expect(normalizeSegmentedOutputMode("chat")).toBe("chat");
    expect(normalizeSegmentedOutputMode("off")).toBe("off");
  });
});
