import { describe, it, expect } from "vitest";
import { parseLrc } from "./lyrics-parser";

describe("parseLrc", () => {
  it("parses timestamps and text, sorting ascending", () => {
    const lrc = [
      "[00:17.82]故事的小黄花",
      "[00:12.00]晴天",
      "[00:15.30]从出生那年就飘着",
    ].join("\n");
    expect(parseLrc(lrc)).toEqual([
      { timeMs: 12_000, text: "晴天" },
      { timeMs: 15_300, text: "从出生那年就飘着" },
      { timeMs: 17_820, text: "故事的小黄花" },
    ]);
  });

  it("expands multiple timestamps per line", () => {
    const out = parseLrc("[00:10.00][01:05.50]副歌");
    expect(out).toEqual([
      { timeMs: 10_000, text: "副歌" },
      { timeMs: 65_500, text: "副歌" },
    ]);
  });

  it("supports mm:ss / mm:ss.c / mm:ss.cc / mm:ss.ccc variants", () => {
    const out = parseLrc(["[01:02]a", "[01:02.5]b", "[01:02.50]c", "[01:02.500]d"].join("\n"));
    expect(out.map((l) => l.timeMs)).toEqual([62_000, 62_500, 62_500, 62_500]);
  });

  it("skips metadata tags and untimestamped lines", () => {
    const out = parseLrc(["[ti:晴天]", "[ar:周杰伦]", "no timestamp here", "[00:01.00]ok"].join("\n"));
    expect(out).toEqual([{ timeMs: 1_000, text: "ok" }]);
  });

  it("applies the offset tag (positive = earlier)", () => {
    const out = parseLrc(["[offset:500]", "[00:10.00]a", "[00:00.20]b"].join("\n"));
    expect(out).toEqual([
      { timeMs: 0, text: "b" }, // 200 - 500 clamped to 0
      { timeMs: 9_500, text: "a" },
    ]);
  });

  it("handles CRLF and stray whitespace", () => {
    const out = parseLrc("[00:05.00]  hello  \r\n\r\n[00:06.00]world\r\n");
    expect(out).toEqual([
      { timeMs: 5_000, text: "hello" },
      { timeMs: 6_000, text: "world" },
    ]);
  });

  it("returns [] for empty / no-timestamp input", () => {
    expect(parseLrc("")).toEqual([]);
    expect(parseLrc("[ti:x]\nplain text only")).toEqual([]);
  });
});
