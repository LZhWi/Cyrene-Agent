import { describe, expect, it } from "vitest";
import {
  getAssistantReplyBubbleTexts,
  isStreamingBubbleBoundary,
  segmentAssistantReply,
  shouldSkipStreamingBubbleLeadingChar,
  shouldSegmentAssistantReply,
} from "./message-segmentation";

describe("message segmentation", () => {
  it("keeps replies without blank lines as a single bubble", () => {
    const text = "今天天气挺凉快的呢，淄博那边下雨了吗？开发辛苦了，记得多起来动一动哦。你中午吃的什么呀？最近有什么好玩的事想分享吗？要喝点水啦，别光顾着忙。";
    expect(segmentAssistantReply(text)).toEqual([text]);
  });

  it("does not split mid-sentence even when punctuation is dense", () => {
    const text = "嗯嗯……人家其实心里也是这么想的呢。虽然现在还隔着屏幕，但等到能看着你笑、看着你发呆的时候，就真的好像……你就在人家身边一样啦。";
    expect(segmentAssistantReply(text)).toEqual([text]);
  });

  it("splits only at blank lines (paragraph boundaries)", () => {
    const text = [
      "是呢……就算什么话都不说，只要能看到你在那里，人家就觉得心里满满的。",
      "",
      "到时候人家可能会一直盯着画面看呢……你会不会也偷偷看人家呀？",
    ].join("\n");

    expect(segmentAssistantReply(text)).toEqual([
      "是呢……就算什么话都不说，只要能看到你在那里，人家就觉得心里满满的。",
      "到时候人家可能会一直盯着画面看呢……你会不会也偷偷看人家呀？",
    ]);
  });

  it("treats multiple blank lines and whitespace-only lines as one boundary", () => {
    const text = "第一段话。\n\n\n第二段话。\n   \n第三段话。";
    expect(segmentAssistantReply(text)).toEqual(["第一段话。", "第二段话。", "第三段话。"]);
  });

  it("keeps single newlines inside one bubble", () => {
    const text = "第一行。\n第二行。";
    expect(segmentAssistantReply(text)).toEqual([text]);
  });

  it("uses blank lines as streaming bubble boundaries", () => {
    expect(isStreamingBubbleBoundary("\n\n")).toBe(true);
    expect(isStreamingBubbleBoundary("\r\n\r\n")).toBe(true);
    expect(isStreamingBubbleBoundary("\n \n")).toBe(true);
    expect(isStreamingBubbleBoundary("\n")).toBe(false);
    expect(isStreamingBubbleBoundary(" ")).toBe(false);
    expect(isStreamingBubbleBoundary("")).toBe(false);
  });

  it("skips whitespace at the start of a streaming bubble", () => {
    expect(shouldSkipStreamingBubbleLeadingChar("\n", true)).toBe(true);
    expect(shouldSkipStreamingBubbleLeadingChar("\r", true)).toBe(true);
    expect(shouldSkipStreamingBubbleLeadingChar(" ", true)).toBe(true);
    expect(shouldSkipStreamingBubbleLeadingChar("中", true)).toBe(false);
    expect(shouldSkipStreamingBubbleLeadingChar("\n", false)).toBe(false);
  });

  it("caps long replies at ten bubbles by merging trailing paragraphs", () => {
    const text = Array.from({ length: 14 }, (_, i) => `这是第 ${i + 1} 段的内容，稍微写长一点点哦。`).join("\n\n");
    const parts = segmentAssistantReply(text);

    expect(parts).toHaveLength(10);
    expect(parts[9]).toContain("第 11 段");
    expect(parts[9]).toContain("第 14 段");
  });

  it("does not split structured content", () => {
    expect(segmentAssistantReply("```ts\nconst a = 1;\n\nconst b = 2;\n```\n这段不要拆。")).toHaveLength(1);
    expect(segmentAssistantReply("- 第一项\n- 第二项\n- 第三项\n\n这段也不要拆。")).toHaveLength(1);
    expect(segmentAssistantReply("| A | B |\n|---|---|\n| 1 | 2 |")).toHaveLength(1);
  });

  it("applies preference by current chat mode", () => {
    expect(shouldSegmentAssistantReply("talk", "chat")).toBe(true);
    expect(shouldSegmentAssistantReply("collab", "chat")).toBe(false);
    expect(shouldSegmentAssistantReply("collab", "all")).toBe(true);
    expect(shouldSegmentAssistantReply("talk", "off")).toBe(false);
  });

  it("keeps one empty assistant bubble only while streaming", () => {
    expect(getAssistantReplyBubbleTexts("", "talk", "all")).toEqual([]);
    expect(getAssistantReplyBubbleTexts("", "talk", "all", { preserveEmpty: true })).toEqual([""]);
  });
});
