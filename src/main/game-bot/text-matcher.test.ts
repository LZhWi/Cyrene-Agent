import { describe, expect, it } from "vitest";
import { fuzzyContains, matchWords, normalizeText } from "./text-matcher";

describe("text matcher", () => {
  it("忽略空格和标点", () => {
    expect(normalizeText("银 · 金 · 彩！")).toBe("银金彩");
  });

  it("允许单字 OCR 误差", () => {
    expect(fuzzyContains("获得：彩虹时伐", "彩虹时代", 75)).toBe(true);
  });

  it("返回命中和缺失词", () => {
    expect(matchWords(["忍无可忍", "能量逃逸"], "忍无可忍", 85)).toEqual({
      hits: ["忍无可忍"],
      missing: ["能量逃逸"],
    });
  });
});
