import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  assistantRenderStages,
  resolveReasoningExpanded,
  updateReasoningExpanded,
} from "./message-visibility";

describe("assistantRenderStages", () => {
  it("renders only standalone reasoning before the reply starts", () => {
    expect(assistantRenderStages({
      content: "",
      loading: true,
      responseStarted: false,
    })).toEqual(["reasoning"]);
  });

  it("adds Cyrene's bubble only after visible reply content starts", () => {
    expect(assistantRenderStages({
      content: "正式回答",
      reasoning: "分析过程",
      reasoningStreaming: false,
      responseStarted: true,
    })).toEqual(["reasoning", "assistant"]);
  });

  it("keeps a user's collapsed choice while streaming content rerenders", () => {
    const collapsed = updateReasoningExpanded({}, "assistant-1", false);
    expect(resolveReasoningExpanded(collapsed, "assistant-1")).toBe(false);
    expect(resolveReasoningExpanded(collapsed, "assistant-2")).toBe(false);
    expect(updateReasoningExpanded(collapsed, "assistant-1", false)).toBe(collapsed);
  });

  it("defaults every new reasoning chain to collapsed", () => {
    expect(resolveReasoningExpanded({}, "assistant-new")).toBe(false);
  });

  it("removes hidden streaming Markdown from the DOM after collapse", () => {
    const source = fs.readFileSync(
      fileURLToPath(new URL("./ChatMessageList.tsx", import.meta.url)),
      "utf8",
    );
    expect(source).toMatch(/<Think[\s\S]*?destroyOnHidden[\s\S]*?>/);
    expect(source).not.toContain("destroyOnHidden={false}");
  });
});
