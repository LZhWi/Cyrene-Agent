import { describe, expect, it } from "vitest";
import { parseVisualHistoryResponse } from "./visual-history-response";

describe("parseVisualHistoryResponse", () => {
  it("ignores reasoning braces before the answer object", () => {
    const answer = '<think>检查 {场景}。</think>\n'
      + '{"summary":"窗边摆着一只蓝色小花瓶","detail":"蓝色花瓶放在窗边，里面插着白花。"}';
    expect(parseVisualHistoryResponse(answer, false)).toEqual({
      summary: "窗边摆着一只蓝色小花瓶", caption: "蓝色花瓶放在窗边，里面插着白花。",
    });
  });

  it("does not truncate a long caption as a summary", () => {
    expect(parseVisualHistoryResponse("窗边摆着一只蓝色小花瓶。".repeat(8), true)).toBeNull();
  });
});
