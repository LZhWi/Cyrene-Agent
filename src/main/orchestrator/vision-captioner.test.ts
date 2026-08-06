// vision-captioner 测试 — 目前覆盖 thinking 模型思考块剥离。
// think 块内联在 content 里的模型（glm-4.1v-thinking-flash 等）不剥会污染观测摘要。

import { describe, it, expect } from "vitest";
import { stripThinkBlocks, stripWrapperTags } from "./vision-captioner";

describe("stripThinkBlocks", () => {
  it("剥掉闭合的 think 块，保留正文", () => {
    const input = "<think>用户现在需要分析截图来判断活动场景。首先看界面……</think>\n类型：工作\n与上次比较：延续\n用户在调试屏幕监控模块。";
    expect(stripThinkBlocks(input)).toBe("类型：工作\n与上次比较：延续\n用户在调试屏幕监控模块。");
  });

  it("剥掉未闭合的结尾 think 块（思考被 max_tokens 截断）", () => {
    expect(stripThinkBlocks("<think>先看看这是什么界面，有 Work 窗口、Code 会话，属于工作相关。因为是首次观"))
      .toBe("");
  });

  it("正文在前 think 在后也能剥", () => {
    expect(stripThinkBlocks("类型：娱乐\n与上次比较：延续\n用户在看视频。\n<think>补充推理</think>"))
      .toBe("类型：娱乐\n与上次比较：延续\n用户在看视频。");
  });

  it("多个 think 块全部剥掉", () => {
    expect(stripThinkBlocks("<think>a</think>正文一<think>b</think>正文二"))
      .toBe("正文一正文二");
  });

  it("无 think 块原样返回（仅 trim）", () => {
    expect(stripThinkBlocks("  类型：学习\n用户在复习微积分。  ")).toBe("类型：学习\n用户在复习微积分。");
  });

  it("只有 think 块时返回空串（由调用方走错误路径）", () => {
    expect(stripThinkBlocks("<think>全是在想</think>")).toBe("");
  });
});

describe("stripWrapperTags", () => {
  it("剥掉首尾的 answer 标签，保留结构化正文", () => {
    expect(stripWrapperTags("<answer>类型：工作\n与上次比较：延续\n用户在查看项目文档。</answer>"))
      .toBe("类型：工作\n与上次比较：延续\n用户在查看项目文档。");
  });

  it("未闭合的 answer 标签也能剥掉", () => {
    expect(stripWrapperTags("<answer>类型：娱乐")).toBe("类型：娱乐");
  });

  it("无标签原样返回（仅 trim）", () => {
    expect(stripWrapperTags("  类型：学习  ")).toBe("类型：学习");
  });
});
