import { describe, expect, it } from "vitest";
import { semanticRisk } from "../plugins/companion-memory/src/memory-semantic-review";

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
});
