import { describe, expect, it } from "vitest";
import { normalizeAsrHotwords, normalizeLocalAsrProfile } from "./asr-settings";

describe("local ASR settings", () => {
  it("keeps the three supported profiles and defaults to the recommended two-pass profile", () => {
    expect(normalizeLocalAsrProfile("qwen17-stream")).toBe("qwen17-stream");
    expect(normalizeLocalAsrProfile("qwen06-stream")).toBe("qwen06-stream");
    expect(normalizeLocalAsrProfile("unknown")).toBe("paraformer-qwen17");
  });

  it("trims empty hotwords, ignores non-strings, and caps the list", () => {
    const values = [" 昔涟 ", "", 42, ...Array.from({ length: 205 }, (_, index) => `词${index}`)];
    const normalized = normalizeAsrHotwords(values);
    expect(normalized[0]).toBe("昔涟");
    expect(normalized).toHaveLength(200);
    expect(normalized).not.toContain("");
  });
});
