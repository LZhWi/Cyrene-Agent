import { describe, expect, it } from "vitest";
import { parseVisualHistoryResponse } from "./visual-history-response";

describe("parseVisualHistoryResponse", () => {
  it("finds the final JSON object after reasoning with unrelated braces", () => {
    const answer = '<think>先检查 {主体}，再归纳。</think>\n```json\n'
      + '{"summary":"窗边摆着一只蓝色小花瓶","detail":"蓝色花瓶放在窗边，里面插着白花。"}\n```';
    expect(parseVisualHistoryResponse(answer, false)).toEqual({
      summary: "窗边摆着一只蓝色小花瓶", caption: "蓝色花瓶放在窗边，里面插着白花。",
    });
  });

  it("accepts a short independent summary after a closed think block", () => {
    expect(parseVisualHistoryResponse("<think>观察图片。</think>\n窗边摆着一只蓝色小花瓶", true))
      .toEqual({ summary: "窗边摆着一只蓝色小花瓶" });
  });

  it("never truncates a long caption into a fake summary", () => {
    expect(parseVisualHistoryResponse("窗边摆着一只蓝色小花瓶。".repeat(8), true)).toBeNull();
  });
});
