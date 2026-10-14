import { describe, expect, it } from "vitest";
import { requireSemanticReview, semanticRisk } from "./memory-semantic-review";

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
  it("accepts a supported paraphrase only after a bound follow-up explanation", () => {
    const candidate={summary:"用户不再喝咖啡",evidenceQuotes:["以后就不喝咖啡了"],reason:"值得记录"};
    const requested=new Set<string>();
    expect(()=>requireSemanticReview([candidate],requested,false)).toThrow("需要语义复核");
    expect(()=>requireSemanticReview([candidate],requested,true)).toThrow();
    const reviewed={...candidate,reason:"语义复核通过：原文以后就不喝了明确表达停止行为，不再是等价转述。"};
    expect(()=>requireSemanticReview([reviewed],requested,true)).not.toThrow();
    expect(()=>requireSemanticReview([reviewed],new Set(),true)).toThrow();
    expect(()=>requireSemanticReview([{...reviewed,summary:"用户永远不再喝咖啡"}],requested,true)).toThrow();
    expect(()=>requireSemanticReview([{...reviewed,evidenceQuotes:["只是今天不喝"]}],requested,true)).toThrow();
    expect(()=>requireSemanticReview([{...reviewed,forbiddenOverclaims:["永远"]}],requested,true)).toThrow();
  });
  it("accepts repaired negation and supports declining uncertain candidates", () => {
    const requested=new Set<string>();
    expect(()=>requireSemanticReview([{summary:"一定喜欢咖啡",evidenceQuotes:["不一定喜欢咖啡"]}],requested,false)).toThrow();
    expect(()=>requireSemanticReview([{summary:"不一定喜欢咖啡",evidenceQuotes:["不一定喜欢咖啡"]}],requested,true)).not.toThrow();
    expect(()=>requireSemanticReview([],requested,true)).not.toThrow();
  });
});
