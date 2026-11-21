import { describe, expect, it } from "vitest";
import { semanticRisk } from "./memory-semantic-review";

describe("semantic risk review", () => {
  it.each([
    ["用户养了一只猫", "我养猫"],
    ["用户感觉有一定帮助", "感觉有些帮助"],
  ])("does not flag lexical accidents: %s", (summary, quote) => {
    expect(semanticRisk({summary,evidenceQuotes:[quote]})).toBeUndefined();
  });
  it.each([
    ["用户不再喝咖啡", "以后就不喝咖啡了"],
    ["用户一定喜欢咖啡", "不一定喜欢咖啡"],
    ["用户喜欢咖啡", "我不喜欢咖啡"],
    ["用户每天都跑步", "我可能每天都跑步"],
    ["用户只喝茶", "我喝茶"],
    ["眼前景色只是梦境", "眼前景色在梦里面"],
  ])("flags a risk without making a semantic verdict: %s", (summary, quote) => {
    expect(semanticRisk({summary,evidenceQuotes:[quote]})).toBeTruthy();
  });
  it("only supplies a review hint for the bicycle paraphrase, regardless of model reason format", () => {
    const candidate = { summary: "用户的自行车尚未修理，因修车点较远，推车麻烦，所以之前每次想起来都懒得去",
      evidenceQuotes: ["我自行车还没修", "之前每次想起来都懒得去修，因为要推车推好远，不想动"] };
    const hint = semanticRisk(candidate);
    expect(hint).toContain("可能");
    expect(semanticRisk({ ...candidate, reason: "语义复核通过：同义转述。" })).toBe(hint);
  });
  it("does not mark declined or unchanged candidates and preserves explicit overclaim hints", () => {
    expect(semanticRisk({ summary: "永远喝咖啡", shouldWrite: false })).toBeUndefined();
    expect(semanticRisk({ summary: "永远喝咖啡", memoryAction: "keep" })).toBeUndefined();
    expect(semanticRisk({ summary: "喜欢咖啡", forbiddenOverclaims: ["永远"] })).toContain("过度概括");
    expect(semanticRisk({ summary: "不一定喜欢咖啡", evidenceQuotes: ["不一定喜欢咖啡"] })).toBeUndefined();
  });
});
