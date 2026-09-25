import { describe, expect, it } from "vitest";
import {
  getAssistantReplyBubbleTexts,
  segmentAssistantReply,
} from "./message-segmentation";

describe("desktop chat message segmentation", () => {
  it("splits only on blank lines", () => {
    expect(segmentAssistantReply("第一段\n仍是第一段\n\n第二段")).toEqual([
      "第一段\n仍是第一段",
      "第二段",
    ]);
  });

  it("keeps structured markdown in one bubble", () => {
    expect(segmentAssistantReply("- 第一项\n- 第二项\n\n结尾")).toEqual([
      "- 第一项\n- 第二项\n\n结尾",
    ]);
  });

  it("applies the chat preference only to Chat mode", () => {
    expect(getAssistantReplyBubbleTexts("一\n\n二", "chat", "chat")).toEqual(["一", "二"]);
    expect(getAssistantReplyBubbleTexts("一\n\n二", "work", "chat")).toEqual(["一\n\n二"]);
  });
});
