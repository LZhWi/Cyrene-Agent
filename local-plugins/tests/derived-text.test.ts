import { expect, it } from "vitest";
import { stripAssistantHiddenText } from "../plugins/companion-memory/src/derived-text";

it("只从助手派生文本剥离隐藏块，保留块外正文", () => {
  const original = "前文<think>推理<soul>内部设定</soul>更多推理</think>回答<ANALYSIS>分析</ANALYSIS>完毕";
  expect(stripAssistantHiddenText(original)).toBe("前文回答完毕");
  expect(original).toContain("内部设定");
});

it("未闭合的隐藏块不泄漏尾部内容", () => {
  expect(stripAssistantHiddenText("正文<reasoning>隐藏尾部")).toBe("正文");
});

it("不改变普通正文或孤立的结束标签", () => {
  expect(stripAssistantHiddenText("普通回答 </think> 继续")).toBe("普通回答 </think> 继续");
});
